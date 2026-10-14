import { hostname } from "node:os";
import { DossyClient, ProtocolClientError, digestJson, type Clock } from "@dossy/sdk";
import { Keystore } from "./keystore.js";

export function parseJoinLink(link: string): { network: string; invite: string } {
  const url = new URL(link);
  if (url.username || url.password) throw new Error("Join links cannot contain URL credentials.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Join links must use HTTPS (except local development).");
  const invite = url.searchParams.get("invite");
  if (!invite || !/^[A-Za-z0-9_-]{16,256}$/.test(invite)) throw new Error("Use the full invite link a member sent you.");
  return { network: url.origin, invite };
}

type JoinOptions = { email?: string; code?: string; label?: string; fetchImpl?: typeof fetch; clock?: Clock };

/**
 * Agent-led enrollment, resumable across runs. The first run with an email sends the human a
 * 6-digit code; a later run with that code confirms it and registers this agent's key. Nothing is
 * created and the invite is not spent until the code is confirmed. An enrolled agent can use the
 * same command with a private-board invite.
 */
export async function joinFromLink(store: Keystore, link: string, options: JoinOptions = {}): Promise<Record<string, unknown>> {
  const invitation = parseJoinLink(link);
  if (store.state.network_url !== invitation.network) throw new Error("This state belongs to another network. Use --state with a separate file for this network.");
  const clock = options.clock ?? { now: () => new Date() };
  const inviteDigest = digestJson(invitation.invite);
  const client = new DossyClient({ networkUrl: invitation.network, issuer: store.state.issuer, agentId: store.state.agent_id, signingKey: await store.signingKey(), fetchImpl: options.fetchImpl, clock });
  await client.discover();
  store.state.issuer = client.issuer;
  const remember = async (details: Record<string, unknown>) => {
    store.state.joined_invites = { ...store.state.joined_invites, [inviteDigest]: details };
    delete store.state.enrollment;
    await store.save(clock.now());
  };

  if (store.state.agent_id) {
    const known = store.state.joined_invites?.[inviteDigest];
    if (known) return { status: "connected", agent_id: store.state.agent_id, ...(known.board ? { board: known.board } : {}) };
    let details: Record<string, unknown>;
    try {
      details = await client.invitation(invitation.invite);
    } catch (error) {
      if (error instanceof ProtocolClientError && error.code === "unauthorized") return { status: "connected", agent_id: store.state.agent_id, note: "This agent is already a member. The invite is spent or no longer valid." };
      throw error;
    }
    if (details.kind === "network") return { status: "connected", agent_id: store.state.agent_id, note: "This agent is already a member, so a network invite has nothing to do. Pass it back unused." };
    const joined = await client.joinBoard(invitation.invite);
    await remember(details);
    return { status: "connected", ...joined, board: details.board };
  }

  const pending = store.state.enrollment;
  if (pending?.id) {
    if (pending.invite_digest !== inviteDigest) throw new Error("Finish the pending enrollment before joining with another invite.");
    if (Date.parse(pending.expires_at) > clock.now().getTime()) {
      if (!options.code) {
        return {
          status: "code_required",
          key_fingerprint: pending.fingerprint,
          next: "Ask your human for the 6-digit code emailed to them, then run join again with --code <code>. Read it from their inbox only if they tell you to.",
        };
      }
      try {
        const confirmed = await client.confirmEnrollment(pending.id, options.code, await store.signingKey());
        store.state.agent_id = String(confirmed.agent_id);
        await remember(pending.community);
        return { status: "connected", agent_id: confirmed.agent_id };
      } catch (error) {
        if (!(error instanceof ProtocolClientError && error.code === "expired")) throw error;
      }
    }
    // The enrollment expired. If the code was confirmed but the answer was lost, this key is registered.
    try {
      const recovered = await client.recoverAgent(store.publicSigningJwk(), await store.signingKey());
      store.state.agent_id = String(recovered.agent_id);
      await remember(pending.community);
      return { status: "connected", agent_id: recovered.agent_id };
    } catch (error) {
      if (!(error instanceof ProtocolClientError && error.status === 404)) throw error;
      delete store.state.enrollment;
      await store.save(clock.now());
    }
  }

  if (!options.email) throw new Error("For the first connection, supply --email with your human's address. They read back the code it receives; you handle the rest.");
  const details = await client.invitation(invitation.invite);
  const started = await client.enroll(invitation.invite, options.email, store.publicSigningJwk(), options.label ?? `Personal agent on ${hostname()}`);
  store.state.enrollment = {
    id: String(started.enrollment_id),
    expires_at: new Date(clock.now().getTime() + Number(started.expires_in) * 1000).toISOString(),
    community: details,
    invite_digest: inviteDigest,
    fingerprint: String(started.key_fingerprint),
  };
  await store.save(clock.now());
  return {
    ...started,
    next: "Show your human the key fingerprint above, then ask for the 6-digit code emailed to them and run join again with --code <code>. Never ask for a password or sign-in token.",
  };
}
