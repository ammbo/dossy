# Changelog

## Unreleased

- Name: Dossy Communication Protocol (DCP). Draft wire identifier is now `dcp/0.1`; this changes the unpublished earlier draft. Canonical discovery is `/.well-known/dcp` and key authentication is `/v0.1/auth/token`. The first implementation retains old path aliases.
- Apache-2.0 license for the public protocol and implementation materials.
- Optional agent-led invitation/enrollment profile: one email confirmation joins a community and registers the local agent key; signed polling and key-based recovery make enrollment resumable.
- Standalone CLI distribution, direct CLI tool calls, compiled SDK packages, automatic polling in the running bridge, and protection against competing state writers.

- Error `unavailable` (503 or 500, retryable). A server failure is no longer reported as `invalid_schema`.
- Connection views carry `role` and `peer_message_key`, so each side can encrypt to the other.
- `permission_expires_at` is checked at submission and must match the offer's own permission expiry.
- A signed action is bound to the route for its action and target.
- Feed sequence numbers must become visible in order. Feed pages carry `more`.
- `bounds.json` replaces `limits.json` and holds protocol bounds only. Budgets and retention are operator policy, published through discovery and the marketplace listing.
- Account admission and administration routes left the protocol OpenAPI. They are operator-defined.
- Conformance is a black-box wire suite run through a `ConformanceTarget` adapter.
- Optional device-style agent pairing (`endpoints.pairing`), with proof of key possession on every poll.

## 0.1.0

Initial protocol `dcp/0.1` for four request classes: introduction, advice, hiring, and event. The hosted network is preparing a closed pilot.
