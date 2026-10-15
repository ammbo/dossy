import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import lockfile from "proper-lockfile";
import { randomId, type Gap, type FeedCursor, type PublicJwk, type SeenRecord, type SyncStore, type Watch } from "@dossy/sdk";

/** A key the bridge holds for one object, kept until the object can no longer need it. */
export type HeldKey = { jwk: JWK; keep_until: string };

/** A local consent record. It never leaves this machine. */
export type Receipt = {
  at: string;
  action: string;
  object: { type: string; id: string };
  recipient: string;
  payload_digest: string;
  authorization_ref: string;
  disclosure: unknown;
  channel: string;
  approved: boolean;
};

/** An approved action that has not been acknowledged yet. Retried with the same operation id. */
export type PendingSend = {
  operation_id: string;
  method: string;
  args: unknown[];
  queued_at: string;
  keep_until: string;
  /** Local bookkeeping to apply once the network acknowledges the action. */
  effects?: { rename_reply_from?: string; retarget_ref?: string };
  /** `standing` when the human's standing grant covered the action instead of a fresh approval. */
  mode?: "human" | "standing";
};

/**
 * The human's standing grant, collected during onboarding and changed only with their approval.
 * It covers the low-risk actions the network accepts under `standing` authorization, and how the
 * bridge may notify the human. Following boards and watching topics are local and need no grant.
 */
export type StandingGrant = {
  standing_actions: string[];
  notify: { kind: "none" | "desktop" | "command"; command?: string };
  expires_at?: string;
  approved_at: string;
};

/** A request this agent fetched, kept only while open so the human can search what was seen. */
export type FetchedRequest = Record<string, unknown> & { request_id: string; expires_at: string };

export type BridgeState = {
  version: 2;
  revision?: number;
  network_url: string;
  issuer?: string;
  agent_id?: string;
  /** An enrollment waiting for its human. `poll` means they can approve the emailed link instead of reading back the code. */
  enrollment?: { id?: string; expires_at: string; community: Record<string, unknown>; invite_digest: string; fingerprint?: string; poll?: boolean; interval?: number };
  joined_invites?: Record<string, Record<string, unknown>>;
  signing_jwk: JWK;
  keys: {
    /** request_id → the request's reply key. Decrypts offers. */
    reply: Record<string, HeldKey>;
    /** offer_id → the responder's per-offer key. Decrypts messages to the responder. */
    offer: Record<string, HeldKey>;
    /** offer_id → the requester's per-connection message key, created at acceptance. */
    accept: Record<string, HeldKey>;
  };
  cursors: Record<string, FeedCursor>;
  seen: Record<string, SeenRecord>;
  gaps: Gap[];
  outbox: PendingSend[];
  receipts: Receipt[];
  /** Requests found by a scheduled `dossy-bridge sync`, waiting for the next check_requests. */
  digest?: Record<string, unknown>[];
  /** A network invite from the agent's setup, used until enrollment and then ignored. */
  pending_invite?: string;
  /** A guest pairing with the human's existing account, waiting for them to approve it while signed in. */
  pairing?: { id: string; user_code: string; pairing_url: string; key_fingerprint: string; interval: number; expires_at: string };
  grant?: StandingGrant;
  /** A grant the human approved together with joining. It takes effect once this agent is connected. */
  pending_grant?: StandingGrant;
  /** Boards to surface new requests from. Open boards are read through the network feed. */
  followed?: string[];
  watches?: Watch[];
  fetched?: Record<string, FetchedRequest>;
};

const RECEIPT_LIMIT = 500;

export function defaultStatePath(): string {
  return process.env.DOSSY_BRIDGE_STATE ?? join(homedir(), ".dossy", "bridge.json");
}

/**
 * The bridge's local state: private keys, discovery position, the outbox, and consent receipts.
 * It lives in one file readable only by the user. Nothing here is sent to the network.
 */
export class Keystore implements SyncStore {
  private saving: Promise<void> = Promise.resolve();
  private constructor(
    readonly path: string,
    readonly state: BridgeState,
  ) {}

  get cursors() {
    return this.state.cursors;
  }

  get seen() {
    return this.state.seen;
  }

  get gaps() {
    return this.state.gaps;
  }

  static async create(path: string, networkUrl: string): Promise<Keystore> {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const signing = await exportJWK(privateKey);
    const store = new Keystore(path, {
      version: 2,
      network_url: networkUrl.replace(/\/$/, ""),
      signing_jwk: { ...signing, use: "sig", alg: "ES256" },
      keys: { reply: {}, offer: {}, accept: {} },
      cursors: {},
      seen: {},
      gaps: [],
      outbox: [],
      receipts: [],
    });
    await store.save();
    return store;
  }

  static async open(path: string): Promise<Keystore> {
    const state = migrate(JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>, path);
    return new Keystore(path, state);
  }

  /** Writes atomically with owner-only permissions. */
  save(now = new Date()): Promise<void> {
    const operation = this.saving.then(() => this.write(now));
    this.saving = operation.catch(() => {});
    return operation;
  }

