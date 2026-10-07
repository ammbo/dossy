import { bounds, coreVocabulary } from "@dossy/protocol";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import canonicalizeModule from "canonicalize";
import { base64url } from "jose";

// Runtime-neutral: Web Crypto, TextEncoder, and module imports only. No Node built-ins, so the SDK
// also runs in Deno, Bun, browsers, and edge runtimes.

export const PROTOCOL = "dcp/0.1";
export const VOCABULARY = "core/0.1";
export const DEFAULT_POLL_MS = 300_000;

const encoder = new TextEncoder();

// canonicalize is CommonJS. Node hands back the function; some bundlers wrap it in `default`.
const canonicalize = ((canonicalizeModule as unknown as { default?: unknown }).default ?? canonicalizeModule) as (value: unknown) => string | undefined;

export function canonicalJson(value: unknown): string {
  const out = canonicalize(value);
  if (typeof out !== "string") throw new Error("Value cannot be canonicalized.");
  return out;
}

/** Lowercase hex SHA-256 over the UTF-8 bytes of RFC 8785 canonical JSON. */
export function digestJson(value: unknown): string {
  return bytesToHex(sha256(encoder.encode(canonicalJson(value))));
}

export function canonicalByteLength(value: unknown): number {
  return encoder.encode(canonicalJson(value)).length;
}

export function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

export function codePointLength(value: string): number {
  return [...value].length;
}

/** A random opaque identifier: 128 bits, base64url. */
export function randomId(bytes = 16): string {
  return base64url.encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export type ClassBounds = { default_max_connections: number; max_connections_cap: number; offer_fields: string[] };

/** Normative protocol bounds. Operators may tighten budgets; they cannot exceed these. */
export type Bounds = {
  protocol: string;
  vocabulary: string;
  document_max_bytes: number;
  note_max_chars: number;
  summary_max_chars: number;
  label_max_chars: number;
  tags_max: number;
  tag_max_chars: number;
  message_plaintext_max_bytes: number;
  message_ciphertext_max_bytes: number;
  offer_ciphertext_max_bytes: number;
  envelope_max_seconds: number;
  assertion_max_seconds: number;
  confirmation_seconds: number;
  coordination_seconds: number;
  clarifications_per_side: number;
  handoffs_per_side: number;
  request_default_seconds: number;
  request_min_seconds: number;
  request_max_seconds: number;
  offer_default_seconds: number;
  offer_max_seconds: number;
  feed_history_seconds: number;
  poll_default_seconds: number;
  classes: Record<string, ClassBounds>;
};

export type Vocabulary = {
  id: string;
  tags: { id: string; definition: string }[];
  classes: Record<string, { offer_fields: string[]; criteria: string[]; terms: string[] }>;
};

/** A fresh copy of the protocol bounds, safe to tighten locally. */
export function loadBounds(): Bounds {
  return structuredClone(bounds) as Bounds;
}

export function loadVocabulary(): Vocabulary {
  return structuredClone(coreVocabulary) as unknown as Vocabulary;
}

export function nextPollDelay(attempt: number, random = Math.random()): number {
  const factor = attempt <= 0 ? 1 : 2 ** Math.min(attempt, 4);
  const base = DEFAULT_POLL_MS * factor;
  return Math.round(base + base * 0.2 * random);
}
