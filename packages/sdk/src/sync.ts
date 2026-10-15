import { ProtocolClientError, type DossyClient, type FeedOptions } from "./client.js";
import type { SyncStore } from "./store.js";

type Listed = { request_id: string; document_digest?: string; state: string };
type Page = {
  mode: "snapshot" | "feed";
  requests?: Listed[];
  mutations?: Listed[];
  next_cursor?: string | null;
  feed_cursor?: string;
  more?: boolean;
};

export type SyncResult = {
  /** Requests handed to the human-facing callback in this run. */
  prompted: number;
  /** Requests whose callback failed. They stay pending and are offered again next run. */
  failed: number;
};

/** The local key for the network feed's position. A board feed is keyed by its board id. */
export const NETWORK_FEED = "network";

type Lister = (cursor?: string) => Promise<Record<string, unknown>>;
/** Local cache maintenance, including lifecycle changes that must not prompt twice. */
type OnUpdate = (request: Record<string, unknown>) => Promise<void>;

/**
 * Recovers every still-open request on one board and hands each new one to `onNew` once.
 * Position, deduplication, gaps, and failures stay in the local store. Nothing is reported to the
 * network. A callback that throws leaves its request pending, so the next run offers it again.
 */
export async function syncBoard(
  client: DossyClient,
  boardId: string,
  store: SyncStore,
  onNew: (request: Record<string, unknown>) => Promise<void>,
  onUpdate?: OnUpdate,
): Promise<SyncResult> {
  return syncFeed(client, boardId, (cursor) => client.listRequests(boardId, cursor), store, onNew, onUpdate);
}

/**
 * The same recovery over the network feed: every open request on every open board. Matching
 * happens in the caller's runtime; the network learns nothing about what the agent looks for.
 */
export async function syncNetwork(
  client: DossyClient,
  store: SyncStore,
  onNew: (request: Record<string, unknown>) => Promise<void>,
  options: FeedOptions = {},
  onUpdate?: OnUpdate,
): Promise<SyncResult> {
  const key = options.class ? `${NETWORK_FEED}:${options.class}` : NETWORK_FEED;
  return syncFeed(client, key, (cursor) => client.listFeed(cursor, options), store, onNew, onUpdate);
}

async function syncFeed(
  client: DossyClient,
  feed: string,
  list: Lister,
  store: SyncStore,
  onNew: (request: Record<string, unknown>) => Promise<void>,
  onUpdate?: OnUpdate,
): Promise<SyncResult> {
  const result: RunState = { prompted: 0, failed: 0, attempted: new Set() };
  const done = (): SyncResult => ({ prompted: result.prompted, failed: result.failed });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await syncOnce(client, feed, list, store, onNew, result, onUpdate);
      await retryPending(client, feed, store, onNew, result, onUpdate);
      return done();
    } catch (error) {
      if (error instanceof ProtocolClientError && error.code === "cursor_expired") {
        store.gaps.push({
          feed,
          at: client.clock.now().toISOString(),
          detail: "Feed cursor expired. Open requests were snapshotted again. Expired requests in the gap were not claimed as considered.",
        });
        delete store.cursors[feed];
        continue;
      }
      throw error;
    }
  }
  return done();
}

type RunState = SyncResult & { attempted: Set<string> };

async function syncOnce(
  client: DossyClient,
  feed: string,
  list: Lister,
  store: SyncStore,
  onNew: (request: Record<string, unknown>) => Promise<void>,
  result: RunState,
  onUpdate?: OnUpdate,
): Promise<void> {
  const state = { ...(store.cursors[feed] ?? { phase: "snapshot" as const }) };
  if (state.phase === "snapshot") {
    let cursor = state.snapshotCursor;
    for (;;) {
      const page = await list(cursor) as Page;
      if (page.feed_cursor && !state.feedCursor) state.feedCursor = page.feed_cursor;
      for (const item of page.requests ?? []) await consider(client, feed, store, item, onNew, result, onUpdate);
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
      store.cursors[feed] = { ...state, snapshotCursor: cursor };
    }
    state.phase = "feed";
    state.snapshotCursor = undefined;
    store.cursors[feed] = { ...state };
  }
  for (;;) {
    const page = await list(state.feedCursor) as Page;
    for (const item of page.mutations ?? []) await consider(client, feed, store, item, onNew, result, onUpdate);
    if (page.next_cursor) state.feedCursor = page.next_cursor;
    store.cursors[feed] = { ...state };
    if (!page.more) break;
  }
}

async function consider(
  client: DossyClient,
  feed: string,
  store: SyncStore,
  item: Listed,
  onNew: (request: Record<string, unknown>) => Promise<void>,
  result: RunState,
  onUpdate?: OnUpdate,
): Promise<void> {
  // A tombstone for a request this agent never saw needs no fetch.
  if (item.state !== "open" && !Object.keys(store.seen).some((key) => key.endsWith(`:${item.request_id}`))) return;
  let full: Record<string, unknown>;
  try {
    full = await client.getRequest(item.request_id);
  } catch (error) {
    // Hidden, removed, or purged before this agent fetched it.
    if (error instanceof ProtocolClientError && error.status === 404) {
      for (const [key, record] of Object.entries(store.seen)) {
        if (key.endsWith(`:${item.request_id}`)) record.state = "gone";
      }
      await onUpdate?.({ request_id: item.request_id, state: "gone" });
      return;
    }
    throw error;
  }
  await onUpdate?.(full);
  const key = `${String(full.origin ?? "")}:${item.request_id}`;
  const digest = String(full.document_digest ?? item.document_digest ?? "");
  const previous = store.seen[key];
  const state = String(full.state ?? item.state);
  if (previous && previous.digest === digest) {
    // Lifecycle changes never prompt twice. An unprompted open request is still owed a prompt.
    previous.state = state;
    if (previous.prompted || state !== "open") return;
  } else {
    store.seen[key] = { digest, state, prompted: false, feed };
  }
  if (state === "open") await prompt(store, key, full, onNew, result);
}

async function prompt(
  store: SyncStore,
  key: string,
  request: Record<string, unknown>,
  onNew: (request: Record<string, unknown>) => Promise<void>,
  result: RunState,
): Promise<void> {
  const record = store.seen[key];
  if (!record || result.attempted.has(key)) return;
  result.attempted.add(key);
  try {
    await onNew(request);
    record.prompted = true;
    result.prompted += 1;
  } catch {
    // Kept local. The request is offered again on the next run while it stays open.
    result.failed += 1;
  }
}

async function retryPending(
  client: DossyClient,
  feed: string,
  store: SyncStore,
  onNew: (request: Record<string, unknown>) => Promise<void>,
  result: RunState,
  onUpdate?: OnUpdate,
): Promise<void> {
  for (const [key, record] of Object.entries(store.seen)) {
    if (record.prompted || record.state !== "open" || record.feed !== feed) continue;
    const requestId = key.slice(key.lastIndexOf(":") + 1);
    let full: Record<string, unknown>;
    try {
      full = await client.getRequest(requestId);
    } catch (error) {
      if (error instanceof ProtocolClientError && error.status === 404) {
        record.state = "gone";
        await onUpdate?.({ request_id: requestId, state: "gone" });
        continue;
      }
      throw error;
    }
    record.state = String(full.state);
    await onUpdate?.(full);
    if (record.state === "open" && String(full.document_digest) === record.digest) await prompt(store, key, full, onNew, result);
  }
}
