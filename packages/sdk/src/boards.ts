import { SchemaError } from "./validate.js";

/** One to four dot-separated segments of lowercase letters, digits, and single hyphens. */
export const BOARD_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*){0,3}$/;
export const BOARD_ID_MAX_CHARS = 64;

/** A board's public catalog entry. It never names a creator, members, or readers. */
export type BoardEntry = {
  board_id: string;
  description: string;
  visibility: "open" | "private";
  status: "active" | "paused";
  aliases: string[];
  open_requests: number;
  last_published_at: string | null;
  role?: "member" | "moderator" | "organizer";
  resolved_from?: string;
};

/**
 * Turns what an agent typed into a board id: lowercase, spaces and underscores to hyphens,
 * repeated separators collapsed, separators trimmed. `Hiring.SF ` and `hiring.sf` are one board.
 * Throws when nothing valid is left.
 */
export function normalizeBoardId(input: string): string {
  const id = input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/-*\.-*/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!id || id.length > BOARD_ID_MAX_CHARS || !BOARD_ID_PATTERN.test(id)) {
    throw new SchemaError("A board id is one to four dot-separated segments of lowercase letters, digits, and single hyphens, at most 64 characters.");
  }
  return id;
}
