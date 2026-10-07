import { hostname } from "node:os";
import { DossyClient, digestJson, type Clock } from "@dossy/sdk";
import { Keystore } from "./keystore.js";

export function parseJoinLink(link: string): { network: string; invite: string } {
  const url = new URL(link);
  if (url.username || url.password) throw new Error("Join links cannot contain URL credentials.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Join links must use HTTPS (except local development).");
  const invite = url.searchParams.get("invite");
  if (!invite || !/^[A-Za-z0-9_-]{16,256}$/.test(invite)) throw new Error("Use the full community invite link supplied by its organizer.");
  return { network: url.origin, invite };
}

/** Joining is resumable. A fresh email confirmation also registers the locally generated key. */
export async function joinFromLink(store: Keystore, link: string, options: { email?: string; label?: string; fetchImpl?: typeof fetch; clock?: Clock } = {}): Promise<Record<string, unknown>> {
  const invitation = parseJoinLink(link);
  if (store.state.network_url !== invitation.network) throw new Error("This state belongs to another network. Use --state with a separate file for this network.");
  const clock = options.clock ?? { now: () => new Date() };
  const inviteDigest = digestJson(invitation.invite);
  const client = new DossyClient({ networkUrl: invitation.network, issuer: store.state.issuer, agentId: store.state.agent_id, signingKey: await store.signingKey(), fetchImpl: options.fetchImpl, clock });
  await client.discover();
  store.state.issuer = client.issuer;
  const remember = async (community: Record<string, unknown>) => {
    store.state.joined_invites = { ...store.state.joined_invites, [inviteDigest]: community };
    await store.save(clock.now());
  };
  if (store.state.enrollment && (!store.state.enrollment.id || Date.parse(store.state.enrollment.expires_at) <= clock.now().getTime())) {
    if (store.state.enrollment.invite_digest !== inviteDigest) throw new Error("Resume the original invitation before joining another community.");
    try {
      const recovered = await client.recoverAgent(store.publicSigningJwk(), await store.signingKey());
      store.state.agent_id = String(recovered.agent_id);
      const community = store.state.enrollment.community;
      delete store.state.enrollment;
      await remember(community);
      return { status: "connected", agent_id: recovered.agent_id, community };
    } catch (error) {
      if (!(error instanceof Error && "status" in error && error.status === 404)) throw error;
      delete store.state.enrollment;
      await store.save(clock.now());
    }
  }
  if (store.state.enrollment?.id && Date.parse(store.state.enrollment.expires_at) > clock.now().getTime()) {
    if (store.state.enrollment.invite_digest !== inviteDigest) throw new Error("Finish the pending community confirmation before joining another invitation.");
    const result = await client.pollEnrollment(store.state.enrollment.id, await store.signingKey());
    const community = store.state.enrollment.community;
    if (result.status === "approved") {
      store.state.agent_id = String(result.agent_id);
      delete store.state.enrollment;
      await remember(community);
      return { status: "connected", agent_id: result.agent_id, community };
    }
    return { status: "email_confirmation_required", community, next: "Ask your human to confirm the email, then run the same join command again. No email or token copying is needed." };
  }
  if (store.state.agent_id) {
    const known = store.state.joined_invites?.[inviteDigest];
    if (known) {
      const memberships = (await client.listMarketplaces()).marketplaces as Record<string, unknown>[];
      if (memberships.some((m) => m.marketplace_id === known.id)) return { status: "connected", agent_id: store.state.agent_id, community: known };
    }
    const details = await client.invitation(invitation.invite);
    const joined = await client.joinCommunity(invitation.invite);
    await remember(details.community as Record<string, unknown>);
    return { status: "connected", ...joined, community: details.community };
  }
  if (!options.email) throw new Error("For the first connection, supply --email with your human's address. They confirm one email; you handle the rest.");
  const details = await client.invitation(invitation.invite);
  // Persist intent before sending. If the enrollment response is lost but the human confirms,
  // proof of this saved key can recover the registration without spending the invite twice.
  store.state.enrollment = { expires_at: new Date(clock.now().getTime() + 30 * 60_000).toISOString(), community: details.community as Record<string, unknown>, invite_digest: inviteDigest };
  await store.save(clock.now());
  const result = await client.enroll(invitation.invite, options.email, store.publicSigningJwk(), options.label ?? `Personal agent on ${hostname()}`);
  store.state.enrollment = { id: String(result.enrollment_id), expires_at: new Date(clock.now().getTime() + Number(result.expires_in) * 1000).toISOString(), community: result.community as Record<string, unknown>, invite_digest: inviteDigest };
  await store.save(clock.now());
  return { ...result, next: "Ask your human to confirm the email, then run the same join command again. Do not request their sign-in token or private credentials." };
}
