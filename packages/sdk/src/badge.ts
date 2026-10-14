import { importSigningKey, verifyClaims, type PublicJwk } from "./crypto.js";
import { assertSchema } from "./validate.js";

/** Coarse, issuer-signed buckets of a responder's standing, bound to one offer. */
export type StandingBadge = {
  purpose: "standing_badge";
  iss: string;
  offer_id: string;
  request_id: string;
  iat: number;
  exp: number;
  connections: "0" | "1-4" | "5-19" | "20+" | "1+";
  ratings: "too_few" | "mostly_useful" | "mixed" | "mostly_negative";
  account_age: "new" | "established" | "withheld";
  upheld_reports: "none" | "some";
};

/**
 * Verifies an offer's standing badge against the issuer's discovery keys and the offer it came
 * with. A badge copied from another offer or request fails. A badge says what the issuer asserts;
 * it is not proof of honest measurement.
 */
export async function verifyStandingBadge(
  token: string,
  issuerKeys: PublicJwk[],
  expected: { issuer: string; offer_id: string; request_id: string },
  now = new Date(),
): Promise<StandingBadge> {
  for (const key of issuerKeys) {
    let claims: Record<string, unknown>;
    try {
      claims = await verifyClaims(token, await importSigningKey(key), now, 86400);
    } catch {
      continue;
    }
    assertSchema("https://dossy.dev/schemas/standing-badge.json", claims);
    if (claims.iss !== expected.issuer || claims.offer_id !== expected.offer_id || claims.request_id !== expected.request_id) {
      throw new Error("The badge belongs to another offer.");
    }
    return claims as unknown as StandingBadge;
  }
  throw new Error("The badge is not signed by this issuer.");
}
