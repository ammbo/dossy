import { afterAll, describe, expect, it } from "vitest";
import { generateEncryptionPair, randomId, type PcnHeader } from "@dossy/sdk";
import { loadTarget } from "../target.js";
import { accept, eventDocument, hiringDocument, lifetime, submitInterest } from "./helpers.js";

const target = await loadTarget();
const suite = target ? describe : describe.skip;
afterAll(async () => target?.close());

suite("connections", () => {
  it("requires confirmation, exchanges peer keys, and enforces the handoff limit", async () => {
    const requester = await target!.enroll("connect-requester");
    const responder = await target!.enroll("connect-responder");
    const request = await requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk));
    const { offer } = await submitInterest(target!, responder, request, "confirm_required");
    const messageKey = await generateEncryptionPair();
    const proposed = await accept(requester, offer, messageKey.publicJwk);
    expect(proposed.state).toBe("pending_confirmation");
    expect(proposed.peer_message_key).toEqual(responder.encryption.publicJwk);
    const pending = ((await responder.client.inbox()).connections as Record<string, unknown>[]).find((item) => item.connection_id === proposed.connection_id)!;
    expect(pending.role).toBe("responder");
    expect(pending.peer_message_key).toEqual(messageKey.publicJwk);
    const confirmed = await responder.client.confirmConnection(String(proposed.connection_id), Number(pending.state_version), randomId());
    expect(confirmed.state).toBe("established");

    const operationId = randomId();
    const binding: PcnHeader & { message_type: "handoff" } = {
      origin: String(confirmed.origin),
      request_id: String(confirmed.request_id),
      request_digest: String(confirmed.request_digest),
      connection_id: String(confirmed.connection_id),
      sender_role: "responder",
      message_type: "handoff" as const,
      operation_id: operationId,
      exp: String(confirmed.coordination_expires_at),
    };
    const handoff = await responder.client.encryptMessage({
      peerKey: confirmed.peer_message_key as never,
      plaintext: { display_name: "Responder", scheduling_url: "https://example.test/book" },
      origin: binding.origin,
      requestId: binding.request_id,
      requestDigest: binding.request_digest,
      connectionId: binding.connection_id as string,
      senderRole: "responder",
      messageType: "handoff",
      operationId,
      expiresAt: binding.exp,
    });
    await responder.client.sendMessage(String(confirmed.connection_id), { message_type: "handoff", ciphertext: handoff }, randomId(), undefined, { operationId });
    await expect(responder.client.sendMessage(String(confirmed.connection_id), { message_type: "handoff", ciphertext: handoff }, randomId())).rejects.toMatchObject({ code: "forbidden" });
    const listed = (await requester.client.listMessages(String(confirmed.connection_id))).messages as { ciphertext: string }[];
    const opened = await requester.client.openMessage(messageKey.privateKey, listed[0]!.ciphertext, binding);
    expect(opened).toEqual({ display_name: "Responder", scheduling_url: "https://example.test/book" });
  });

  it("lets only one of two concurrent acceptances take the last slot", async () => {
    const host = await target!.enroll("race-host");
    const request = await host.client.postRequest(eventDocument(target!, host.encryption.publicJwk, 1));
    const a = await submitInterest(target!, await target!.enroll("race-a"), request, "preauthorized");
    const b = await submitInterest(target!, await target!.enroll("race-b"), request, "preauthorized");
    const results = await Promise.allSettled([accept(host, a.offer), accept(host, b.offer)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await lifetime(host)).connected).toBe(1);
  });

  it("cancels a pending proposal when the requester revokes its accept authority", async () => {
    const requester = await target!.enroll("revoke-requester");
    const responder = await target!.enroll("revoke-responder");
    const request = await requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk));
    const { offer } = await submitInterest(target!, responder, request, "confirm_required");
    const acceptRef = randomId();
    const proposed = await accept(requester, offer, requester.encryption.publicJwk, acceptRef);
    await requester.client.revokeAuthorization(acceptRef);
    await expect(responder.client.confirmConnection(String(proposed.connection_id), 1, randomId())).rejects.toMatchObject({ status: 409 });
    expect((await requester.client.getRequest(String(request.request_id))).state).toBe("open");
    expect((await lifetime(requester)).connected).toBe(0);
  });

  it("closes an established channel when the responder revokes the offer authority, and only the owner can", async () => {
    const requester = await target!.enroll("close-requester");
    const responder = await target!.enroll("close-responder");
    const outsider = await target!.enroll("close-outsider");
    const request = await requester.client.postRequest(hiringDocument(target!, requester.encryption.publicJwk));
    const offerRef = randomId();
    const { offer } = await submitInterest(target!, responder, request, "preauthorized", offerRef);
    const connection = await accept(requester, offer);
    expect(connection.state).toBe("established");
    const stateOf = async () => ((await responder.client.inbox()).connections as { connection_id: string; state: string }[])
      .find((item) => item.connection_id === connection.connection_id)?.state;
    await outsider.client.revokeAuthorization(offerRef);
    expect(await stateOf()).toBe("established");
    await responder.client.revokeAuthorization(offerRef);
    expect(await stateOf()).toBe("closed");
  });
});
