import { schemas } from "@dossy/protocol";
import { Ajv2020 as Ajv, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  canonicalByteLength,
  codePointLength,
  loadBounds,
  loadVocabulary,
  type Bounds,
} from "./protocol.js";

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

let validator: Ajv | undefined;

export function ajv(): Ajv {
  if (!validator) {
    validator = new Ajv({ strict: false, allErrors: true, validateSchema: false });
    (addFormats as unknown as (instance: Ajv) => void)(validator);
    for (const schema of Object.values(schemas)) validator.addSchema(schema);
  }
  return validator;
}

export function assertSchema(id: string, data: unknown): void {
  const validate = ajv().getSchema(id) as ValidateFunction | undefined;
  if (!validate) throw new Error(`Missing schema ${id}.`);
  if (validate(data)) return;
  const detail = (validate.errors ?? [])
    .slice(0, 4)
    .map((error: ErrorObject) => `${error.instancePath || "/"} ${error.keyword}`)
    .join("; ");
  throw new SchemaError(detail || "invalid");
}

type RequestDocument = {
  protocol: string;
  class: string;
  tags: string[];
  criteria: Record<string, unknown>;
  terms: Record<string, unknown>;
  expires_at: string;
  max_connections: number;
  offer_schema: { required: string[]; allowed: string[] };
  note?: string;
  reply_key: Record<string, unknown>;
};

export function validateRequestDocument(data: unknown, limits: Bounds = loadBounds(), now?: Date): asserts data is RequestDocument {
  assertSchema("https://dossy.dev/schemas/request-document.json", data);
  const doc = data as RequestDocument;
  if (canonicalByteLength(doc) > limits.document_max_bytes) {
    throw new SchemaError("Document exceeds 8 KiB.");
  }
  if (doc.note !== undefined && codePointLength(doc.note) > limits.note_max_chars) {
    throw new SchemaError("Note exceeds 512 characters.");
  }
  const classLimits = limits.classes[doc.class];
  if (!classLimits) throw new SchemaError("Class is not enabled.");
  const required = (doc.criteria.required_tags as string[] | undefined) ?? [];
  for (const tag of required) {
    if (!doc.tags.includes(tag)) throw new SchemaError("Required tag is missing from tags.");
  }
  if (!doc.offer_schema.allowed.includes("interest") || doc.offer_schema.required[0] !== "interest") {
    throw new SchemaError("Offer schema must require interest.");
  }
  for (const field of doc.offer_schema.allowed) {
    if (!classLimits.offer_fields.includes(field)) throw new SchemaError("Offer field is not allowed for this class.");
  }
  if (doc.max_connections > classLimits.max_connections_cap || doc.max_connections < 1) {
    throw new SchemaError("Connection cap is outside the class bound.");
  }
  if ("d" in doc.reply_key || doc.reply_key.use === "sig") throw new SchemaError("Reply key must be an encryption public key.");
  if (doc.class === "event") {
    const deadline = Date.parse(String(doc.terms.response_deadline));
    const start = Date.parse(String(doc.terms.starts_at));
    const expires = Date.parse(doc.expires_at);
    if (!(deadline < start) || deadline !== expires) {
      throw new SchemaError("Event response deadline must equal expiry and precede the start.");
    }
  }
  if (now) {
    const expires = Date.parse(doc.expires_at);
    const delta = expires - now.getTime();
    if (delta < limits.request_min_seconds * 1000 || delta > limits.request_max_seconds * 1000) {
      throw new SchemaError("Request expiry is outside the allowed window.");
    }
  }
}

export function knownTagIds(): Set<string> {
  return new Set(loadVocabulary().tags.map((tag) => tag.id));
}
