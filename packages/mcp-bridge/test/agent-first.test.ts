// The agent-first bridge against a real network: guest onboarding from an invite in the setup,
// the standing grant, follows, watches, local search, and the notifier. Skipped without a target.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadTarget, type ConformanceTarget } from "@dossy/conformance";
import { randomId } from "@dossy/sdk";
import { Bridge, Keystore, type ApprovalRequest, type Approver, type MatchSummary } from "../src/index.js";

const target = await loadTarget();
const suite = target?.latestCode ? describe : describe.skip;
afterAll(async () => target?.close());

class ScriptedHuman implements Approver {
  shown: ApprovalRequest[] = [];
  decide: (approval: ApprovalRequest) => boolean = () => true;
  async request(approval: ApprovalRequest) {
    this.shown.push(approval);
    return { approved: this.decide(approval), channel: "test" };
  }
}

const tag = () => randomId(5).toLowerCase().replace(/[^a-z0-9]/g, "");
const LOCAL = "http://127.0.0.1";
const local = (url: unknown) => String(url).replace(/^https?:\/\/[^/]+/, LOCAL);

async function guestBridge(network: ConformanceTarget, inviteUrl: string, notified: MatchSummary[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "dossy-guest-"));
  // Invite links must be HTTPS or local; the test network answers on any host through fetchImpl.
  const store = await Keystore.create(join(dir, "bridge.json"), LOCAL);
  store.state.pending_invite = inviteUrl;
  await store.save(network.clock.now());
  const human = new ScriptedHuman();
  const sponsor = await network.enroll(`sponsor-${tag()}`);
  const bridge = await Bridge.start(store, human, { fetchImpl: sponsor.client.fetchImpl, clock: network.clock, notify: async (_grant, summary) => { notified.push(summary); } });
  return { bridge, human, store };
}

/** A member bridge reached through the whole guest flow, the way a new member's agent joins. */
async function joinedBridge(network: ConformanceTarget, notified: MatchSummary[] = []) {
  const inviter = await network.enroll(`inviter-${tag()}`);
  const invite = await inviter.client.createInvite({ kind: "network", label: "A friend" });
  const guest = await guestBridge(network, local(invite.invite_url), notified);
  const email = `joined-${tag()}@example.test`;
  await guest.bridge.enroll(email, "Test agent");
  await guest.bridge.confirmEnrollment(String(await network.latestCode!(email)));
  return guest;
}

suite("agent-first bridge", () => {
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
    expect(await bridge.enroll(email, "Claude Code")).toMatchObject({ status: "code_sent", key_fingerprint: read.key_fingerprint });
    const code = String(await target!.latestCode!(email));
    const joined = await bridge.confirmEnrollment(code);
    expect(joined).toMatchObject({ status: "connected", next: expect.stringContaining("update_grant") });
    expect(bridge.mode).toBe("member");
    expect(store.state.pending_invite).toBeUndefined();
    await expect(bridge.standing()).resolves.toMatchObject({ invites_remaining: 5 });
  });

  it("asks the human for everything outside the grant, and always for the grant itself", async () => {
    const { bridge, human, store } = await joinedBridge(target!);
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
