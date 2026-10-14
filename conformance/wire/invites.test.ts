import { afterAll, describe, expect, it } from "vitest";
import { randomId } from "@dossy/sdk";
import { loadTarget } from "../target.js";
import { boardName } from "./helpers.js";

const target = await loadTarget();
const suite = target ? describe : describe.skip;
afterAll(async () => target?.close());

suite("member invites", () => {
  it("spends one invite from the budget, shows the code once, and states the inviter's stake", async () => {
    const member = await target!.enroll("inviter");
    const before = await member.client.listInvites();
    const remaining = Number(before.invites_remaining);
    expect(remaining).toBeGreaterThan(0);
    const created = await member.client.createInvite({ kind: "network", label: "Ammon's friend" });
    expect(created).toMatchObject({ kind: "network", invites_remaining: remaining - 1, stake: expect.stringContaining("standing") });
    expect(String(created.invite_url)).toContain(String(created.code));
    const listed = await member.client.listInvites();
    expect(listed.invites_remaining).toBe(remaining - 1);
    expect(JSON.stringify(listed)).not.toContain(String(created.code));
    expect(listed.invites).toEqual(expect.arrayContaining([expect.objectContaining({ invite_id: created.invite_id, status: "unspent" })]));
    const described = await member.client.invitation(String(created.code));
    expect(described).toMatchObject({ kind: "network", inviter_label: "Ammon's friend" });
  });

  it("answers an identical retry with the same invite and the same code", async () => {
    const member = await target!.enroll("invite-retry");
    const operationId = randomId();
    const first = await member.client.createInvite({ kind: "network" }, randomId(), { operationId });
    const again = await member.client.createInvite({ kind: "network" }, randomId(), { operationId });
    expect(again).toMatchObject({ invite_id: first.invite_id, code: first.code });
    expect((await member.client.listInvites()).invites_remaining).toBe(first.invites_remaining);
  });

  it("returns a revoked invite to the budget and refuses one past the budget", async () => {
    const member = await target!.enroll("invite-budget");
    const start = Number((await member.client.listInvites()).invites_remaining);
    const created = await member.client.createInvite({ kind: "network" });
    await member.client.revokeInvite(String(created.invite_id));
    expect((await member.client.listInvites()).invites_remaining).toBe(start);
    await expect(member.client.invitation(String(created.code))).rejects.toMatchObject({ code: "unauthorized" });
    for (let index = 0; index < start; index += 1) await member.client.createInvite({ kind: "network" });
    await expect(member.client.createInvite({ kind: "network" })).rejects.toMatchObject({ code: "invites_exhausted" });
  });

  it("needs human authorization, and lets only a private board's organizer invite to it", async () => {
    const organizer = await target!.enroll("board-organizer");
    const other = await target!.enroll("board-stranger");
    await expect(organizer.client.createInvite({ kind: "network" }, randomId(), { authorizationMode: "standing" })).rejects.toMatchObject({ code: "forbidden" });
    const board = boardName("club");
    await organizer.client.createBoard({ board_id: board, description: "Private club.", visibility: "private" });
    const invite = await organizer.client.createInvite({ kind: "board", board_id: board });
    await expect(other.client.createInvite({ kind: "board", board_id: board })).rejects.toMatchObject({ status: 404 });
    await expect(other.client.invitation(String(invite.code))).resolves.toMatchObject({ kind: "board", board: { id: board } });
    await expect(other.client.joinBoard(String(invite.code))).resolves.toMatchObject({ board_id: board });
    await expect(other.client.getBoard(board)).resolves.toMatchObject({ board_id: board, role: "member" });
  });
});
