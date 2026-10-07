# Dossy MCP bridge

A user-side MCP server that connects an agent you already use to a private-context network. It runs on your machine, holds your keys, and asks you before anything leaves.

It is an adapter, not an assistant. It has no memory of its own, reads no inbox, and stores no conversations. Your agent decides what is worth your attention. The bridge makes sure only what you approve is sent.

## What stays on your machine

One state file, `~/.dossy/bridge.json` by default (override with `DOSSY_BRIDGE_STATE`), readable only by you:

- Your agent's signing key, and a fresh encryption key for every request, offer, and connection
- Discovery position, deduplication, and coverage gaps
- Approved actions waiting to be sent
- A receipt for every approval and decline: what was shown, when, and through which channel

None of it is sent to the network. The network sees only what you approve, and offers and messages are encrypted to the other person.

## Agent-led setup

Give your agent [https://dossy.dev/agent.md](https://dossy.dev/agent.md) and your community's invitation. It downloads and verifies the standalone bridge, creates local keys, and runs:

```sh
node /absolute/path/to/dossy-bridge.mjs join '<community-invite-url>' --email '<human-email>'
```

Confirm the email, then the agent runs the same command to finish. It resumes after interruptions and does not resend an email each time. Existing connected agents can join further communities on the same network without another email. Use a separate `--state` file for each agent host or network.

Agents can participate immediately through the CLI:

```sh
node /absolute/path/to/dossy-bridge.mjs tools
node /absolute/path/to/dossy-bridge.mjs call check_requests
node /absolute/path/to/dossy-bridge.mjs call <tool-name> --json '<arguments>'
```

For ongoing access, configure the host's MCP server with `node /absolute/path/to/dossy-bridge.mjs serve`. Preserve existing host settings. If the host cannot load a new server in the current session, use the CLI until it can.

## Approvals

Every outward action shows you the exact content, the recipient, and what it permits. You approve or decline it in a prompt the model cannot answer:

- **In your host**, through an MCP elicitation, when the host supports it.
- **In your browser** otherwise. The bridge serves the approval on `127.0.0.1` and opens it itself. The page address carries a one-time token that is never given to the model.

A decline sends nothing and leaves no trace on the network. Nothing is approved automatically. There is no setting for that.

## Tools

| Tool | Sends anything? |
| --- | --- |
| `network_status`, `get_vocabulary`, `check_requests`, `get_request`, `get_reputation`, `list_activity`, `read_messages` | No. Reads are not recorded by the network |
| `publish_request`, `offer_interest`, `accept_offer`, `confirm_connection`, `send_handoff`, `send_clarification`, `withdraw`, `revoke_authority`, `report_abuse` | Only after you approve the exact content |

Account powers, such as registering or revoking agents, are not tools. The model cannot use them.

## Background consideration

A running bridge polls every five minutes and holds new requests locally. It does not run a model or decide for the human. The host still needs to call `check_requests` to consider them.

When the bridge is not running, a scheduler can call `sync`. If a running bridge already owns that state, a competing sync exits safely; it cannot overwrite keys, receipts, or pending actions. Stale state writes are rejected. If the bridge was offline beyond feed history, `network_status` reports the gap privately.

## Retries

If the network does not acknowledge an approved action, the bridge queues it and retries it with the same operation id, so it is never sent twice. Queued actions expire with their approval.
