import { randomId, type PcnHeader, type PublicJwk } from "@dossy/sdk";
import type { ConformanceTarget, Party } from "../target.js";

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

export function at(target: ConformanceTarget, offsetMs: number): string {
  return new Date(target.clock.now().getTime() + offsetMs).toISOString();
}

export function hiringDocument(target: ConformanceTarget, replyKey: PublicJwk, patch: Record<string, unknown> = {}) {
  return {
    protocol: "dcp/0.1",
    revision: 1,
    class: "hiring",
    vocabulary: "core/0.1",
    marketplace_id: target.marketplaceId,
    tags: ["role:growth-lead", "industry:b2b-saas", "seniority:senior"],
    criteria: { required_tags: ["role:growth-lead"], locations: [], work_mode: ["remote"] },
    terms: { purpose: "conversation" },
    expires_at: at(target, 6 * DAY),
    max_connections: 1,
    offer_schema: { required: ["interest"], allowed: ["interest", "available_from", "skill_tags"] },
    requester_display: { label: "Conformance hiring team" },
    reply_key: replyKey,
    ...patch,
  };
}

export function eventDocument(target: ConformanceTarget, replyKey: PublicJwk, maxConnections = 2) {
  const deadline = at(target, 6 * DAY);
  return {
    protocol: "dcp/0.1",
    revision: 1,
    class: "event",
    vocabulary: "core/0.1",
    marketplace_id: target.marketplaceId,
    tags: ["topic:hiring"],
    criteria: { locations: ["loc:nyc"] },
    terms: {
      title: "Founder dinner",
      starts_at: at(target, 8 * DAY),
      ends_at: at(target, 8 * DAY + 3 * HOUR),
      format: "in_person",
      location: "loc:nyc",
      purpose: "interest",
      response_deadline: deadline,
    },
    expires_at: deadline,
    max_connections: maxConnections,
    offer_schema: { required: ["interest"], allowed: ["interest"] },
    reply_key: replyKey,
  };
}

export type Submitted = {
  offer: Record<string, unknown>;
  payload: Record<string, unknown>;
  binding: PcnHeader;
};

/** Submits an approved interest-only offer, encrypted to the request's reply key. */
export async function submitInterest(
  target: ConformanceTarget,
  responder: Party,
  request: Record<string, unknown>,
  permission: "preauthorized" | "confirm_required" = "confirm_required",
  authorizationRef = randomId(),
): Promise<Submitted> {
  const document = request.document as { reply_key: PublicJwk; expires_at: string };
  const offerId = randomId();
  const operationId = randomId();
  const dayOut = at(target, DAY);
  const expiresAt = document.expires_at < dayOut ? document.expires_at : dayOut;
  const binding: PcnHeader = {
    origin: String(request.origin),
    request_id: String(request.request_id),
    request_digest: String(request.document_digest),
    offer_id: offerId,
    sender_role: "responder",
    message_type: "offer",
    operation_id: operationId,
    exp: expiresAt,
  };
  const ciphertext = await responder.client.encryptOffer({
    replyKey: document.reply_key,
    plaintext: { interest: true },
    origin: binding.origin,
    requestId: binding.request_id,
    requestDigest: binding.request_digest,
    offerId,
    operationId,
    expiresAt,
  });
  const payload = {
    offer_id: offerId,
    request_digest: binding.request_digest,
    expires_at: expiresAt,
    declared_fields: ["interest"],
    connection_permission: permission,
    permission_expires_at: expiresAt,
    responder_key: responder.encryption.publicJwk,
    ciphertext,
  };
  const offer = await responder.client.submitOffer(binding.request_id, payload, authorizationRef, expiresAt, { operationId });
  return { offer, payload, binding };
}

export function digestOf(offer: Record<string, unknown>): string {
  return String((offer.authorization as { payload_digest: string }).payload_digest);
}

export async function accept(requester: Party, offer: Record<string, unknown>, messageKey: PublicJwk = requester.encryption.publicJwk, authorizationRef = randomId()) {
  return requester.client.acceptOffer(String(offer.offer_id), { requester_message_key: messageKey }, authorizationRef, Number(offer.state_version), digestOf(offer));
}

export const BUCKETS = ["connected", "pending_unconnected", "crickets", "offers_unconnected", "canceled_unconnected", "operator_closed_unconnected"] as const;

export function conserves(counts: Record<string, number>): boolean {
  return counts.posted === BUCKETS.reduce((sum, bucket) => sum + (counts[bucket] ?? 0), 0);
}

export async function lifetime(party: Party): Promise<Record<string, number>> {
  return (await party.client.reputation(party.subject)).lifetime as Record<string, number>;
}
