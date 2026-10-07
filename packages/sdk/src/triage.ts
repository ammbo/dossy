import { PROTOCOL, type Vocabulary } from "./protocol.js";

export type RequestView = {
  protocol: string;
  class: string;
  tags: string[];
  criteria?: { required_tags?: string[]; work_mode?: string[]; locations?: string[] };
  terms?: { starts_at?: string };
};

export type LocalRules = {
  blockTags?: string[];
  workModes?: string[];
  notBefore?: string;
  notAfter?: string;
};

export type TriageResult =
  | { action: "skip"; reason: "unsupported_protocol" | "unsupported_class" | "cheap_filter" }
  | { action: "abstain"; reason: "unknown_required_tag" }
  | { action: "private_evaluation"; unknownDescriptiveTags: string[] }
  | { action: "decline" };

const CLASSES = new Set(["introduction", "advice", "hiring", "event"]);

export function triage(request: RequestView, vocabulary: Vocabulary, rules: LocalRules = {}): TriageResult {
  if (request.protocol !== PROTOCOL) return { action: "skip", reason: "unsupported_protocol" };
  if (!CLASSES.has(request.class) || !vocabulary.classes[request.class]) {
    return { action: "skip", reason: "unsupported_class" };
  }
  const known = new Set(vocabulary.tags.map((tag) => tag.id));
  const required = request.criteria?.required_tags ?? [];
  if (required.some((tag) => !known.has(tag))) return { action: "abstain", reason: "unknown_required_tag" };
  if (rules.blockTags?.some((tag) => request.tags.includes(tag))) return { action: "skip", reason: "cheap_filter" };
  const modes = request.criteria?.work_mode;
  if (modes && rules.workModes && !modes.some((mode) => rules.workModes?.includes(mode))) {
    return { action: "skip", reason: "cheap_filter" };
  }
  const start = request.terms?.starts_at;
  if (start && rules.notBefore && start < rules.notBefore) return { action: "skip", reason: "cheap_filter" };
  if (start && rules.notAfter && start > rules.notAfter) return { action: "skip", reason: "cheap_filter" };
  const unknownDescriptiveTags = request.tags.filter((tag) => !known.has(tag) && !required.includes(tag));
  return { action: "private_evaluation", unknownDescriptiveTags };
}

export function localDecline(): TriageResult {
  return { action: "decline" };
}
