// Machine-readable protocol data. Imported as modules so the SDK runs without filesystem access.
import bounds from "./bounds.json" with { type: "json" };
import coreVocabulary from "./vocabularies/core-0.1.json" with { type: "json" };
import authorizationEnvelope from "./schemas/authorization-envelope.json" with { type: "json" };
import connectionAccept from "./schemas/connection-accept.json" with { type: "json" };
import discovery from "./schemas/discovery.json" with { type: "json" };
import display from "./schemas/display.json" with { type: "json" };
import error from "./schemas/error.json" with { type: "json" };
import jwkEnc from "./schemas/jwk-enc.json" with { type: "json" };
import jwkSig from "./schemas/jwk-sig.json" with { type: "json" };
import messageClarification from "./schemas/message-clarification.json" with { type: "json" };
import messageHandoff from "./schemas/message-handoff.json" with { type: "json" };
import messageSubmission from "./schemas/message-submission.json" with { type: "json" };
import offerPlaintext from "./schemas/offer-plaintext.json" with { type: "json" };
import offerSchema from "./schemas/offer-schema.json" with { type: "json" };
import offerSubmission from "./schemas/offer-submission.json" with { type: "json" };
import report from "./schemas/report.json" with { type: "json" };
import reputation from "./schemas/reputation.json" with { type: "json" };
import requestAdvice from "./schemas/request-advice.json" with { type: "json" };
import requestDocument from "./schemas/request-document.json" with { type: "json" };
import requestEvent from "./schemas/request-event.json" with { type: "json" };
import requestHiring from "./schemas/request-hiring.json" with { type: "json" };
import requestIntroduction from "./schemas/request-introduction.json" with { type: "json" };
import standingPermission from "./schemas/standing-permission.json" with { type: "json" };
import tagList from "./schemas/tag-list.json" with { type: "json" };

export { bounds, coreVocabulary };

/** Every JSON Schema in this protocol version, keyed by file name. */
export const schemas: Record<string, { $id: string }> = {
  "authorization-envelope.json": authorizationEnvelope,
  "connection-accept.json": connectionAccept,
  "discovery.json": discovery,
  "display.json": display,
  "error.json": error,
  "jwk-enc.json": jwkEnc,
  "jwk-sig.json": jwkSig,
  "message-clarification.json": messageClarification,
  "message-handoff.json": messageHandoff,
  "message-submission.json": messageSubmission,
  "offer-plaintext.json": offerPlaintext,
  "offer-schema.json": offerSchema,
  "offer-submission.json": offerSubmission,
  "report.json": report,
  "reputation.json": reputation,
  "request-advice.json": requestAdvice,
  "request-document.json": requestDocument,
  "request-event.json": requestEvent,
  "request-hiring.json": requestHiring,
  "request-introduction.json": requestIntroduction,
  "standing-permission.json": standingPermission,
  "tag-list.json": tagList,
};
