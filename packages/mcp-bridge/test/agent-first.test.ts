// The agent-first bridge against a real network: guest onboarding from an invite in the setup,
// the standing grant, follows, watches, local search, and the notifier. Skipped without a target.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadTarget, type ConformanceTarget } from "@dossy/conformance";
import { randomId } from "@dossy/sdk";
import { Bridge, joinFromLink, Keystore, parseJoinLink, RECOMMENDED_ACTIONS, type ApprovalRequest, type Approver, type MatchSummary } from "../src/index.js";

const target = await loadTarget();
const suite = target?.latestCode ? describe : describe.skip;
afterAll(async () => target?.close());

class ScriptedHuman implements Approver {
  shown: ApprovalRequest[] = [];
  decide: (approval: ApprovalRequest) => boolean = () => true;
  /** The answer to an approval's choice. Undefined keeps the preselected one. */
  choose?: string;
  async request(approval: ApprovalRequest) {
    this.shown.push(approval);
    const approved = this.decide(approval);
    return { approved, channel: "test", ...(approved && approval.choice ? { choice: this.choose ?? approval.choice.default } : {}) };
  }
}

const tag = () => randomId(5).toLowerCase().replace(/[^a-z0-9]/g, "");
const LOCAL = "http://127.0.0.1";
const local = (url: unknown) => String(url).replace(/^https?:\/\/[^/]+/, LOCAL);

async function guestBridge(network: ConformanceTarget, inviteUrl: string, notified: MatchSummary[] = [], wrap = (fetchImpl: typeof fetch) => fetchImpl) {
  const dir = await mkdtemp(join(tmpdir(), "dossy-guest-"));
  // Invite links must be HTTPS or local; the test network answers on any host through fetchImpl.
  const store = await Keystore.create(join(dir, "bridge.json"), LOCAL);
  store.state.pending_invite = inviteUrl;
  await store.save(network.clock.now());
  const human = new ScriptedHuman();
  const sponsor = await network.enroll(`sponsor-${tag()}`);
  const bridge = await Bridge.start(store, human, { fetchImpl: wrap(sponsor.client.fetchImpl!), clock: network.clock, notify: async (_grant, summary) => { notified.push(summary); } });
  return { bridge, human, store };
}

/**
 * A member bridge reached through the whole guest flow, the way a new member's agent joins. Its
 * human chose `choice` for the standing grant while joining; nothing shown so far is kept.
 */
async function joinedBridge(network: ConformanceTarget, notified: MatchSummary[] = [], choice = "recommended") {
  const inviter = await network.enroll(`inviter-${tag()}`);
  const invite = await inviter.client.createInvite({ kind: "network", label: "A friend" });
  const guest = await guestBridge(network, local(invite.invite_url), notified);
  const email = `joined-${tag()}@example.test`;
  guest.human.choose = choice;
  await guest.bridge.enroll(email, "Test agent");
  await guest.bridge.confirmEnrollment(String(await network.latestCode!(email)));
  guest.human.shown = [];
  return guest;
}

/** Sends enrollments the way a client that predates link approval does, so the network answers as it used to. */
function codeOnly(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (String(input).endsWith("/v0.2/enrollments") && typeof init?.body === "string") {
      const { confirmation_methods: _methods, ...body } = JSON.parse(init.body) as Record<string, unknown>;
      return fetchImpl(input, { ...init, body: JSON.stringify(body) });
    }
    return fetchImpl(input, init);
  };
}

