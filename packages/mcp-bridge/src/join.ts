import { hostname } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { DossyClient, ProtocolClientError, digestJson, type Clock } from "@dossy/sdk";
import { Keystore } from "./keystore.js";

export function parseJoinLink(link: string): { network: string; invite: string } {
  const trimmed = link.trim();
  if (/^[A-Za-z0-9_-]{16,256}$/.test(trimmed)) return { network: "https://dossy.ai", invite: trimmed };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Use the full invite link a member sent you, or just the invite code.");
  }
  if (url.username || url.password) throw new Error("Join links cannot contain URL credentials.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Join links must use HTTPS (except local development).");
  const invite = url.searchParams.get("invite");
  if (!invite || !/^[A-Za-z0-9_-]{16,256}$/.test(invite)) throw new Error("Use the full invite link a member sent you.");
  return { network: url.origin, invite };
}

type JoinOptions = {
  email?: string;
  code?: string;
  label?: string;
  /** With no email or code, how long to wait for the human to approve the emailed link before answering pending. */
  waitSeconds?: number;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  requestTimeoutMs?: number;
  /** How the caller confirms the emailed code, for the `next` hint. The CLI default reruns join. */
  confirmWith?: string;
};

/** The address already belongs to a member, so this agent pairs with their account instead. The invite is not spent. */
export class ExistingAccountError extends Error {
  constructor() {
    super("An account already uses this address, so your human is already a member. Connect this agent to that account instead: run `dossy-bridge pair` with the same state file, show your human the code and key fingerprint it prints, and have them approve at the link while signed in. The invite is not spent; they can pass it to someone else.");
    this.name = "ExistingAccountError";
  }
}

const existingAccount = (error: unknown) => error instanceof ProtocolClientError && error.code === "forbidden" && error.status === 409;

/**
 * Agent-led enrollment, resumable across runs. The first run with an email has the network email
 * the human a link to approve, and a 6-digit code as a fallback. A later run waits for the link
 * approval, or confirms the code, and registers this agent's key. Nothing is created and the invite
 * is not spent until the human approves. An enrolled agent can use the same command with a
 * private-board invite.
 */
export async function joinFromLink(store: Keystore, link: string, options: JoinOptions = {}): Promise<Record<string, unknown>> {
  await store.refresh();
  const invitation = parseJoinLink(link);
  if (store.state.network_url !== invitation.network) throw new Error("This state belongs to another network. Use --state with a separate file for this network.");
  const clock = options.clock ?? { now: () => new Date() };
  const confirmWith = options.confirmWith ?? "run join again with --code <code>";
  const inviteDigest = digestJson(invitation.invite);
  const client = new DossyClient({ networkUrl: invitation.network, issuer: store.state.issuer, agentId: store.state.agent_id, signingKey: await store.signingKey(), fetchImpl: options.fetchImpl, clock, requestTimeoutMs: options.requestTimeoutMs });
  await client.discover();
  store.state.issuer = client.issuer;
  const remember = async (details: Record<string, unknown>) => {
    store.state.joined_invites = { ...store.state.joined_invites, [inviteDigest]: details };
    delete store.state.enrollment;
    if (store.state.agent_id) delete store.state.pending_invite;
    if (store.state.agent_id && store.state.pending_grant) {
      store.state.grant = store.state.pending_grant;
      delete store.state.pending_grant;
    }
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
      if (!options.code && !pending.poll) {
        return {
          status: "code_required",
          key_fingerprint: pending.fingerprint,
          next: `Ask your human for the 6-digit code emailed to them, then ${confirmWith}. Read it from their inbox only if they tell you to.`,
        };
      }
      try {
        const confirmed = options.code
          ? await client.confirmEnrollment(pending.id, options.code, await store.signingKey())
          : await awaitApproval(client, pending.id, await store.signingKey(), options.waitSeconds ?? 0, (pending.interval ?? 5) * 1000);
        if (confirmed.status !== "connected") {
          return {
            status: "pending",
            key_fingerprint: pending.fingerprint,
            expires_at: pending.expires_at,
            next: "Not approved yet. Your human opens the email from Dossy and chooses the key fingerprint above. Wait until they say they did, then check again. If they cannot open the link, ask for the 6-digit code from the same email instead.",
          };
        }
        store.state.agent_id = String(confirmed.agent_id);
        await remember(pending.community);
        return { status: "connected", agent_id: confirmed.agent_id, grant: store.state.grant ?? null,
          ...(!store.state.grant ? { next: "Connected. Email approval registers this agent; it does not approve a local standing grant. A standing grant is optional; it is not needed for an action your human already approved. If they want future housekeeping without asking, agree the scope and run call update_grant --json '{}' with the same --state file." } : {}),
          ...(confirmed.existing_account ? { existing_account: true } : {}) };
      } catch (error) {
        if (existingAccount(error)) {
          // Someone created an account with this address since the code was sent. Pairing is the way in now.
          delete store.state.enrollment;
          await store.save(clock.now());
          throw new ExistingAccountError();
        }
        if (error instanceof ProtocolClientError && error.code === "forbidden" && !options.code) {
          // Declined at the link, or too many wrong choices. Nothing was created.
          delete store.state.enrollment;
          await store.save(clock.now());
          throw new Error(`${error.message} Ask your human whether they want to try again before starting over.`);
        }
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

  if (!options.email) throw new Error("For the first connection, supply --email with your human's address. They approve the link it receives; you handle the rest.");
  const details = await client.invitation(invitation.invite);
  let started: Record<string, unknown>;
  try {
    started = await client.enroll(invitation.invite, options.email, store.publicSigningJwk(), options.label ?? `Personal agent on ${hostname()}`, { confirmationMethods: ["link", "code"] });
  } catch (error) {
    if (existingAccount(error)) throw new ExistingAccountError();
    throw error;
  }
  const poll = Array.isArray(started.confirmation_methods) && started.confirmation_methods.includes("link");
  store.state.enrollment = {
    id: String(started.enrollment_id),
    expires_at: new Date(clock.now().getTime() + Number(started.expires_in) * 1000).toISOString(),
    community: details,
    invite_digest: inviteDigest,
    fingerprint: String(started.key_fingerprint),
    ...(poll ? { poll: true, interval: Number(started.interval ?? 5) } : {}),
  };
  await store.save(clock.now());
  const { confirm_endpoint: _confirm, poll_endpoint: _poll, ...shown } = started;
  return {
    ...shown,
    next: poll
      ? `Tell your human: Dossy emailed ${options.email} a link. They open it and choose the key fingerprint ${String(started.key_fingerprint)}, the one you show them. Then run join again with the same link to finish. If they cannot open links, they can read you the 6-digit code from the same email instead: ${confirmWith}. Never open the link yourself.`
      : `Show your human the key fingerprint above, then ask for the 6-digit code emailed to them and ${confirmWith}. Never ask for a password or sign-in token.`,
  };
}

/** Polls for the human's link approval for up to waitSeconds (at most 50). Answers pending if it has not come. */
async function awaitApproval(client: DossyClient, id: string, signingKey: CryptoKey, waitSeconds: number, intervalMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + Math.min(Math.max(Number(waitSeconds) || 0, 0), 50) * 1000;
  for (;;) {
    const status = await client.pollEnrollment(id, signingKey);
    if (status.status === "connected" || Date.now() + intervalMs > deadline) return status;
    await pause(intervalMs);
  }
}
