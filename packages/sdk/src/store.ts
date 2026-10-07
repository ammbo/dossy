export type SeenRecord = { digest: string; state: string; prompted: boolean; marketplaceId?: string };

export type MarketCursor = {
  phase: "snapshot" | "feed";
  snapshotCursor?: string;
  feedCursor?: string;
};

export type Gap = { marketplaceId: string; at: string; detail: string };

export type OutboxItem = {
  operationId: string;
  payloadDigest: string;
  ciphertext: string;
  path: string;
};

export class MemoryStore {
  cursors: Record<string, MarketCursor> = {};
  seen: Record<string, SeenRecord> = {};
  gaps: Gap[] = [];
  outbox: OutboxItem[] = [];
}
