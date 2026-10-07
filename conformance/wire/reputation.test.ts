import { afterAll, describe, expect, it } from "vitest";
import { randomId } from "@dossy/sdk";
import { loadTarget } from "../target.js";
import { accept, at, conserves, eventDocument, HOUR, hiringDocument, lifetime, submitInterest } from "./helpers.js";

const target = await loadTarget();
const suite = target?.advanceTime ? describe : describe.skip;
afterAll(async () => target?.close());

suite("requester reputation", () => {
  it("classifies withdrawals, offered expiries, and crickets, and conserves every bucket", async () => {
    const requester = await target!.enroll("rep-requester");
    const helper = await target!.enroll("rep-helper");

    const withdrawn = await requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk, { expires_at: at(target!, 2 * HOUR) }));
    await submitInterest(target!, helper, withdrawn);
    await requester.client.withdraw("requests", String(withdrawn.request_id), undefined, randomId());

    const offered = await requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk, { expires_at: at(target!, 2 * HOUR), note: "offered" }));
    const { offer } = await submitInterest(target!, helper, offered);
    await helper.client.withdraw("offers", String(offer.offer_id), undefined, randomId());

    await requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk, { expires_at: at(target!, 2 * HOUR), note: "crickets" }));

    // The reputation read settles due expiries itself; no worker run is needed.
    await target!.advanceTime!(3 * HOUR);
    const counts = await lifetime(requester);
    expect(counts).toMatchObject({ posted: 3, canceled_unconnected: 1, offers_unconnected: 1, crickets: 1, connected: 0, pending_unconnected: 0 });
    expect(conserves(counts)).toBe(true);
  });

  it("credits a multi-connection event once and refuses self-connection credit", async () => {
    const host = await target!.enroll("rep-host");
    const event = await host.client.postRequest(eventDocument(target!, host.encryption.publicJwk, 3));
    for (const label of ["rep-guest-1", "rep-guest-2"]) {
      const { offer } = await submitInterest(target!, await target!.enroll(label), event, "preauthorized");
      await accept(host, offer);
    }
    const counts = await lifetime(host);
    expect(counts.connected).toBe(1);
    expect(conserves(counts)).toBe(true);
    const reputation = await host.client.reputation(host.subject);
    expect(reputation.established_connections).toBe(2);
    await expect(submitInterest(target!, host, event, "preauthorized")).rejects.toMatchObject({ code: "forbidden" });
  });
});
