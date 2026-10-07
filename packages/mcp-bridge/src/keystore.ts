import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import { randomId, type Gap, type MarketCursor, type PublicJwk, type SeenRecord, type SyncStore } from "@dossy/sdk";

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
};

export type BridgeState = {
  version: 1;
  network_url: string;
  issuer?: string;
  agent_id?: string;
  signing_jwk: JWK;
  keys: {
    /** request_id → the request's reply key. Decrypts offers. */
    reply: Record<string, HeldKey>;
    /** offer_id → the responder's per-offer key. Decrypts messages to the responder. */
    offer: Record<string, HeldKey>;
    /** offer_id → the requester's per-connection message key, created at acceptance. */
    accept: Record<string, HeldKey>;
  };
  cursors: Record<string, MarketCursor>;
  seen: Record<string, SeenRecord>;
  gaps: Gap[];
  outbox: PendingSend[];
  receipts: Receipt[];
  /** Requests found by a scheduled `dossy-bridge sync`, waiting for the next check_requests. */
  digest?: Record<string, unknown>[];
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
      version: 1,
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
    const state = JSON.parse(await readFile(path, "utf8")) as BridgeState;
    if (state.version !== 1) throw new Error(`Unsupported bridge state version in ${path}.`);
    return new Keystore(path, state);
  }

  /** Writes atomically with owner-only permissions. */
  async save(now = new Date()): Promise<void> {
    this.prune(now);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomId(6)}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
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
  }
}