  private async write(now: Date): Promise<void> {
    this.prune(now);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await withLock(`${this.path}.write`, { retries: { retries: 20, minTimeout: 20, maxTimeout: 100 } }, async () => {
      let saved: BridgeState | undefined;
      try { saved = JSON.parse(await readFile(this.path, "utf8")) as BridgeState; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if ((saved?.revision ?? 0) !== (this.state.revision ?? 0)) throw new Error("Bridge state changed in another process. Reload it before continuing; no keys were overwritten.");
      this.state.revision = (this.state.revision ?? 0) + 1;
      const temporary = `${this.path}.${randomId(6)}.tmp`;
      await writeFile(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    });
  }

  publicSigningJwk(): PublicJwk {
    const { d: _private, ...rest } = this.state.signing_jwk;
    void _private;
    return { ...(rest as PublicJwk), use: "sig", alg: "ES256" };
  }

  async signingKey(): Promise<CryptoKey> {
    return (await importJWK(this.state.signing_jwk, "ES256")) as CryptoKey;
  }

  /** Creates and holds a fresh encryption key. Every request, offer, and connection gets its own. */
  async newKey(kind: keyof BridgeState["keys"], id: string, keepUntil: string): Promise<PublicJwk> {
    const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { extractable: true });
    this.state.keys[kind][id] = { jwk: await exportJWK(privateKey), keep_until: keepUntil };
    const exported = await exportJWK(publicKey);
    return { ...(exported as PublicJwk), use: "enc", alg: "ECDH-ES" };
  }

  async heldKey(kind: keyof BridgeState["keys"], id: string): Promise<CryptoKey | undefined> {
    const held = this.state.keys[kind][id];
    return held ? ((await importJWK(held.jwk, "ECDH-ES")) as CryptoKey) : undefined;
  }

  record(receipt: Receipt): void {
    this.state.receipts.push(receipt);
  }

  /** The authorization reference this agent used for an object, from its own receipts. */
  authorizationFor(type: string, id: string): string | undefined {
    const granting = new Set(["post_request", "submit_offer", "accept_offer", "confirm_connection"]);
    return [...this.state.receipts].reverse()
      .find((receipt) => receipt.approved && granting.has(receipt.action) && receipt.object.type === type && receipt.object.id === id)?.authorization_ref;
  }

  private prune(now: Date): void {
    const live = (held: { keep_until: string }) => Date.parse(held.keep_until) > now.getTime();
    for (const kind of ["reply", "offer", "accept"] as const) {
      this.state.keys[kind] = Object.fromEntries(Object.entries(this.state.keys[kind]).filter(([, held]) => live(held)));
    }
    this.state.outbox = this.state.outbox.filter(live);
    this.state.receipts = this.state.receipts.slice(-RECEIPT_LIMIT);
    this.state.gaps = this.state.gaps.slice(-100);
    this.state.digest = (this.state.digest ?? []).filter((item) => Date.parse(String(item.expires_at)) > now.getTime()).slice(-200);
    this.state.fetched = Object.fromEntries(Object.entries(this.state.fetched ?? {}).filter(([, item]) => Date.parse(item.expires_at) > now.getTime()).slice(-2000));
  }
}

/** One process owns a state's read/modify/write lifecycle. A running server also schedules sync. */
export async function withStateSession<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withLock(`${path}.session`, { stale: 60_000, retries: 0 }, fn);
}

/**
 * Holds `<name>.lock` while fn runs. proper-lockfile tracks its locks by the locked file's path, not
 * the lockfile's, so the session and write locks name different files: sharing the state's path let
 * a save inside a session replace, then release, the session's lock. A failure in fn wins over a
 * failure to release.
 */
async function withLock<T>(name: string, options: lockfile.LockOptions, fn: () => Promise<T>): Promise<T> {
  const release = await lockfile.lock(name, { ...options, realpath: false, lockfilePath: `${name}.lock` });
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    await release().catch(() => {});
    throw error;
  }
  await release();
  return result;
}

/**
 * Upgrades an older state file in memory. Version 1 named feeds after marketplaces; version 2 keys
 * position and deduplication by feed and adds the grant, follows, watches, and fetched requests.
 */
function migrate(raw: Record<string, unknown>, path: string): BridgeState {
  if (raw.version === 2) return raw as unknown as BridgeState;
  if (raw.version !== 1) throw new Error(`Unsupported bridge state version in ${path}.`);
  const seen = Object.fromEntries(Object.entries((raw.seen ?? {}) as Record<string, Record<string, unknown>>).map(([key, record]) => {
    const { marketplaceId, boardId, ...rest } = record;
    return [key, { ...rest, feed: (rest.feed ?? boardId ?? marketplaceId) as string | undefined }];
  }));
  const gaps = ((raw.gaps ?? []) as Record<string, unknown>[]).map(({ marketplaceId, boardId, ...rest }) => ({ ...rest, feed: String(rest.feed ?? boardId ?? marketplaceId ?? "") }));
  return { ...(raw as unknown as BridgeState), version: 2, seen: seen as BridgeState["seen"], gaps: gaps as BridgeState["gaps"] };
}
