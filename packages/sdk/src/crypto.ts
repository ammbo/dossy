import {
  CompactEncrypt,
  CompactSign,
  compactDecrypt,
  compactVerify,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
} from "jose";
import { canonicalJson } from "./protocol.js";

export type PublicJwk = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  use?: "enc" | "sig";
  alg?: string;
  kid?: string;
};

export type PcnHeader = {
  origin: string;
  request_id: string;
  request_digest: string;
  offer_id?: string;
  connection_id?: string;
  sender_role: "requester" | "responder";
  message_type: "offer" | "clarification" | "handoff";
  operation_id: string;
  exp: string;
};

export async function generateSigningPair(): Promise<{ publicJwk: PublicJwk; privateKey: CryptoKey }> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    publicJwk: { ...(jwk as PublicJwk), use: "sig", alg: "ES256", kty: "EC", crv: "P-256" },
    privateKey,
  };
}

export async function generateEncryptionPair(): Promise<{ publicJwk: PublicJwk; privateKey: CryptoKey }> {
  const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    publicJwk: { ...(jwk as PublicJwk), use: "enc", alg: "ECDH-ES", kty: "EC", crv: "P-256" },
    privateKey,
  };
}

export function assertPublicEncryptionKey(jwk: Record<string, unknown>): void {
  if ("d" in jwk) throw new Error("Encryption key must be public.");
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") throw new Error("Encryption key must be P-256.");
  if (jwk.use === "sig" || jwk.alg === "ES256") throw new Error("Signing keys cannot encrypt.");
}

export function assertPublicSigningKey(jwk: Record<string, unknown>): void {
  if ("d" in jwk) throw new Error("Signing key must be public.");
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") throw new Error("Signing key must be P-256.");
  if (jwk.use === "enc") throw new Error("Encryption keys cannot sign actions.");
}

export async function importSigningKey(jwk: PublicJwk | JWK, extractable = false): Promise<CryptoKey> {
  return (await importJWK({ ...jwk, alg: "ES256" }, "ES256", { extractable })) as CryptoKey;
}

export async function importEncryptionKey(jwk: PublicJwk | JWK): Promise<CryptoKey> {
  assertPublicEncryptionKey(jwk as Record<string, unknown>);
  return (await importJWK(jwk, "ECDH-ES")) as CryptoKey;
}

export async function signClaims(privateKey: CryptoKey, kid: string, claims: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(claims));
  return new CompactSign(bytes).setProtectedHeader({ alg: "ES256", kid, typ: "JWT" }).sign(privateKey);
}

export async function verifyClaims(
  jws: string,
  publicKey: CryptoKey,
  now: Date,
  maxLifetimeSeconds: number,
): Promise<Record<string, unknown>> {
  const { payload, protectedHeader } = await compactVerify(jws, publicKey);
  if (protectedHeader.alg !== "ES256") throw new Error("Unexpected signature algorithm.");
  const claims = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
  const iat = claims.iat;
  const exp = claims.exp;
  const nowSec = Math.floor(now.getTime() / 1000);
  if (typeof iat !== "number" || typeof exp !== "number") throw new Error("Envelope time is invalid.");
  if (exp < nowSec) throw new Error("Envelope is expired.");
  if (iat > nowSec + 60) throw new Error("Envelope issued-at is in the future.");
  if (exp - iat > maxLifetimeSeconds) throw new Error("Envelope lifetime exceeds the maximum.");
  return claims;
}

export async function encryptJson(publicJwk: PublicJwk, plaintext: unknown, pcn: PcnHeader): Promise<string> {
  assertPublicEncryptionKey(publicJwk as unknown as Record<string, unknown>);
  const key = await importEncryptionKey(publicJwk);
  const bytes = new TextEncoder().encode(JSON.stringify(plaintext));
  return new CompactEncrypt(bytes)
    .setProtectedHeader({ alg: "ECDH-ES", enc: "A256GCM", pcn })
    .encrypt(key);
}

export async function decryptJson<T>(privateKey: CryptoKey, jwe: string, expected: PcnHeader): Promise<T> {
  const { plaintext, protectedHeader } = await compactDecrypt(jwe, privateKey);
  if (protectedHeader.alg !== "ECDH-ES" || protectedHeader.enc !== "A256GCM") {
    throw new Error("Unexpected encryption algorithm.");
  }
  const pcn = protectedHeader.pcn as PcnHeader | undefined;
  if (!pcn) throw new Error("Missing payload binding.");
  for (const key of Object.keys(expected) as (keyof PcnHeader)[]) {
    if (expected[key] !== undefined && pcn[key] !== expected[key]) {
      throw new Error(`Payload binding mismatch for ${key}.`);
    }
  }
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
