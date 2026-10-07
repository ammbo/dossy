import { afterAll, describe, expect, it } from "vitest";
import { MemoryStore, syncMarketplace } from "@dossy/sdk";
import { loadTarget } from "../target.js";
import { hiringDocument } from "./helpers.js";

const target = await loadTarget();
const suite = target ? describe : describe.skip;
afterAll(async () => target?.close());

suite("discovery without reader tracking", () => {
  it("recovers a request published during snapshot paging and never prompts twice", async () => {
    const requester = await target!.enroll("snapshot-requester");
    const reader = await target!.enroll("snapshot-reader");
    const first = await requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk, { note: "before snapshot" }));
    await requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk, { note: "also before snapshot" }));
    await target!.setPageSize?.(1);
    const store = new MemoryStore();
    const seen: string[] = [];
    let during = "";
    const original = reader.client.fetchImpl;
    reader.client.fetchImpl = async (input, init) => {
      const response = await original(input, init);
      if (!during && String(input).includes(`/marketplaces/${target!.marketplaceId}/requests`)) {
        during = String((await requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk, { note: "during snapshot" }))).request_id);
      }
      return response;
    };
    try {
      await syncMarketplace(reader.client, target!.marketplaceId, store, async (request) => {
        seen.push(String(request.request_id));
      });
    } finally {
      reader.client.fetchImpl = original;
      await target!.setPageSize?.(50);
    }
    expect(seen).toContain(String(first.request_id));
    expect(seen).toContain(during);
    expect(new Set(seen).size).toBe(seen.length);
    await requester.client.withdraw("requests", String(first.request_id), undefined, `withdraw-${first.request_id}`);
    await syncMarketplace(reader.client, target!.marketplaceId, store, async () => {
      throw new Error("a lifecycle change must not prompt again");
    });
  });

  it("returns cursor_expired for a cursor it did not issue", async () => {
    const reader = await target!.enroll("cursor-reader");
    await expect(reader.client.listRequests(target!.marketplaceId, "not.a-cursor")).rejects.toMatchObject({ code: "cursor_expired" });
  });

  it("offers a request again when the human prompt failed", async () => {
    const requester = await target!.enroll("prompt-requester");
    const reader = await target!.enroll("prompt-reader");
    const store = new MemoryStore();
    await syncMarketplace(reader.client, target!.marketplaceId, store, async () => {});
    const created = await requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk, { note: "prompt failure" }));
    const first = await syncMarketplace(reader.client, target!.marketplaceId, store, async (request) => {
      if (request.request_id === created.request_id) throw new Error("model call failed");
    });
    expect(first.failed).toBe(1);
    const prompted: string[] = [];
    await syncMarketplace(reader.client, target!.marketplaceId, store, async (request) => {
      prompted.push(String(request.request_id));
    });
    expect(prompted).toEqual([String(created.request_id)]);
  });
});
