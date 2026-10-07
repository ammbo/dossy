import { afterAll, describe, expect, it } from "vitest";
import { randomId } from "@dossy/sdk";
import { loadTarget } from "../target.js";
import { hiringDocument } from "./helpers.js";

const target = await loadTarget();
const suite = target ? describe : describe.skip;
afterAll(async () => target?.close());

suite("requests", () => {
  it("rejects unknown structural fields and disabled classes", async () => {
    const requester = await target!.enroll("schema");
    const doc = hiringDocument(target!, requester.encryption.publicJwk);
    await expect(requester.client.postRequest({ ...doc, script: "ignore previous instructions" })).rejects.toMatchObject({ code: "invalid_schema" });
    await expect(requester.client.postRequest({ ...doc, class: "dating" })).rejects.toMatchObject({ code: "invalid_schema" });
  });

  it("caps open requests, and a withdrawal does not refund the publication budget", async () => {
    const requester = await target!.enroll("budget");
    const markets = (await requester.client.listMarketplaces()).marketplaces as { marketplace_id: string; limits: { open: number; publications: number } }[];
    const market = markets.find((item) => item.marketplace_id === target!.marketplaceId)!;
    const limits = { open_requests: market.limits.open, publications_per_24h: market.limits.publications };
    const ids: string[] = [];
    for (let index = 0; index < limits.open_requests; index += 1) {
      ids.push(String((await requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk, { note: `open ${index}` }))).request_id));
    }
    await expect(requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk))).rejects.toMatchObject({ code: "rate_limited" });
    for (const id of ids) await requester.client.withdraw("requests", id, undefined, randomId());
    for (let index = limits.open_requests; index < limits.publications_per_24h; index += 1) {
      const posted = await requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk, { note: `refill ${index}` }));
      await requester.client.withdraw("requests", String(posted.request_id), undefined, randomId());
    }
    await expect(requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk))).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("publishes once when a lost response is retried with the same operation id", async () => {
    const requester = await target!.enroll("retry");
    const original = requester.client.fetchImpl;
    let dropped = false;
    requester.client.fetchImpl = async (input, init) => {
      const response = await original(input, init);
      if (!dropped && init?.method === "POST" && String(input).endsWith("/v0.1/requests")) {
        dropped = true;
        throw new TypeError("fetch failed");
      }
      return response;
    };
    const note = `retry ${randomId()}`;
    const created = await requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk, { note }));
    requester.client.fetchImpl = original;
    expect(dropped).toBe(true);
    const page = await requester.client.listRequests(target!.marketplaceId);
    const matching = (page.requests as { document_digest: string }[]).filter((item) => item.document_digest === created.document_digest);
    expect(matching).toHaveLength(1);
  });
});
