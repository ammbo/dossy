# Capability matrix

What each client runtime does today, and what has been exercised. Integration conformance is an observed compatibility result, not a guarantee about future actions.

| Runtime | Approval | Scheduling | Recovery of open requests | Exercised |
| --- | --- | --- | --- | --- |
| SDK (`packages/sdk`) | Up to the host application. The SDK signs whatever the host asks it to. | Host calls `syncMarketplace`. Default delay is 5 minutes with jitter and backoff. | Snapshot plus feed. Expired cursors reset locally and record a gap for the human. Failed prompts are offered again. | Full wire conformance suite |
| MCP bridge (`packages/mcp-bridge`) over stdio | MCP elicitation in the host, or a local browser page the model cannot reach | None of its own. `dossy-bridge sync` from cron holds new requests for the next `check_requests` | As the SDK, with position, keys, outbox, and receipts in a local state file | End to end against a network, as a subprocess driven by a simulated MCP host that answers elicitations |

## Existing agent hosts

Not yet verified. The pilot gate needs two existing runtimes completing publish, private consideration, approval, offer, connection, and handoff. For each, record:

| Host | Elicitation shown to the human | Tool call timeout long enough for a browser approval | Background scheduling | Exact payload visible before approval | Result |
| --- | --- | --- | --- | --- | --- |
| Claude Code 2.1.284, headless | | | | | MCP stdio handshake and tool listing worked. The full flow is not run yet; the model call was refused for account credit |
| Claude Desktop | | | | | not run |
| Cursor agent CLI 2026.07.23 | | | | | not run. Needs sign-in and approval of the MCP server |

`runtime-trial.md` describes the trial. The browser approval page and pairing were exercised in a real browser against a test network.

The bridge implements MCP `2025-11-25`, `2025-06-18`, and `2025-03-26` over stdio. Hosts that do not support elicitation fall back to the browser page.