suite("agent-first bridge", () => {
  it("CLI enrollment leaves the grant null and CLI completion preserves an MCP-approved grant", async () => {
    for (const viaMcp of [false, true]) {
      const inviter = await target!.enroll(`cli-grant-inviter-${tag()}`);
      const invite = await inviter.client.createInvite({ kind: "network" });
      const link = local(invite.invite_url);
      const { bridge, store } = await guestBridge(target!, link);
      const email = `cli-grant-${tag()}@example.test`;
      const options = { fetchImpl: bridge.client.fetchImpl, clock: target!.clock };
      if (viaMcp) await bridge.enroll(email);
      else await joinFromLink(store, link, { ...options, email });
      const result = await joinFromLink(await Keystore.open(store.path), link, { ...options, code: String(await target!.latestCode!(email)) });
      expect(result.status).toBe("connected");
      const status = await bridge.networkStatus();
      if (viaMcp) expect(status.grant).toMatchObject({ standing_actions: RECOMMENDED_ACTIONS });
      else {
        expect(status.grant).toBeNull();
        expect(String(result.next)).toContain("call update_grant");
      }
      expect((await Keystore.open(store.path)).state.pending_grant).toBeUndefined();
    }
  });

  it("onboards from an invite in the setup: invitation, catalog, code, and membership", async () => {
    const inviter = await target!.enroll("guest-inviter");
    const invite = await inviter.client.createInvite({ kind: "network", label: "Ana" });
    const { bridge, store } = await guestBridge(target!, local(invite.invite_url));
    expect(bridge.mode).toBe("guest");
    const read = await bridge.readInvitation();
    expect(read).toMatchObject({ kind: "network", inviter_label: "Ana", key_fingerprint: expect.stringMatching(/^[0-9A-F]{4}( [0-9A-F]{4}){3}$/) });
    await expect(bridge.catalog()).resolves.toMatchObject({ boards: expect.any(Array) });
    await expect(bridge.publishRequest({ board_id: "x", class: "general", tags: [], criteria: {}, terms: { ask: "?" } })).rejects.toThrow(/enrollment/);
    const email = `guest-${tag()}@example.test`;
    const sent = await bridge.enroll(email, "Claude Code");
    expect(sent).toMatchObject({ status: "code_sent", key_fingerprint: read.key_fingerprint, next: expect.stringContaining("call confirm_enrollment") });
    expect(String(sent.next)).not.toContain("--code");
    // Enrolling again while the email is pending sends nothing new and points at the same tools.
    const again = await bridge.enroll(email);
    expect(again).toMatchObject({ status: "pending", next: expect.stringContaining("check_enrollment") });
    expect(String(again.next)).toContain("call confirm_enrollment");
    const code = String(await target!.latestCode!(email));
    const joined = await bridge.confirmEnrollment(code);
    expect(joined).toMatchObject({ status: "connected", next: expect.stringContaining("update_grant") });
    expect(bridge.mode).toBe("member");
    expect(store.state.pending_invite).toBeUndefined();
    await expect(bridge.standing()).resolves.toMatchObject({ invites_remaining: 5 });
  });

  it("joins with one approval prompt and the emailed link, and applies the grant approved with it", async () => {
    const inviter = await target!.enroll("link-inviter");
    const invite = await inviter.client.createInvite({ kind: "network", label: "Ana" });
    const { bridge, human, store } = await guestBridge(target!, local(invite.invite_url));
    const read = await bridge.readInvitation();
    const email = `link-${tag()}@example.test`;
    const started = await bridge.enroll(email, "Claude Code");
    expect(started).toMatchObject({ status: "code_sent", key_fingerprint: read.key_fingerprint, next: expect.stringContaining("check_enrollment") });
    expect(started.confirm_endpoint).toBeUndefined();
    // The one prompt before anything is sent: joining under this key, with the grant preselected.
    expect(human.shown).toHaveLength(1);
    expect(human.shown[0]).toMatchObject({
      action: "join_network",
      disclosure: { contact_email: email, key_fingerprint: read.key_fingerprint },
      choice: { default: "recommended", options: [expect.objectContaining({ value: "recommended" }), expect.objectContaining({ value: "ask" })] },
    });
    expect(await bridge.checkEnrollment(0)).toMatchObject({ status: "pending", next: expect.stringContaining("check_enrollment") });
    await expect(bridge.networkStatus()).resolves.toMatchObject({ enrollment: { pending: true, approve_by: "link_or_code" }, pending_grant: { standing_actions: RECOMMENDED_ACTIONS } });
    await target!.approveEnrollmentLink!(email, String(read.key_fingerprint));
    const joined = await bridge.checkEnrollment(0);
    expect(joined).toMatchObject({ status: "connected", grant: { standing_actions: RECOMMENDED_ACTIONS, notify: { kind: "none" } } });
    expect(String(joined.next)).toContain("in effect");
    expect(bridge.mode).toBe("member");
    expect(store.state).toMatchObject({ grant: { standing_actions: RECOMMENDED_ACTIONS } });
    expect(store.state.pending_grant).toBeUndefined();
    expect(store.state.enrollment).toBeUndefined();
    // Housekeeping is covered without another prompt; anything else still asks.
    await expect(bridge.createBoard({ board_id: `link.${tag()}`, description: "Covered." })).resolves.toMatchObject({ under_standing_grant: true });
    expect(human.shown).toHaveLength(1);
  });

  it("sends nothing when the human declines the joining prompt, and asks for everything when they choose to be asked", async () => {
    const inviter = await target!.enroll("decline-inviter");
    const invite = await inviter.client.createInvite({ kind: "network" });
    const { bridge, human, store } = await guestBridge(target!, local(invite.invite_url));
    const email = `decline-${tag()}@example.test`;
    human.decide = () => false;
    await expect(bridge.enroll(email)).resolves.toMatchObject({ status: "declined" });
    expect(await target!.latestCode!(email)).toBeUndefined();
    expect(store.state.enrollment).toBeUndefined();
    human.decide = () => true;
    human.choose = "ask";
    await bridge.enroll(email);
    await bridge.confirmEnrollment(String(await target!.latestCode!(email)));
    expect(store.state.grant).toMatchObject({ standing_actions: [] });
    await bridge.createBoard({ board_id: `asked.${tag()}`, description: "Asked." });
    expect(human.shown.map((item) => item.action)).toEqual(["join_network", "join_network", "create_board"]);
  });

  it("connects an address that already has an account through the same email, and leaves the invite unspent", async () => {
    const inviter = await target!.enroll("existing-inviter");
    const invite = await inviter.client.createInvite({ kind: "network" });
    const email = `existing-${tag()}@example.test`;
    const racing = await guestBridge(target!, local(invite.invite_url));
    await racing.bridge.enroll(email);
    const racingCode = String(await target!.latestCode!(email));
    // The same human joins through another invite before reading the first code back.
    const other = await inviter.client.createInvite({ kind: "network" });
    const first = await guestBridge(target!, local(other.invite_url));
    await first.bridge.enroll(email);
    await first.bridge.confirmEnrollment(String(await target!.latestCode!(email)));
    // A code cannot connect an existing account.
    await expect(racing.bridge.confirmEnrollment(racingCode)).rejects.toThrow(/start_pairing/);
    expect(racing.store.state.enrollment).toBeUndefined();

    const late = await guestBridge(target!, local(invite.invite_url));
    const read = await late.bridge.readInvitation();
    await expect(late.bridge.enroll(email)).resolves.toMatchObject({ status: "code_sent", next: expect.stringContaining("check_enrollment") });
    expect(await target!.latestCode!(email)).toBeUndefined();
    await target!.approveEnrollmentLink!(email, String(read.key_fingerprint));
    const joined = await late.bridge.checkEnrollment(0);
    expect(joined).toMatchObject({ status: "connected", existing_account: true });
    expect(String(joined.next)).toContain("pass it to someone else");
    // The account's private boards were adopted (it has none here; pairing covers one that does).
    expect(late.store.state.followed).toEqual([]);
    await expect(inviter.client.invitation(parseJoinLink(local(invite.invite_url)).invite)).resolves.toMatchObject({ kind: "network" });
  });

  it("pairs by itself when a network refuses an address that already has an account", async () => {
    const inviter = await target!.enroll("refusing-inviter");
    const invite = await inviter.client.createInvite({ kind: "network" });
    const member = `refused-${tag()}@example.test`;
    const joined = await guestBridge(target!, local(invite.invite_url));
    await joined.bridge.enroll(member);
    await joined.bridge.confirmEnrollment(String(await target!.latestCode!(member)));

    const other = await inviter.client.createInvite({ kind: "network" });
    const guest = await guestBridge(target!, local(other.invite_url), [], codeOnly);
    const answer = await guest.bridge.enroll(member);
    expect(answer).toMatchObject({ status: "pairing", existing_account: true, user_code: expect.any(String), pairing_url: expect.any(String), next: expect.stringContaining("check_pairing") });
    expect(String(answer.next)).toContain("invite was not spent");
    expect(guest.store.state.enrollment).toBeUndefined();
    expect(guest.store.state.pending_grant).toBeDefined();
    // The CLI says the same and names its own command.
    const cli = await guestBridge(target!, local(other.invite_url));
    await expect(joinFromLink(cli.store, local(other.invite_url), { email: member, fetchImpl: codeOnly(cli.bridge.client.fetchImpl!), clock: target!.clock })).rejects.toThrow(/dossy-bridge pair/);
  });

  it("starts with no invite and takes the one the human gives it", async () => {
    const inviter = await target!.enroll("later-inviter");
    const invite = await inviter.client.createInvite({ kind: "network", label: "Ana" });
    const dir = await mkdtemp(join(tmpdir(), "dossy-blank-"));
    const store = await Keystore.create(join(dir, "bridge.json"), LOCAL);
    const sponsor = await target!.enroll(`sponsor-${tag()}`);
    const bridge = await Bridge.start(store, new ScriptedHuman(), { fetchImpl: sponsor.client.fetchImpl, clock: target!.clock });
    expect(bridge.mode).toBe("guest");
    await expect(bridge.readInvitation()).rejects.toThrow(/pass it to read_invitation/);
    await expect(bridge.networkStatus()).resolves.toMatchObject({ mode: "guest", invite_configured: false });
    await expect(bridge.readInvitation(local(invite.invite_url))).resolves.toMatchObject({ kind: "network", inviter_label: "Ana" });
    expect(store.state.pending_invite).toBe(local(invite.invite_url));
  });

  it("pairs a guest with its human's account, switches to member tools, and leaves the invite unspent", async () => {
    const inviter = await target!.enroll("pair-inviter");
    const invite = await inviter.client.createInvite({ kind: "network", label: "Ana" });
    const { bridge, store } = await guestBridge(target!, local(invite.invite_url));
    const read = await bridge.readInvitation();
    await expect(bridge.checkPairing(0)).rejects.toThrow(/start_pairing first/);
    const started = await bridge.startPairing("Claude Code on a laptop");
    expect(started).toMatchObject({
      status: "pending",
      user_code: expect.any(String),
      key_fingerprint: read.key_fingerprint,
      next: expect.stringContaining("check_pairing"),
    });
    expect(String(started.pairing_url)).toContain(`/pair?code=${String(started.user_code)}`);
    expect(await bridge.startPairing()).toMatchObject({ user_code: started.user_code });
    expect(await bridge.checkPairing(0)).toMatchObject({ status: "pending", user_code: started.user_code });
    await expect(bridge.networkStatus()).resolves.toMatchObject({ mode: "guest", pairing: { pending: true, user_code: started.user_code, key_fingerprint: read.key_fingerprint } });

    const human = await target!.enroll("pair-human");
    await target!.approvePairing!(human, String(started.user_code));
    const connected = await bridge.checkPairing(0);
    expect(connected).toMatchObject({ status: "connected", agent_id: expect.any(String), next: expect.stringContaining("update_grant") });
    expect(String(connected.next)).toContain("pass it to someone else");
    expect(bridge.mode).toBe("member");
    expect(store.state).toMatchObject({ agent_id: connected.agent_id });
    expect(store.state.pairing).toBeUndefined();
    expect(store.state.pending_invite).toBeUndefined();
    // The human already belongs to a private board; the paired agent follows it as a new member would.
    expect(store.state.followed).toContain(target!.boardId);
    await expect(bridge.standing()).resolves.toMatchObject({ invites_remaining: expect.any(Number) });
    await expect(bridge.checkPairing()).resolves.toMatchObject({ status: "connected", agent_id: connected.agent_id });
    await expect(inviter.client.invitation(parseJoinLink(local(invite.invite_url)).invite)).resolves.toMatchObject({ kind: "network", inviter_label: "Ana" });
  });

  it("drops an expired pairing and starts a fresh code", async () => {
    const inviter = await target!.enroll("expiry-inviter");
    const invite = await inviter.client.createInvite({ kind: "network" });
    const { bridge, store } = await guestBridge(target!, local(invite.invite_url));
    const started = await bridge.startPairing();
    await target!.advanceTime!(11 * 60_000);
    await expect(bridge.checkPairing(0)).rejects.toThrow(/expired[\s\S]*start_pairing/);
    expect(store.state.pairing).toBeUndefined();
    const again = await bridge.startPairing();
    expect(again.user_code).not.toEqual(started.user_code);
    expect(bridge.mode).toBe("guest");
  });

  it("asks the human for everything outside the grant, and always for the grant itself", async () => {
    const { bridge, human, store } = await joinedBridge(target!, [], "ask");
    const board = `grant.${tag()}`;
    await bridge.createBoard({ board_id: board, description: "Grant check." });
    expect(human.shown.map((item) => item.action)).toEqual(["create_board"]);
    human.decide = (approval) => approval.action !== "update_grant";
    await expect(bridge.updateGrant({ standing_actions: ["create_board"] })).resolves.toMatchObject({ updated: false });
    human.decide = () => true;
    await expect(bridge.updateGrant({ standing_actions: ["create_board", "submit_offer"] })).rejects.toThrow(/cannot cover submit_offer/);
    await bridge.updateGrant({ standing_actions: ["create_board", "rate_connection"], notify: { kind: "command", command: "echo matched" } });
    expect(human.shown.at(-1)).toMatchObject({ action: "update_grant", permits: expect.arrayContaining([expect.stringContaining("echo matched")]) });
    const shownBefore = human.shown.length;
    await expect(bridge.createBoard({ board_id: `grant.${tag()}`, description: "Covered." })).resolves.toMatchObject({ sent: true, under_standing_grant: true });
    expect(human.shown).toHaveLength(shownBefore);
    expect(store.state.receipts.at(-1)).toMatchObject({ action: "create_board", channel: "standing_grant" });
    await bridge.publishRequest({ board_id: board, class: "general", tags: [], criteria: {}, terms: { ask: "Who has run a pricing change?" } });
    expect(human.shown.at(-1)?.action).toBe("post_request");
    expect(human.shown.at(-1)?.recipient).toMatch(/Every Dossy member/);
  });

  it("matches watches and searches on this machine, and sends no search term or watch to the network", async () => {
    const notified: MatchSummary[] = [];
    const watcher = await joinedBridge(target!, notified);
    const author = await joinedBridge(target!);
    const board = `ops.${tag()}`;
    await author.bridge.createBoard({ board_id: board, description: "Operations." });
    const keyword = `zebracorn${tag()}`;
    const seen: string[] = [];
    const original = watcher.bridge.client.fetchImpl;
    watcher.bridge.client.fetchImpl = async (input, init) => {
      seen.push(`${String(input)} ${String(init?.body ?? "")}`);
      return original(input, init);
    };
    await watcher.bridge.setWatch({ name: "secret-watch", intent: "My human is hiring for a role nobody knows about.", keywords_any: [keyword] });
    await watcher.bridge.syncToDigest();
    expect(notified).toEqual([]);
    await author.bridge.publishRequest({ board_id: board, class: "general", tags: ["topic:ops"], criteria: {}, terms: { ask: `Anyone running ${keyword} in production?` } });
    await author.bridge.publishRequest({ board_id: board, class: "general", tags: ["topic:ops"], criteria: {}, terms: { ask: "Unrelated question about invoices." } });
    expect(await watcher.bridge.syncToDigest()).toBe(1);
    expect(notified).toEqual([{ count: 1, watches: ["secret-watch"] }]);
    const found = await watcher.bridge.checkRequests();
    expect((found.new_requests as Record<string, unknown>[])[0]).toMatchObject({ board_id: board, matched_watches: ["secret-watch"] });
    const results = await watcher.bridge.search("invoices question");
    expect((results.results as Record<string, unknown>[]).map((item) => item.board_id)).toContain(board);
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call).not.toContain(keyword);
      expect(call).not.toContain("secret-watch");
      expect(call).not.toContain("invoices");
    }
  });

  it("surfaces new requests on followed boards and keeps the follow list local", async () => {
    const reader = await joinedBridge(target!);
    const author = await joinedBridge(target!);
    const board = `followed.${tag()}`;
    await author.bridge.createBoard({ board_id: board, description: "Followed." });
    const seen: string[] = [];
    const original = reader.bridge.client.fetchImpl;
    reader.bridge.client.fetchImpl = async (input, init) => {
      seen.push(String(input));
      return original(input, init);
    };
    await reader.bridge.follow(board.toUpperCase());
    await reader.bridge.checkRequests();
    const published = await author.bridge.publishRequest({ board_id: board, class: "general", tags: [], criteria: {}, terms: { ask: "Followed board question." } });
    const found = await reader.bridge.checkRequests();
    expect((found.new_requests as Record<string, unknown>[]).map((item) => item.request_id)).toContain(published.request_id);
    expect(seen.filter((url) => url.includes(`/boards/${board}/requests`))).toEqual([]);
  });

  it("removes withdrawn and hidden requests from local search and queued digests", async () => {
    const reader = await joinedBridge(target!);
    const author = await joinedBridge(target!);
    const moderator = await target!.enroll(`cache-moderator-${tag()}`);
    await target!.grantModerator!(moderator);
    const board = `cache.${tag()}`;
    await author.bridge.createBoard({ board_id: board, description: "Cache lifecycle." });
    await reader.bridge.follow(board);
    const keyword = `lifecycle${tag()}`;
    const withdrawn = await author.bridge.publishRequest({ board_id: board, class: "general", tags: [], criteria: {}, terms: { ask: `${keyword} withdrawn` } });
    const hidden = await author.bridge.publishRequest({ board_id: board, class: "general", tags: [], criteria: {}, terms: { ask: `${keyword} hidden` } });
    await reader.bridge.syncToDigest();
    expect((await reader.bridge.search(keyword)).results).toHaveLength(2);
    await author.bridge.withdraw("request", String(withdrawn.request_id));
    await moderator.client.moderate("hide_request", { type: "request", id: String(hidden.request_id) });
    expect((await reader.bridge.search(keyword)).results).toHaveLength(0);
    const remaining = (await reader.bridge.checkRequests()).new_requests as Record<string, unknown>[];
    expect(remaining.map((r) => r.request_id)).not.toContain(withdrawn.request_id);
    expect(remaining.map((r) => r.request_id)).not.toContain(hidden.request_id);
    await moderator.client.moderate("restore_request", { type: "request", id: String(hidden.request_id) });
    expect((await reader.bridge.search(keyword)).results).toHaveLength(1);
    expect((await reader.bridge.checkRequests()).new_requests).toHaveLength(0);
  });

  it("pairs an existing member from a private-board invite and completes that membership", async () => {
    const organizer = await target!.enroll(`private-organizer-${tag()}`);
    const member = await target!.enroll(`private-member-${tag()}`);
    const board = `private.${tag()}`;
    await organizer.client.createBoard({ board_id: board, description: "Private pilot group", visibility: "private" });
    const invite = await organizer.client.createInvite({ kind: "board", board_id: board });
    const { bridge } = await guestBridge(target!, local(invite.invite_url));
    expect(String((await bridge.readInvitation()).next)).toContain("start_pairing");
    const pairing = await bridge.startPairing();
    await target!.approvePairing!(member, String(pairing.user_code));
    const result = await bridge.checkPairing(0);
    expect(result).toMatchObject({ status: "connected", board: { id: board }, onboarding: { first_steps: expect.any(Array), examples: expect.any(Array) } });
    expect((await bridge.networkStatus()).followed_boards).toContain(board);
    expect((await bridge.catalog()).private_boards).toEqual(expect.arrayContaining([expect.objectContaining({ board_id: board })]));
  });

  it("upgrades a version 1 state file in place", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dossy-v1-"));
    const path = join(dir, "bridge.json");
    const fresh = await Keystore.create(join(dir, "seed.json"), target!.issuer);
    const v1 = { ...fresh.state, version: 1, revision: undefined, seen: { "o:r1": { digest: "d", state: "open", prompted: true, marketplaceId: "synthetic-startup" } }, gaps: [{ marketplaceId: "synthetic-startup", at: "2026-10-07T00:00:00Z", detail: "gap" }] };
    await writeFile(path, JSON.stringify(v1));
    const upgraded = await Keystore.open(path);
    expect(upgraded.state.version).toBe(2);
    expect(upgraded.state.seen["o:r1"]).toMatchObject({ feed: "synthetic-startup", prompted: true });
    expect(upgraded.state.gaps[0]).toMatchObject({ feed: "synthetic-startup" });
    await upgraded.save(target!.clock.now());
  });
});
