import { DossyClient } from "@dossy/sdk";
import { expect, it } from "vitest";

it("names failed endpoints and transport causes without leaking invite queries or bodies", async () => {
  const secret = "private_invite_123456789";
  const client = new DossyClient({ networkUrl: "https://network.example.test", fetchImpl: async () => {
    throw new TypeError(`fetch failed: ${secret}`, { cause: Object.assign(new Error(`Cannot resolve ${secret}`), { code: "ENOTFOUND" }) });
  } });
  const error = await client.invitation(secret).catch(error => error);
  expect(error).toMatchObject({ code: "unavailable", status: 0, retryable: true });
  expect(error.message).toContain("GET https://network.example.test/v0.2/invitations");
  expect(error.message).toContain("DNS lookup failed (ENOTFOUND)");
  expect(error.message).not.toContain(secret);
  expect(error.message).not.toContain("?code=");
});

it("reports HTTP status and path for JSON and non-JSON failures", async () => {
  for (const body of [JSON.stringify({ error: "unavailable", message: "Try later" }), "Bad gateway"]) {
    const client = new DossyClient({ networkUrl: "https://network.example.test", fetchImpl: async () => new Response(body, { status: 503 }) });
    await expect(client.discover()).rejects.toMatchObject({ code: "unavailable", status: 503, message: expect.stringContaining("GET https://network.example.test/.well-known/dcp: HTTP 503") });
  }
});

it("identifies truncated response streams as retryable", async () => {
  const client = new DossyClient({ networkUrl: "https://network.example.test", fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(Object.assign(new Error("socket closed"), { code: "ECONNRESET" })); } })) });
  await expect(client.discover()).rejects.toMatchObject({ code: "unavailable", retryable: true, message: expect.stringContaining("ECONNRESET") });
});
