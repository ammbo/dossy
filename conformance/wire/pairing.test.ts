import { afterAll, describe, expect, it } from "vitest";
import { generateSigningPair } from "@dossy/sdk";
import { loadTarget } from "../target.js";

const target = await loadTarget();
const suite = target?.approvePairing ? describe : describe.skip;
afterAll(async () => target?.close());

suite("agent pairing", () => {
  it("registers a key only after the human approves, and only for the key holder", async () => {
    const human = await target!.enroll("pairing-human");
    const keys = await generateSigningPair();
    const discovery = await human.client.discover();
    expect((discovery.endpoints as Record<string, unknown>).pairing).toBeTruthy();
    const pairing = await human.client.startPairing(keys.publicJwk, "conformance agent");
    expect(String(pairing.user_code)).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    await expect(human.client.pollPairing(String(pairing.pairing_id), keys.privateKey)).resolves.toMatchObject({ status: "pending" });
    const impostor = await generateSigningPair();
    await expect(human.client.pollPairing(String(pairing.pairing_id), impostor.privateKey)).rejects.toMatchObject({ code: "unauthorized" });

    await target!.approvePairing!(human, String(pairing.user_code));
    const approved = await human.client.pollPairing(String(pairing.pairing_id), keys.privateKey);
    expect(approved.status).toBe("approved");

    const { DossyClient } = await import("@dossy/sdk");
    const agent = new DossyClient({ networkUrl: human.client.networkUrl, issuer: target!.issuer, fetchImpl: human.client.fetchImpl, clock: target!.clock });
    await agent.issueToken(String(approved.agent_id), keys.privateKey);
    const markets = (await agent.listMarketplaces()).marketplaces as { marketplace_id: string }[];
    expect(markets.map((market) => market.marketplace_id)).toContain(target!.marketplaceId);
  });
});
