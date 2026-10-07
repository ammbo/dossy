import type { Clock, DossyClient, PublicJwk } from "@dossy/sdk";

export type KeyPair = { publicJwk: PublicJwk; privateKey: CryptoKey };

/** An admitted principal with one registered agent, ready to act. */
export type Party = {
  /** Holds an agent access token and, for account calls such as revoke_agent, an account token. */
  client: DossyClient;
  signing: KeyPair;
  /** The party's default encryption key pair. Tests may also generate fresh ones. */
  encryption: KeyPair;
  agentId: string;
  /** The reputation subject the network assigned to this principal. */
  subject: string;
};

/**
 * What a network under test provides to the wire suite. Everything else happens over the
 * protocol's HTTPS contract. Admission and account administration are operator-defined, so the
 * target supplies them. Optional members unlock tests that need control of time or paging; tests
 * that need a missing member are skipped.
 */
export interface ConformanceTarget {
  readonly name: string;
  /** The issuer from discovery. Clients sign with it. */
  readonly issuer: string;
  /** A marketplace every enrolled party is admitted to, with the four launch classes enabled. */
  readonly marketplaceId: string;
  /** The clock clients sign with. It must track the network's clock. */
  readonly clock: Clock;
  /** Admits a new principal to `marketplaceId` and registers one agent for it. */
  enroll(label: string): Promise<Party>;
  /** Moves the network's clock forward. Test networks only. */
  advanceTime?(ms: number): Promise<void>;
  /** Shrinks list page sizes so paging paths run with few requests. */
  setPageSize?(size: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Loads the target module named by PCN_CONFORMANCE_TARGET. The module exports
 * `createTarget(): Promise<ConformanceTarget>`. Returns undefined when no target is configured.
 */
export async function loadTarget(): Promise<ConformanceTarget | undefined> {
  const spec = typeof process === "undefined" ? undefined : process.env.PCN_CONFORMANCE_TARGET;
  if (!spec) return undefined;
  const module = (await import(spec)) as { createTarget(): Promise<ConformanceTarget> };
  return module.createTarget();
}
