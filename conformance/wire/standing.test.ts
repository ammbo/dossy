import { afterAll, describe, expect, it } from "vitest";
import { randomId, verifyStandingBadge, type PublicJwk } from "@dossy/sdk";
import { loadTarget } from "../target.js";
import type { Party } from "../target.js";
import { accept, boardName, DAY, generalDocument, HOUR, submitInterest } from "./helpers.js";

const target = await loadTarget();
const timed = target?.advanceTime ? describe : describe.skip;
const invited = target?.enrollWithInvite ? describe : describe.skip;
afterAll(async () => target?.close());

/** Publishes on a fresh open board, has `responder` offer, and connects. */
async function connect(requester: Party, responder: Party) {
  const board = boardName("rated");
  await requester.client.createBoard({ board_id: board, description: "Ratings.", visibility: "open" });
  const request = await requester.client.postRequest(generalDocument(target!, board, requester.encryption.publicJwk));
  const { offer } = await submitInterest(target!, responder, request, "preauthorized");
  const connection = await accept(requester, offer);
  return { request, offer, connection };
}

describe("standing badges", () => {
  it("binds an issuer-signed badge to each offer the requester receives", async () => {
    if (!target) return;
    const requester = await target.enroll("badge-requester");
    const responder = await target.enroll("badge-responder");
    const board = boardName("badges");
    await requester.client.createBoard({ board_id: board, description: "Badges.", visibility: "open" });
    const first = await requester.client.postRequest(generalDocument(target, board, requester.encryption.publicJwk));
    const second = await requester.client.postRequest(generalDocument(target, board, requester.encryption.publicJwk, { note: "second" }));
    await submitInterest(target, responder, first);
    await submitInterest(target, responder, second);
    const discovery = await requester.client.discover();
    const keys = discovery.keys as PublicJwk[];
    const offers = (await requester.client.listOffers(String(first.request_id))).offers as Record<string, unknown>[];
    const offer = offers[0]!;
    const badge = await verifyStandingBadge(String(offer.standing_badge), keys, { issuer: target.issuer, offer_id: String(offer.offer_id), request_id: String(first.request_id) }, target.clock.now());
    expect(badge).toMatchObject({ connections: "0", ratings: "too_few", upheld_reports: "none" });
    const other = ((await requester.client.listOffers(String(second.request_id))).offers as Record<string, unknown>[])[0]!;
    await expect(verifyStandingBadge(String(offer.standing_badge), keys, { issuer: target.issuer, offer_id: String(other.offer_id), request_id: String(second.request_id) }, target.clock.now())).rejects.toThrow();
    expect(JSON.stringify(offers)).not.toContain(responder.subject);
  });
});

timed("ratings", () => {
  it("lets each side rate once, counts a replacement once, and closes the window a week after the connection ends", async () => {
    const requester = await target!.enroll("rate-requester");
    const responder = await target!.enroll("rate-responder");
    const outsider = await target!.enroll("rate-outsider");
    const { connection } = await connect(requester, responder);
    const id = String(connection.connection_id);
    await expect(outsider.client.rateConnection(id, "spam")).rejects.toMatchObject({ status: 404 });
    await requester.client.rateConnection(id, "not_useful");
    await requester.client.rateConnection(id, "useful", randomId(), { authorizationMode: "standing" });
    await responder.client.rateConnection(id, "useful");
    const standing = await responder.client.standing();
    expect((standing.ratings_received as Record<string, Record<string, number>>).as_responder).toMatchObject({ useful: 1, not_useful: 0 });
    expect((await requester.client.standing()).ratings_received).toMatchObject({ as_requester: { useful: 1 } });
    await target!.advanceTime!(HOUR + 8 * DAY);
    await expect(requester.client.rateConnection(id, "no_show")).rejects.toMatchObject({ code: "expired" });
  });
});

invited("inviter stake", () => {
  it("shares an invitee's ratings with the inviter and earns an invite on the invitee's first useful connection", async () => {
    const inviter = await target!.enroll("stake-inviter");
    const created = await inviter.client.createInvite({ kind: "network" });
    const before = Number((await inviter.client.listInvites()).invites_remaining);
    const invitee = await target!.enrollWithInvite!("stake-invitee", String(created.code));
    const stranger = await target!.enroll("stake-stranger");
    const { connection } = await connect(stranger, invitee);
    await stranger.client.rateConnection(String(connection.connection_id), "useful");
    expect((await inviter.client.listInvites()).invites_remaining).toBe(before + 1);
    const standing = await inviter.client.standing();
    expect(standing.invitees).toMatchObject({ joined: 1, ratings_received: { useful: 1 } });
    const second = await connect(stranger, invitee);
    await stranger.client.rateConnection(String(second.connection.connection_id), "useful");
    expect((await inviter.client.listInvites()).invites_remaining).toBe(before + 1);
  });
});
