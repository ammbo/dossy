import { ProtocolClientError, type DossyClient } from "./client.js";
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

/**
 * Recovers every still-open request in a marketplace and hands each new one to `onNew` once.
 * Position, deduplication, gaps, and failures stay in the local store. Nothing is reported to the
 * network. A callback that throws leaves its request pending, so the next run offers it again.
 */
export async function syncMarketplace(
  client: DossyClient,
  marketplaceId: string,
  store: SyncStore,
  onNew: (request: Record<string, unknown>) => Promise<void>,
): Promise<SyncResult> {
  const result: RunState = { prompted: 0, failed: 0, attempted: new Set() };
  const done = (): SyncResult => ({ prompted: result.prompted, failed: result.failed });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await syncOnce(client, marketplaceId, store, onNew, result);
      await retryPending(client, marketplaceId, store, onNew, result);
      return done();
    } catch (error) {
      if (error instanceof ProtocolClientError && error.code === "cursor_expired") {
        store.gaps.push({
          marketplaceId,
          at: client.clock.now().toISOString(),
          detail: "Feed cursor expired. Open requests were snapshotted again. Expired requests in the gap were not claimed as considered.",
        });
        delete store.cursors[marketplaceId];
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
  marketplaceId: string,
  store: SyncStore,
  onNew: (request: Record<string, unknown>) => Promise<void>,
  result: RunState,
): Promise<void> {
  const state = { ...(store.cursors[marketplaceId] ?? { phase: "snapshot" as const }) };
  if (state.phase === "snapshot") {
    let cursor = state.snapshotCursor;
    for (;;) {
      const page = await client.listRequests(marketplaceId, cursor) as Page;
      if (page.feed_cursor && !state.feedCursor) state.feedCursor = page.feed_cursor;
      for (const item of page.requests ?? []) await consider(client, marketplaceId, store, item, onNew, result);
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
      store.cursors[marketplaceId] = { ...state, snapshotCursor: cursor };
    }
    state.phase = "feed";
    state.snapshotCursor = undefined;
    store.cursors[marketplaceId] = { ...state };
  }
  for (;;) {
    const feed = await client.listRequests(marketplaceId, state.feedCursor) as Page;
    for (const item of feed.mutations ?? []) await consider(client, marketplaceId, store, item, onNew, result);
    if (feed.next_cursor) state.feedCursor = feed.next_cursor;
    store.cursors[marketplaceId] = { ...state };
    if (!feed.more) break;
  }
}

async function consider(
  client: DossyClient,
  marketplaceId: string,
  store: SyncStore,
  item: Listed,
  onNew: (request: Record<string, unknown>) => Promise<void>,
  result: RunState,
): Promise<void> {
  const full = await client.getRequest(item.request_id);
  const key = `${String(full.origin ?? "")}:${item.request_id}`;
  const digest = String(full.document_digest ?? item.document_digest ?? "");
  const previous = store.seen[key];
  const state = String(full.state ?? item.state);
  if (previous && previous.digest === digest) {
    // Lifecycle changes never prompt twice. An unprompted open request is still owed a prompt.
    previous.state = state;
    if (previous.prompted || state !== "open") return;
  } else {
    store.seen[key] = { digest, state, prompted: false, marketplaceId };
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
  marketplaceId: string,
  store: SyncStore,
  onNew: (request: Record<string, unknown>) => Promise<void>,
  result: RunState,
): Promise<void> {
  for (const [key, record] of Object.entries(store.seen)) {
    if (record.prompted || record.state !== "open" || record.marketplaceId !== marketplaceId) continue;
    const requestId = key.slice(key.lastIndexOf(":") + 1);
    let full: Record<string, unknown>;
    try {
      full = await client.getRequest(requestId);
    } catch (error) {
      if (error instanceof ProtocolClientError && error.status === 404) {
        record.state = "gone";
        continue;
      }
      throw error;
    }
    record.state = String(full.state);
    if (record.state === "open" && String(full.document_digest) === record.digest) await prompt(store, key, full, onNew, result);
  }
}
