/**
 * A watch lives in the agent's runtime: a deterministic filter the bridge applies to every
 * fetched request without a model call, plus a plain-language intent for the model when it
 * matches. Nothing here is sent to the network.
 */
export type Watch = {
  name: string;
  /** Only these boards, or any board when omitted. */
  boards?: string[];
  classes?: string[];
  /** At least one of these tags. */
  tags_any?: string[];
  /** At least one of these words or phrases, case-insensitively, anywhere in the request's text. */
  keywords_any?: string[];
  /** For events: only those starting inside this window (ISO dates or timestamps). */
  starts_after?: string;
  starts_before?: string;
  /** What the human is looking for, in their words. For the model, never for the network. */
  intent: string;
};

type Viewed = { board_id?: unknown; document?: Record<string, unknown> } & Record<string, unknown>;

/** Every piece of text a request carries, lowercased, for keyword matching. */
export function requestText(request: Viewed): string {
  const document = (request.document ?? request) as Record<string, unknown>;
  const parts: unknown[] = [document.board_id, document.class, document.tags, document.terms, document.note, (document.requester_display as Record<string, unknown> | undefined)?.label];
  return JSON.stringify(parts).toLowerCase();
}

/** Whether a fetched request matches a watch. Pure: no I/O, no network, no model. */
export function matchWatch(request: Viewed, watch: Watch): boolean {
  const document = (request.document ?? request) as Record<string, unknown>;
  const board = String(document.board_id ?? request.board_id ?? "");
  if (watch.boards?.length && !watch.boards.includes(board)) return false;
  if (watch.classes?.length && !watch.classes.includes(String(document.class))) return false;
  const tags = (document.tags as string[] | undefined) ?? [];
  if (watch.tags_any?.length && !watch.tags_any.some((tag) => tags.includes(tag))) return false;
  if (watch.keywords_any?.length) {
    const text = requestText(request);
    if (!watch.keywords_any.some((word) => word.trim() && text.includes(word.trim().toLowerCase()))) return false;
  }
  const starts = (document.terms as Record<string, unknown> | undefined)?.starts_at;
  if ((watch.starts_after || watch.starts_before) && typeof starts !== "string") return false;
  if (typeof starts === "string") {
    if (watch.starts_after && Date.parse(starts) < Date.parse(watch.starts_after)) return false;
    if (watch.starts_before && Date.parse(starts) > Date.parse(watch.starts_before)) return false;
  }
  return true;
}

/** Ranks fetched requests against a search the human asked for, entirely in the runtime. */
export function searchRequests<T extends Viewed>(requests: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 1);
  if (words.length === 0) return requests;
  return requests
    .map((request) => {
      const text = requestText(request);
      return { request, score: words.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0) };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.request);
}
