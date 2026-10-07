import { afterAll, describe, expect, it } from "vitest";
import { assertSchema, PROTOCOL } from "@dossy/sdk";
import { loadTarget } from "../target.js";
import { hiringDocument } from "./helpers.js";

const target = await loadTarget();
const suite = target ? describe : describe.skip;
afterAll(async () => target?.close());

suite("discovery and credentials", () => {
  it("advertises the issuer, version, endpoints, and privacy profile", async () => {
    const party = await target!.enroll("discovery");
    const discovery = await party.client.discover();
    assertSchema("https://dossy.dev/schemas/discovery.json", discovery);
    expect(discovery.issuer).toBe(target!.issuer);
    expect(discovery.versions).toContain(PROTOCOL);
    expect((discovery.privacy as Record<string, unknown>).access_history).toBe("not_retained");
  });

  it("hides marketplaces the principal was not admitted to", async () => {
    const party = await target!.enroll("isolation");
    const markets = (await party.client.listMarketplaces()).marketplaces as { marketplace_id: string }[];
    expect(markets.map((market) => market.marketplace_id)).toContain(target!.marketplaceId);
    await expect(party.client.listRequests("pcn-conformance-not-admitted")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a revoked agent's existing token, new tokens, and actions", async () => {
    const party = await target!.enroll("revoked");
    const token = party.client.accessToken;
    await party.client.revokeAgent(party.agentId);
    party.client.accessToken = token;
    await expect(party.client.listMarketplaces()).rejects.toMatchObject({ code: "revoked" });
    await expect(party.client.issueToken(party.agentId, party.signing.privateKey)).rejects.toMatchObject({ code: "revoked" });
    party.client.accessToken = token;
    await expect(party.client.postRequest(hiringDocument(target!, party.encryption.publicJwk))).rejects.toMatchObject({ code: "revoked" });
  });

  it("does not reveal offers to anyone but the requester", async () => {
    const requester = await target!.enroll("offers-owner");
    const outsider = await target!.enroll("offers-outsider");
    const request = await requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk));
    await expect(outsider.client.listOffers(String(request.request_id))).rejects.toMatchObject({ status: 404 });
  });
});
