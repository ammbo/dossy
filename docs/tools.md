# Bridge tool reference

Use these operations through MCP or `node /absolute/path/to/dossy-bridge.mjs call <tool> --json '<arguments>'`. This reference is generated from the bundled bridge's tool definitions at build time. Run `tools` against your installed bridge to check that version's schemas.

## Permissions at a glance

Read operations make authenticated network calls, but they do not publish a response or record reader history in a conforming network. They may also retry previously approved queued actions when the bridge starts. Check `network_status` for the outbox.

Publishing, offering, accepting, confirming, messaging, withdrawing, revoking authority, and reporting show a separate human approval. `join_community` redeems a secret invitation under the human's explicit instruction; it is not a content-disclosure approval prompt. Account administration is outside these model tools.

## Drafting requests

Call `get_vocabulary` first and `network_status` for the marketplace ID and budget. The bridge fills in protocol identifiers, a fresh public reply key, expiry, and signed authorization.

| Class | Criteria | Terms | Optional offer content | Connections |
| --- | --- | --- | --- | --- |
| `advice` | `required_tags` | `experience_sought` | `experience_summary`, `skill_tags` | 1 |
| `introduction` | `target_ref`; optional `required_tags` | `purpose` | `introduction_scope`, `experience_summary` | 1 |
| `hiring` | `required_tags`, `locations`, `work_mode` | `purpose`; optional `available_by`, `compensation` | `available_from`, `skill_tags` | 1–25 |
| `event` | Optional `required_tags`, `locations` | `title`, `starts_at`, `ends_at`, `format`, `purpose`, `response_deadline`; optional `location` | None beyond `interest` | 1–100 |

Every offer includes `interest: true`. The request chooses which additional fields to allow. Locations in criteria use `loc:nyc`-style identifiers; descriptive tags use `location:nyc`. Hiring `work_mode` is an array of `remote`, `hybrid`, and/or `onsite`. Event `format` is `online` or `in_person`.

Request lifetime defaults to seven days, with a one-hour minimum and 30-day maximum. Event expiry uses `response_deadline`, which must precede the event start. Notes allow 512 characters; offer summaries allow 280. The [bounds file](/bounds.json), [schemas](/openapi.yaml), and [specification](/spec) define all constraints.

## Operations

The sections below include each tool's complete JSON input schema. An argument marked required must be supplied. Nested request criteria and terms are further constrained by the class schemas above.
