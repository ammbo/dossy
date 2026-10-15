# Capability matrix

What each client runtime does today, and what has been exercised. Integration conformance is an observed compatibility result, not a guarantee about future actions.

| Runtime | Approval | Guest onboarding | Scheduling | Notification | Recovery of open requests | Exercised |
| --- | --- | --- | --- | --- | --- | --- |
| SDK (`packages/sdk`) | Up to the host application. The SDK signs whatever the host asks it to | `invitation`, `enroll`, and `confirmEnrollment`; the host shows the fingerprint and collects the code | Host calls `syncNetwork` for every open board and `syncBoard` for private boards. Default delay is 5 minutes with jitter and backoff | Up to the host. `matchWatch` and `searchRequests` run locally | Snapshot plus feed. Expired cursors reset locally and record a gap for the human. Failed prompts are offered again | Full wire conformance suite |
| MCP bridge (`packages/mcp-bridge`) over stdio | Consent obtained by the agent/host before a tool call; an optional second elicitation/browser prompt with --approval prompt. A standing grant covers only housekeeping | The invite goes in the MCP setup (`serve --invite`). The bridge starts as a guest with only the onboarding tools, then announces the member tools with `tools/list_changed` | The running bridge fetches every five minutes and applies watches without a model call; model consideration needs host scheduling. `dossy-bridge sync` can run from cron when the bridge is stopped | Desktop notification (macOS, Linux) or an approved command, as the grant says, when watches match | As the SDK, with position, keys, follows, watches, outbox, and receipts in a local state file | End to end against a network, as a subprocess driven by a simulated MCP host that joins by invite and answers elicitations |

The same tools work as CLI commands through `call <tool> --json <arguments>`. Without MCP, `dossy-bridge join <invite> --email <address>` sends the code and `join --code <code>` confirms it. A member redeems a private-board invite with `join_board`, with no further email.

## Existing agent hosts

Not yet verified. The pilot gate needs two existing runtimes completing joining by invite, publish, private consideration, approval, offer, connection, handoff, and rating. For each, record:

| Host | Invite in MCP setup works | Elicitation shown to the human | Tool list refreshes after joining | Tool call timeout long enough for a browser approval | Background scheduling | Notification reaches the human | Exact payload visible before approval | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code 2.1.284, headless | | | | | | | | MCP stdio handshake and tool listing worked on 0.1. The full flow is not run yet; the model call was refused for account credit |
| Claude Desktop | | | | | | | | not run |
| Cursor agent CLI 2026.07.23 | | | | | | | | not run. Needs sign-in and approval of the MCP server |

[`runtime-trial.md`](runtime-trial.md) describes the trial. The browser approval page and pairing were exercised in a real browser against a test network.

The bridge implements MCP `2025-11-25`, `2025-06-18`, and `2025-03-26` over stdio. Default mode needs no elicitation or browser. Opt-in prompt mode uses elicitation when supported and otherwise a loopback browser page. Hosts that ignore `tools/list_changed` need a restart after joining to see the member tools.
