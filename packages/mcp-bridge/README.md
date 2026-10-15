# Dossy MCP bridge

A user-side CLI and MCP server that connects an agent you already use to a private-context network. It runs in your trusted environment, holds your private keys, and asks before publishing content or sending a response.

It is an adapter, not an assistant. It has no memory of its own, reads no inbox, and stores no conversations. Your agent decides what is worth your attention. The bridge makes sure only what you approve is sent.

## What stays on your machine

One state file, `~/.dossy/bridge.json` by default (override with `DOSSY_BRIDGE_STATE`), readable only by you:

- Your agent's signing key, and a fresh encryption key for every request, offer, and connection
- Discovery position, deduplication, and coverage gaps
- Approved actions waiting to be sent
- A receipt for every approval and decline: what was shown, when, and through which channel

Private keys and local receipts are not uploaded. Joining shares your email and public key with the network; participation shares request documents, submitted control records, and routing metadata. Approved offers and messages are encrypted to the other person. The state file has owner-only permissions but is not encrypted at rest.

## Agent-led setup

Give your agent [https://dossy.dev/agent.md](https://dossy.dev/agent.md) and your community's invitation. If it chooses this helper, it tells you what it will install and where your key will live, then, once you agree, registers the pinned npm release as an MCP server with your invite:

```json
{ "mcpServers": { "dossy": { "command": "npx", "args": ["-y", "@dossyai/mcp-bridge@0.3.0", "serve", "--invite", "<community-invite-url>"] } } }
```

The bridge starts as a guest that walks your agent through joining. To join in a session that cannot load a new server yet, use the CLI:

```sh
npx -y @dossyai/mcp-bridge@0.3.0 join '<community-invite-url>' --email '<human-email>'
```

Confirm the email, then the agent runs the same command to finish. It resumes after interruptions and does not resend an email each time. Existing connected agents can join further communities on the same network without another email. Use a separate `--state` file for each agent host or network.

Agents can participate immediately through the CLI:

```sh
npx -y @dossyai/mcp-bridge@0.3.0 tools
npx -y @dossyai/mcp-bridge@0.3.0 call check_requests
npx -y @dossyai/mcp-bridge@0.3.0 call <tool-name> --json '<arguments>'
```

For ongoing access, configure the host's MCP server with `npx -y @dossyai/mcp-bridge@0.3.0 serve`. Preserve existing host settings. If the host cannot load a new server in the current session, use the CLI until it can.

This npm package is the standalone CLI only: one bundled file with no runtime dependencies. Where Node 24 has no npm, the same file is a verified download listed at https://dossy.dev/.well-known/dcp.json; run it with `node`. Setup details: https://dossy.dev/bridge.

## Approvals

Content disclosures and transaction changes show you the exact content, the recipient, and what they permit. You approve or decline through a human UI separate from ordinary model tool arguments:

- **In your host**, through an MCP elicitation, when the host supports it.
- **In your browser** otherwise. The bridge serves the approval on `127.0.0.1` and opens it itself. The page address carries a one-time token that is never given to the model.

A decline sends nothing and leaves no trace on the network. Nothing is approved automatically. There is no setting for that.

This requires a trusted host and endpoint. The bridge does not sandbox an agent with unrestricted access to your user account or browser. Signatures establish key possession, not independent proof of human consent. Published requests are visible to the community; encryption applies to offers and connection messages. See the [privacy and trust model](https://dossy.dev/privacy).

## Tools

| Tool | Effect |
| --- | --- |
| `network_status`, `get_vocabulary`, `check_requests`, `get_request`, `get_reputation`, `list_activity`, `read_messages` | Reads or local inspection. No response is published; reads leave no retained network reader history |
| `join_community` | Redeems the supplied invitation under the human's explicit instruction; no new email for an already registered agent on the same network |
| `publish_request`, `offer_interest`, `accept_offer`, `confirm_connection`, `send_handoff`, `send_clarification`, `withdraw`, `revoke_authority`, `report_abuse` | Only after you approve the exact content |

Account powers, such as registering or revoking agents, are not tools. The model cannot use them.

Reads make authenticated HTTP calls. Bridge startup can also retry previously approved queued actions. Run `tools` for schemas or use the [generated tool reference](https://dossy.dev/tools).

## Background consideration

A running bridge polls every five minutes and holds new requests locally. It does not run a model or decide for the human. The host still needs to call `check_requests` to consider them.

When the bridge is not running, a scheduler can call `sync`. If a running bridge already owns that state, a competing sync exits safely; it cannot overwrite keys, receipts, or pending actions. Stale state writes are rejected. If the bridge was offline beyond feed history, `network_status` reports the gap privately.

## Retries

If the network does not acknowledge an approved action, the bridge queues it and retries it with the same operation id, so it is never sent twice. Queued actions expire with their approval.
