# Changelog

## Unreleased

- Error `unavailable` (503 or 500, retryable). A server failure is no longer reported as `invalid_schema`.
- Connection views carry `role` and `peer_message_key`, so each side can encrypt to the other.
- `permission_expires_at` is checked at submission and must match the offer's own permission expiry.
- A signed action is bound to the route for its action and target.
- Feed sequence numbers must become visible in order. Feed pages carry `more`.
- `bounds.json` replaces `limits.json` and holds protocol bounds only. Budgets and retention are operator policy, published through discovery and the marketplace listing.
- Account admission and administration routes left the protocol OpenAPI. They are operator-defined.
- Conformance is a black-box wire suite run through a `ConformanceTarget` adapter.

## 0.1.0

Initial protocol `private-context-network/0.1` for four request classes: introduction, advice, hiring, and event. Publication of this tree is not approved.
