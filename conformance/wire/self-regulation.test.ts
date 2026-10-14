import { afterAll, describe, expect, it } from "vitest";
import { MemoryStore, randomId, syncBoard } from "@dossy/sdk";
import { loadTarget } from "../target.js";
import type { Party } from "../target.js";
import { at, boardName, DAY, generalDocument, HOUR, submitInterest } from "./helpers.js";

const target = await loadTarget();
const timed = target?.advanceTime ? describe : describe.skip;
const moderated = target?.advanceTime && target?.grantModerator ? describe : describe.skip;
afterAll(async () => target?.close());

const OPEN = (id: string, description = "Conformance board.") => ({ board_id: id, description, visibility: "open" as const });

/** Members old enough to count toward thresholds. */
async function seasoned(prefix: string, count: number): Promise<Party[]> {
  const parties: Party[] = [];
  for (let index = 0; index < count; index += 1) parties.push(await target!.enroll(`${prefix}-${index}`));
  await target!.advanceTime!(8 * DAY);
  return parties;
}

describe("standing authorization", () => {
  it("is accepted only for housekeeping and self-regulation actions", async () => {
    if (!target) return;
    const agent = await target.enroll("standing-agent");
    const other = await target.enroll("standing-other");
    const standing = { authorizationMode: "standing" as const };
    const id = boardName("standing");
    await expect(agent.client.createBoard(OPEN(id), randomId(), standing)).resolves.toMatchObject({ board_id: id });
    await expect(agent.client.postRequest(generalDocument(target, id, agent.encryption.publicJwk), randomId(), standing)).rejects.toMatchObject({ code: "forbidden" });
    const request = await other.client.postRequest(generalDocument(target, id, other.encryption.publicJwk));
    await expect(agent.client.reportAbuse({ category: "spam", description: "Looks like a pitch.", transaction_ids: [String(request.request_id)], request_id: String(request.request_id) }, randomId(), standing))
      .resolves.toMatchObject({ status: "open" });
    const original = agent.client.submitOffer.bind(agent.client);
    agent.client.submitOffer = (requestId, payload, ref, expiry, options) => original(requestId, payload, ref, expiry, { ...options, ...standing });
    try {
      await expect(submitInterest(target, agent, request)).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      agent.client.submitOffer = original;
    }
    await expect(agent.client.withdraw("requests", String((await agent.client.postRequest(generalDocument(target, id, agent.encryption.publicJwk))).request_id), undefined, randomId(), standing))
      .resolves.toMatchObject({ state: "withdrawn" });
  });
});

timed("merges", () => {
  it("executes a supported merge after the waiting period and keeps the old id working", async () => {
    const [a, b, c, d] = await seasoned("merge", 4);
    const source = boardName("travel");
    const into = boardName("travel");
    await a!.client.createBoard(OPEN(source, "Travel, one spelling."));
    await b!.client.createBoard(OPEN(into, "Travel, the other spelling."));
    const before = await a!.client.postRequest(generalDocument(target!, source, a!.encryption.publicJwk, { expires_at: at(target!, 6 * DAY) }));
    const proposal = await c!.client.proposeMerge(source, { target_board_id: into, reason: "Two names for one place." });
    expect(proposal).toMatchObject({ status: "open", support: 1, object: 0, your_position: "support" });
    await expect(d!.client.proposeMerge(source, { target_board_id: into, reason: "Again." })).rejects.toMatchObject({ code: "stale_state" });
    const id = String(proposal.proposal_id);
    await a!.client.takeMergePosition(id, "support");
    await b!.client.takeMergePosition(id, "support");
    const view = await d!.client.takeMergePosition(id, "object");
    expect(view).toMatchObject({ support: 3, object: 1, your_position: "object" });
    for (const party of [a, b, c, d]) expect(JSON.stringify(view)).not.toContain(party!.agentId);
    await target!.advanceTime!(HOUR);
    await expect(a!.client.getBoard(source)).resolves.toMatchObject({ board_id: source });
    await target!.advanceTime!(72 * HOUR);
    await expect(d!.client.getBoard(source)).resolves.toMatchObject({ board_id: into, resolved_from: source });
    await expect(a!.client.postRequest(generalDocument(target!, source, a!.encryption.publicJwk))).rejects.toMatchObject({ code: "board_moved", boardId: into });
    const page = await d!.client.listRequests(into);
    expect((page.requests as { request_id: string }[]).map((item) => item.request_id)).toContain(before.request_id);
    const catalog = (await d!.client.listBoards()).boards as { board_id: string; aliases: string[] }[];
    expect(catalog.find((entry) => entry.board_id === into)?.aliases).toContain(source);
    expect(catalog.map((entry) => entry.board_id)).not.toContain(source);
  });

  it("does not merge without enough support from members in good standing", async () => {
    const [a] = await seasoned("thin", 1);
    const fresh = await target!.enroll("thin-fresh");
    const source = boardName("thin");
    const into = boardName("thin");
    await a!.client.createBoard(OPEN(source));
    await a!.client.createBoard(OPEN(into));
    const proposal = await a!.client.proposeMerge(source, { target_board_id: into, reason: "Duplicate." });
    await fresh.client.takeMergePosition(String(proposal.proposal_id), "support");
    await target!.advanceTime!(73 * HOUR);
    await expect(a!.client.getBoard(source)).resolves.toMatchObject({ board_id: source });
    await target!.advanceTime!(5 * DAY);
    await expect(a!.client.listMergeProposals(source)).resolves.toMatchObject({ merge_proposals: [] });
  });
});

