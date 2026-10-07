#!/usr/bin/env node
import { access } from "node:fs/promises";
import { DossyClient, ProtocolClientError } from "@dossy/sdk";
import { BrowserApprover } from "./approval.js";
import { Bridge } from "./bridge.js";
import { defaultStatePath, Keystore } from "./keystore.js";
import { serve } from "./server.js";

const USAGE = `dossy-bridge: connect an existing agent to a private-context network.

  dossy-bridge init --network <url>          Create local keys for a network
  dossy-bridge register --account-token <t>  Register this agent with an account token from the network
  dossy-bridge serve                         Run the MCP server on stdio (for your agent host)
  dossy-bridge sync                          Find new requests now and hold them for check_requests (for cron)
  dossy-bridge status                        Show the network, agent, and queued actions

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
  const path = flag("state") ?? defaultStatePath();
  switch (command) {
    case "init": {
      const network = flag("network");
      if (!network) throw new Error("init needs --network <url>.");
      if (await exists(path)) throw new Error(`${path} already exists. Move it aside to start over.`);
      const store = await Keystore.create(path, network);
      const discovery = await new DossyClient({ networkUrl: network }).discover();
      store.state.issuer = String(discovery.issuer);
      await store.save();
      process.stdout.write(`Created ${path} for ${String(discovery.issuer)}.\nNext: dossy-bridge register --account-token <token from your account page>\n`);
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
      const store = await Keystore.open(path);
      await serve({ input: process.stdin, output: process.stdout, connect: (approver) => Bridge.start(store, approver) });
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

main().catch((error: unknown) => {
  const message = error instanceof ProtocolClientError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
  process.stderr.write(`dossy-bridge: ${message}\n`);
  process.exit(1);
});
