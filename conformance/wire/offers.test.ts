import { afterAll, describe, expect, it } from "vitest";
import { loadVocabulary, localDecline, randomId, triage } from "@dossy/sdk";
import { loadTarget } from "../target.js";
import { accept, at, DAY, hiringDocument, lifetime, submitInterest } from "./helpers.js";

const target = await loadTarget();
const suite = target ? describe : describe.skip;
afterAll(async () => target?.close());

suite("offers and silence", () => {
  it("emits nothing when a human privately declines", async () => {
    const requester = await target!.enroll("silence-requester");
    const responder = await target!.enroll("silence-responder");
    const request = await requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk));
    const before = { offers: await requester.client.listOffers(String(request.request_id)), view: await requester.client.getRequest(String(request.request_id)), counts: await lifetime(requester) };
    const calls: string[] = [];
    const original = responder.client.fetchImpl;
    responder.client.fetchImpl = async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      return original(input, init);
    };
    const fetched = await responder.client.getRequest(String(request.request_id));
    const decision = triage({ ...(fetched.document as Record<string, unknown>), protocol: String(fetched.protocol) } as never, loadVocabulary());
    expect(decision.action).toBe("private_evaluation");
    expect(localDecline()).toEqual({ action: "decline" });
    responder.client.fetchImpl = original;
    // Token refreshes carry no decision. Everything else after the fetch would.
    expect(calls.filter((call) => !call.endsWith("/v0.1/oauth/token"))).toEqual([`GET /v0.1/requests/${request.request_id}`]);
    expect(await requester.client.listOffers(String(request.request_id))).toEqual(before.offers);
    expect(await requester.client.getRequest(String(request.request_id))).toEqual(before.view);
    expect(await lifetime(requester)).toEqual(before.counts);
  });

  it("delivers an offer the requester can decrypt, without the responder's stable identifiers", async () => {
    const requester = await target!.enroll("offer-requester");
    const responder = await target!.enroll("offer-responder");
    const request = await requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk));
    const { offer, payload, binding } = await submitInterest(target!, responder, request);
    expect(JSON.stringify(offer)).not.toContain(String(payload.ciphertext));
    const listed = (await requester.client.listOffers(String(request.request_id))).offers as Record<string, unknown>[];
    const visible = JSON.stringify(listed);
    expect(visible).not.toContain(responder.agentId);
    expect(visible).not.toContain(responder.subject);
    const opened = await requester.client.openOffer(requester.encryption.privateKey, String(listed[0]!.ciphertext), binding, ["interest"]);
    expect(opened).toEqual({ interest: true });
  });

  it("refuses an offer on the responder's own request", async () => {
    const party = await target!.enroll("self");
    const request = await party.client.postRequest(hiringDocument(target!, party.encryption.publicJwk));
    await expect(submitInterest(target!, party, request)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects an authorization whose permission has expired", async () => {
    const requester = await target!.enroll("expiry-requester");
    const responder = await target!.enroll("expiry-responder");
    const request = await requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk));
    const payload = {
      offer_id: randomId(),
      request_digest: String(request.document_digest),
      expires_at: at(target!, DAY),
      declared_fields: ["interest"],
      connection_permission: "confirm_required",
      permission_expires_at: at(target!, -1000),
      responder_key: responder.encryption.publicJwk,
      ciphertext: "a.b.c.d.e",
    };
    await expect(responder.client.submitOffer(String(request.request_id), payload, randomId())).rejects.toMatchObject({ code: "expired" });
  });

  it("rejects a signed action sent to another action's route", async () => {
    const requester = await target!.enroll("route-requester");
    const responder = await target!.enroll("route-responder");
    const request = await requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk));
    const { offer } = await submitInterest(target!, responder, request, "preauthorized");
    const original = requester.client.fetchImpl;
    requester.client.fetchImpl = async (input, init) => original(String(input).replace(/\/v0\.1\/offers\/[^/]+\/accept/, "/v0.1/reports"), init);
    try {
      await expect(accept(requester, offer)).rejects.toMatchObject({ code: "invalid_schema" });
    } finally {
      requester.client.fetchImpl = original;
    }
  });
});
