import { afterAll, describe, expect, it } from "vitest";
import { MemoryStore, normalizeBoardId, randomId, syncNetwork } from "@dossy/sdk";
import { loadTarget } from "../target.js";
import { accept, boardName, generalDocument, hiringDocument, submitInterest } from "./helpers.js";

const target = await loadTarget();
const suite = target ? describe : describe.skip;
afterAll(async () => target?.close());

suite("boards", () => {
  it("converges when two agents create the same board, whatever they typed", async () => {
    const first = await target!.enroll("board-first");
    const second = await target!.enroll("board-second");
    const typed = `Hiring.${randomId(4).replace(/[^A-Za-z0-9]/g, "")} SF`;
    const id = normalizeBoardId(typed);
    const [a, b] = await Promise.all([
      first.client.createBoard({ board_id: id, description: "Hiring around San Francisco.", visibility: "open" }),
      second.client.createBoard({ board_id: id, description: "SF hiring.", visibility: "open" }),
    ]);
    expect(a.board_id).toBe(id);
    expect(b.board_id).toBe(id);
    expect(a.description).toBe(b.description);
    const catalog = (await first.client.listBoards()).boards as { board_id: string }[];
    expect(catalog.filter((entry) => entry.board_id === id)).toHaveLength(1);
    expect(await second.client.getBoard(typed)).toMatchObject({ board_id: id });
    await expect(first.client.createBoard({ board_id: typed, description: "Unnormalized.", visibility: "open" })).rejects.toMatchObject({ code: "invalid_schema" });
  });

  it("shows liveness and no creator, member list, or readers in the catalog", async () => {
    const creator = await target!.enroll("board-catalog");
    const id = boardName("catalog");
    await creator.client.createBoard({ board_id: id, description: "Catalog check.", visibility: "open" });
    await creator.client.postRequest(generalDocument(target!, id, creator.encryption.publicJwk));
    const entry = ((await creator.client.listBoards()).boards as Record<string, unknown>[]).find((item) => item.board_id === id)!;
    expect(entry).toMatchObject({ visibility: "open", status: "active", open_requests: 1, aliases: [] });
    expect(entry.last_published_at).toEqual(expect.any(String));
    expect(Object.keys(entry).sort()).toEqual(["aliases", "board_id", "description", "last_published_at", "limits", "open_requests", "status", "visibility"]);
  });

  it("lets any member read and answer an open board without joining it", async () => {
    const requester = await target!.enroll("open-requester");
    const responder = await target!.enroll("open-responder");
    const id = boardName("open");
    await requester.client.createBoard({ board_id: id, description: "Open board.", visibility: "open" });
    const request = await requester.client.postRequest(generalDocument(target!, id, requester.encryption.publicJwk));
    const page = await responder.client.listRequests(id);
    expect((page.requests as { request_id: string }[]).map((item) => item.request_id)).toContain(request.request_id);
    const { offer } = await submitInterest(target!, responder, request, "preauthorized");
    await expect(accept(requester, offer)).resolves.toMatchObject({ state: "established" });
  });

  it("keeps a private board invisible to everyone who was not admitted", async () => {
    const organizer = await target!.enroll("private-organizer");
    const outsider = await target!.enroll("private-outsider");
    const id = boardName("private");
    await expect(organizer.client.createBoard({ board_id: id, description: "Private group.", visibility: "private" }))
      .resolves.toMatchObject({ board_id: id, visibility: "private", role: "organizer" });
    const request = await organizer.client.postRequest(generalDocument(target!, id, organizer.encryption.publicJwk));
    await expect(outsider.client.getBoard(id)).rejects.toMatchObject({ status: 404 });
    await expect(outsider.client.listRequests(id)).rejects.toMatchObject({ status: 404 });
    await expect(outsider.client.getRequest(String(request.request_id))).rejects.toMatchObject({ status: 404 });
    await expect(outsider.client.postRequest(generalDocument(target!, id, outsider.encryption.publicJwk))).rejects.toMatchObject({ status: 404 });
    const catalog = (await outsider.client.listBoards()).boards as { board_id: string }[];
    expect(catalog.map((entry) => entry.board_id)).not.toContain(id);
    await expect(outsider.client.createBoard({ board_id: id, description: "Squat.", visibility: "open" })).rejects.toMatchObject({ code: "stale_state" });
  });

  it("serves every open board and no private board on the network feed, with a class filter", async () => {
    const requester = await target!.enroll("feed-requester");
    const reader = await target!.enroll("feed-reader");
    const open = boardName("feed");
    const closed = boardName("feedprivate");
    await requester.client.createBoard({ board_id: open, description: "Open feed board.", visibility: "open" });
    await requester.client.createBoard({ board_id: closed, description: "Private feed board.", visibility: "private" });
    const store = new MemoryStore();
    await syncNetwork(reader.client, store, async () => {});
    const general = await requester.client.postRequest(generalDocument(target!, open, requester.encryption.publicJwk));
    const hiring = await requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk, { board_id: open }));
    const hidden = await requester.client.postRequest(generalDocument(target!, closed, requester.encryption.publicJwk, { note: "private" }));
    const seen: string[] = [];
    await syncNetwork(reader.client, store, async (request) => {
      seen.push(String(request.request_id));
    });
    expect(seen).toEqual(expect.arrayContaining([String(general.request_id), String(hiring.request_id)]));
    expect(seen).not.toContain(String(hidden.request_id));
    const generalOnly = await reader.client.listFeed(undefined, { class: "general" });
    const ids = (generalOnly.requests as { request_id: string; board_id: string }[]).map((item) => item.request_id);
    expect(ids).toContain(String(general.request_id));
    expect(ids).not.toContain(String(hiring.request_id));
    await expect(reader.client.listFeed(String(generalOnly.feed_cursor))).rejects.toMatchObject({ code: "cursor_expired" });
  });

  it("limits how many boards one principal creates in a day", async () => {
    const creator = await target!.enroll("board-budget");
    const limit = Number(((await creator.client.discover()).limits as Record<string, number>).boards_per_24h);
    for (let index = 0; index < limit; index += 1) {
      await creator.client.createBoard({ board_id: boardName("budget"), description: "Budget.", visibility: "open" });
    }
    await expect(creator.client.createBoard({ board_id: boardName("budget"), description: "One too many.", visibility: "open" })).rejects.toMatchObject({ code: "rate_limited" });
  });
});
