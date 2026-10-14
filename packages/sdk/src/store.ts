export type SeenRecord = { digest: string; state: string; prompted: boolean; boardId?: string };

export type BoardCursor = {
  phase: "snapshot" | "feed";
  snapshotCursor?: string;
  feedCursor?: string;
};

export type Gap = { boardId: string; at: string; detail: string };

export type OutboxItem = {
  operationId: string;
  payloadDigest: string;
  ciphertext: string;
  path: string;
};

/** Local discovery state: position per board, deduplication, and gaps to tell the human about. */
export interface SyncStore {
  cursors: Record<string, BoardCursor>;
  seen: Record<string, SeenRecord>;
  gaps: Gap[];
}

export class MemoryStore implements SyncStore {
  cursors: Record<string, BoardCursor> = {};
  seen: Record<string, SeenRecord> = {};
  gaps: Gap[] = [];
  outbox: OutboxItem[] = [];
}
