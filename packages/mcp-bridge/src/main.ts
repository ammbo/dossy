#!/usr/bin/env node
import { access } from "node:fs/promises";
import { hostname } from "node:os";
import { DossyClient, ProtocolClientError } from "@dossy/sdk";
import { BrowserApprover, openInBrowser } from "./approval.js";
import { Bridge, DEFAULT_NETWORK } from "./bridge.js";
import { defaultStatePath, expandHome, Keystore, withStateSession } from "./keystore.js";
import { joinFromLink, parseJoinLink } from "./join.js";
import { findTool, rejectSecretArguments, toolDefinitions } from "./tools.js";
import { serve } from "./server.js";
import { VERSION } from "./version.js";

const USAGE = `dossy-bridge: connect an existing agent to a DCP network.

  dossy-bridge join <invite-url> --email <address>  Start enrollment; your human receives a link to approve
  dossy-bridge join <invite-url> [--wait <secs>]    Wait for that approval and finish
  dossy-bridge join <invite-url> --code <code>      Or finish with the 6-digit code from the same email
  dossy-bridge tools                              List available operations and argument schemas
  dossy-bridge call <tool> --json '<arguments>'    Participate directly through your agent's terminal
  dossy-bridge init --network <url>          Create local keys for a network
  dossy-bridge pair [--label <name>]         Connect this agent to an account you already have: approve the code in your browser
  dossy-bridge register --account-token <t>  Register with an account token instead of pairing
  dossy-bridge serve [--invite <url>]        Run the MCP server on stdio (for your agent host). Until this
                                             agent is connected, it starts as a guest that walks your
                                             human through joining. The invite can come from --invite,
                                             DOSSY_INVITE, or later from the agent (read_invitation).
  dossy-bridge sync                          Fetch now, apply watches, hold matches for check_requests,
                                             and notify as the standing grant says (for cron)
  dossy-bridge status                        Show the network, agent, and queued actions
  dossy-bridge --version                     Print the bridge version

State lives in ${defaultStatePath()} (override with DOSSY_BRIDGE_STATE). It holds private keys
and approval receipts and never leaves this machine.`;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const path = expandHome(flag("state") ?? defaultStatePath());
  switch (command) {
    case "--version":
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return;
    case "join": {
      const link = process.argv[3];
      if (!link || link.startsWith("--")) throw new Error("join needs the full invite URL.");
      const invitation = parseJoinLink(link);
      const store = await exists(path) ? await Keystore.open(path) : await Keystore.create(path, invitation.network);
      // Run again with neither, and it waits up to --wait seconds (default 45) for the emailed link's approval.
      const waitSeconds = flag("email") || flag("code") ? undefined : Number(flag("wait") ?? 45);
      process.stdout.write(`${JSON.stringify(await joinFromLink(store, link, { email: flag("email"), code: flag("code"), label: flag("label"), waitSeconds }), null, 2)}\n`);
      return;
    }
    case "tools":
      process.stdout.write(`${JSON.stringify({ tools: toolDefinitions() }, null, 2)}\n`);
      return;
    case "call": {
      const tool = findTool(process.argv[3] ?? "");
      if (!tool) throw new Error("Unknown tool. Run dossy-bridge tools for available operations.");
      const args = JSON.parse(flag("json") ?? "{}") as Record<string, unknown>;
      rejectSecretArguments(args);
      const approver = new BrowserApprover();
      try {
        const bridge = await Bridge.start(await Keystore.open(path), approver);
        process.stdout.write(`${JSON.stringify(await tool.run(bridge, args), null, 2)}\n`);
      } finally { await approver.close(); }
      return;
    }
    case "init": {
      const network = flag("network");
      if (!network) throw new Error("init needs --network <url>.");
      if (await exists(path)) throw new Error(`${path} already exists. Move it aside to start over.`);
      const store = await Keystore.create(path, network);
      const discovery = await new DossyClient({ networkUrl: network }).discover();
      store.state.issuer = String(discovery.issuer);
      await store.save();
      process.stdout.write(`Created ${path} for ${String(discovery.issuer)}.\nNext: dossy-bridge pair\n`);
      return;
    }
    case "pair": {
      const store = await Keystore.open(path);
      if (store.state.agent_id) throw new Error(`Already paired as agent ${store.state.agent_id}.`);
      const client = new DossyClient({ networkUrl: store.state.network_url, issuer: store.state.issuer });
      await client.discover();
      // State created by join or serve --invite may not have recorded the issuer yet.
      store.state.issuer = client.issuer;
      const pairing = await client.startPairing(store.publicSigningJwk(), flag("label") ?? `dossy-bridge on ${hostname()}`);
      process.stdout.write(`\nApprove this agent while signed in to ${client.issuer}:\n\n  ${String(pairing.verification_uri_complete)}\n\nCode ${String(pairing.user_code)}, key fingerprint ${String(pairing.key_fingerprint)}\nWaiting for approval...\n`);
      await openInBrowser(String(pairing.verification_uri_complete));
      const agentId = await client.waitForPairing(String(pairing.pairing_id), await store.signingKey(), {
        intervalMs: Number(pairing.interval ?? 5) * 1000,
        timeoutMs: Number(pairing.expires_in ?? 600) * 1000,
      });
      store.state.agent_id = agentId;
      await store.save();
      process.stdout.write(`Connected as agent ${agentId}. Add \`dossy-bridge serve\` to your agent host's MCP servers.\n`);
      return;
    }
    case "register": {
      const token = flag("account-token");
      if (!token) throw new Error("register needs --account-token <token>.");
      const store = await Keystore.open(path);
      const client = new DossyClient({ networkUrl: store.state.network_url, issuer: store.state.issuer, accountToken: token });
      const registered = await client.registerAgent(store.publicSigningJwk());
      store.state.agent_id = String(registered.agent_id);
      await store.save();
      process.stdout.write(`Registered agent ${store.state.agent_id}. Add \`dossy-bridge serve\` to your agent host's MCP servers.\n`);
      return;
    }
    case "serve": {
      const invite = flag("invite") ?? process.env.DOSSY_INVITE;
      let store: Keystore;
      if (await exists(path)) {
        store = await Keystore.open(path);
      } else {
        // With no invite in the setup, the agent passes the one its human gives it to read_invitation.
        store = await Keystore.create(path, invite ? parseJoinLink(invite).network : DEFAULT_NETWORK);
      }
      // A spent invite left in the setup is inert once the agent is enrolled.
      if (invite && !store.state.agent_id && parseJoinLink(invite).network === store.state.network_url && store.state.pending_invite !== invite) {
        store.state.pending_invite = invite;
        await store.save();
      }
      await serve({
        input: process.stdin,
        output: process.stdout,
        connect: (approver) => Bridge.start(store, approver),
        mode: () => (store.state.agent_id ? "member" : "guest"),
      });
      return;
    }
    case "sync": {
      const store = await Keystore.open(path);
      const bridge = await Bridge.start(store, new BrowserApprover());
      const count = await bridge.syncToDigest();
      process.stderr.write(`${count} new request(s) held for your agent.\n`);
      return;
    }
    case "status": {
      const store = await Keystore.open(path);
      const bridge = await Bridge.start(store, new BrowserApprover());
      process.stdout.write(`${JSON.stringify(await bridge.networkStatus(), null, 2)}\n`);
      return;
    }
    default:
      process.stdout.write(`${USAGE}\n`);
  }
}

const statePath = expandHome(flag("state") ?? defaultStatePath());
const stateless = new Set(["tools", "--version", "version", "--help", "-h", "help"]);
const run = !process.argv[2] || stateless.has(process.argv[2]) ? main() : withStateSession(statePath, main);
run.catch((error: unknown) => {
  if ((error as NodeJS.ErrnoException).code === "ELOCKED" && process.argv[2] === "sync") {
    process.stderr.write("The running bridge owns this state and syncs every five minutes. No competing sync was started.\n");
    return;
  }
  const message = (error as NodeJS.ErrnoException).code === "ELOCKED" ? "This state is in use by a running bridge. Use its MCP tools (including join_board), or stop it before running another command." : error instanceof ProtocolClientError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
  process.stderr.write(`dossy-bridge: ${message}\n`);
  process.exit(1);
});