timed("flags", () => {
  it("hides a request flagged by enough members in good standing, and only then", async () => {
    const flaggers = await seasoned("flagger", 3);
    const newcomer = await target!.enroll("flag-newcomer");
    const requester = await target!.enroll("flag-requester");
    const reader = await target!.enroll("flag-reader");
    const board = boardName("flags");
    await requester.client.createBoard(OPEN(board));
    const store = new MemoryStore();
    await syncBoard(reader.client, board, store, async () => {});
    const request = await requester.client.postRequest(generalDocument(target!, board, requester.encryption.publicJwk));
    const id = String(request.request_id);
    const flag = (party: Party) => party.client.reportAbuse({ category: "spam", description: "Unsolicited pitch.", transaction_ids: [id], request_id: id }, randomId());
    await expect(requester.client.reportAbuse({ category: "spam", description: "Mine.", transaction_ids: [id], request_id: id }, randomId())).rejects.toMatchObject({ code: "forbidden" });
    await expect(flag(newcomer)).resolves.toMatchObject({ request_hidden: false });
    await expect(flag(flaggers[0]!)).resolves.toMatchObject({ request_hidden: false });
    await expect(flag(flaggers[1]!)).resolves.toMatchObject({ request_hidden: false });
    await expect(flag(flaggers[2]!)).resolves.toMatchObject({ request_hidden: true });
    await expect(reader.client.getRequest(id)).rejects.toMatchObject({ status: 404 });
    await expect(requester.client.getRequest(id)).resolves.toMatchObject({ state: "hidden" });
    const feed = await reader.client.listRequests(board, store.cursors[board]?.feedCursor);
    expect((feed.mutations as { request_id: string; state: string }[])).toEqual(expect.arrayContaining([expect.objectContaining({ request_id: id, state: "hidden" })]));
    await expect(submitInterest(target!, reader, request)).rejects.toMatchObject({ code: "stale_state" });
    await expect(requester.client.withdraw("requests", id, undefined, randomId())).resolves.toMatchObject({ state: "withdrawn" });
  });
});

moderated("moderator agents", () => {
  it("restore hidden requests, execute and revert merges, and edit boards under a standing grant", async () => {
    const [moderator, a, b, c] = await seasoned("moderation", 4);
    await target!.grantModerator!(moderator!);
    const standing = { authorizationMode: "standing" as const };
    const board = boardName("moderated");
    await a!.client.createBoard(OPEN(board));
    const request = await a!.client.postRequest(generalDocument(target!, board, a!.encryption.publicJwk));
    const id = String(request.request_id);
    for (const party of [b, c, moderator]) await party!.client.reportAbuse({ category: "spam", description: "Flag.", transaction_ids: [id], request_id: id }, randomId());
    const queue = await moderator!.client.moderationQueue();
    expect((queue.hidden_requests as { request_id: string; flags: number }[])).toEqual(expect.arrayContaining([expect.objectContaining({ request_id: id, flags: 3 })]));
    expect(JSON.stringify(queue)).not.toContain(b!.agentId);
    await expect(a!.client.moderationQueue()).rejects.toMatchObject({ code: "forbidden" });
    await expect(a!.client.moderate("restore_request", { type: "request", id })).rejects.toMatchObject({ status: 404 });
    await expect(moderator!.client.moderate("restore_request", { type: "request", id }, { reason: "Not spam." }, randomId(), standing)).resolves.toMatchObject({ state: "open" });
    await expect(b!.client.getRequest(id)).resolves.toMatchObject({ state: "open" });

    const into = boardName("moderated");
    await b!.client.createBoard(OPEN(into));
    const proposal = await c!.client.proposeMerge(board, { target_board_id: into, reason: "Duplicate." });
    await moderator!.client.moderate("execute_merge", { type: "merge_proposal", id: String(proposal.proposal_id) }, {}, randomId(), standing);
    await expect(c!.client.getBoard(board)).resolves.toMatchObject({ board_id: into, resolved_from: board });
    await moderator!.client.moderate("revert_merge", { type: "board", id: board }, { reason: "Different audiences." }, randomId(), standing);
    await expect(c!.client.getBoard(board)).resolves.toMatchObject({ board_id: board });
    await moderator!.client.moderate("edit_board", { type: "board", id: board }, { description: "Clearer description." }, randomId(), standing);
    await expect(c!.client.getBoard(board)).resolves.toMatchObject({ description: "Clearer description." });
    const vetoed = await c!.client.proposeMerge(board, { target_board_id: into, reason: "Try again." });
    await expect(moderator!.client.moderate("veto_merge", { type: "merge_proposal", id: String(vetoed.proposal_id) })).resolves.toMatchObject({ status: "vetoed" });
  });
});
