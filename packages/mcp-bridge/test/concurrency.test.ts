import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { Keystore, trySyncLease } from "../src/keystore.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
type Rpc = { id?: number | string; method?: string; result?: Record<string, any>; error?: unknown };

function launch(args: string[]) {
  const child = spawn(process.execPath, ["--import", "tsx", ...args], { cwd: packageDir, env: { ...process.env, DOSSY_BROWSER: "none" } });
  const inbox: Rpc[] = [];
  let stderr = "", stdout = "", buffer = "", id = 0;
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.stdout.setEncoding("utf8").on("data", chunk => {
    stdout += chunk;
    buffer += chunk;
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try { inbox.push(JSON.parse(line)); } catch { /* CLI output may be pretty JSON. */ }
    }
  });
  const exit = new Promise<number | null>(resolve => child.on("close", resolve));
  return {
    child, exit, inbox,
    get stderr() { return stderr; },
    get stdout() { return stdout; },
    send(message: unknown) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message as object })}\n`); },
    async call(method: string, params: Record<string, unknown> = {}) {
      const callId = ++id;
      this.send({ id: callId, method, params });
      await until(() => inbox.some(message => message.id === callId), () => stderr);
      return inbox.splice(inbox.findIndex(message => message.id === callId), 1)[0]!;
    },
    async close() { if (child.exitCode === null && child.signalCode === null) child.stdin.end(); await exit; },
  };
}

async function until(test: () => boolean | Promise<boolean>, detail: () => string = () => "", timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!await test()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${detail()}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** A wire stub: records physical sends and sync readers, rather than mocking process locks. */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "dossy-concurrent-"));
  let origin = "", online = false, successfulSends = 0;
  const syncTokens: string[] = [];
  const operationIds: string[] = [];
  const network = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const send = (data: unknown, status = 200) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (request.url === "/.well-known/dcp") return send({ issuer: origin, classes: ["general"] });
    if (request.url === "/v0.2/auth/token") return send({ access_token: `process-${JSON.parse(body).client_assertion}`, expires_in: 600 });
    if (request.method === "GET" && request.url?.startsWith("/v0.2/boards")) return send({ boards: [], private_boards: [], board_id: request.url.split("/").pop(), visibility: "open" });
    if (request.method === "GET" && request.url?.startsWith("/v0.2/feed")) {
      syncTokens.push(String(request.headers.authorization));
      return send({ mode: "feed", mutations: [], feed_cursor: "cursor" });
    }
    if (request.method === "POST" && request.url === "/v0.2/boards") {
      if (!online) return send({ error: "unavailable", message: "Test outage" }, 503);
      successfulSends++;
      const envelope = JSON.parse(body).envelope as string;
      operationIds.push(JSON.parse(Buffer.from(envelope.split(".")[1]!, "base64url").toString()).operation_id);
      // Keep the send in flight long enough for contenders to reach the outbox lock.
      await new Promise(resolve => setTimeout(resolve, 100));
      return send({ board_id: "test.created" });
    }
    return send({ error: "forbidden" }, 403);
  });
  await new Promise<void>(resolve => network.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(network.address() as AddressInfo).port}`;
  const path = join(dir, "bridge.json");
  const store = await Keystore.create(path, origin);
  store.state.agent_id = "agent-synthetic";
  store.state.followed = [];
  await store.save();
  return {
    dir, path, store, syncTokens, operationIds,
    get sends() { return successfulSends; },
    recover() { online = true; },
    async close() { network.closeAllConnections(); await new Promise<void>(resolve => network.close(() => resolve())); await rm(dir, { recursive: true, force: true }); },
  };
}

it("three real serve processes share tools, follows, watches, CLI grants and one approved send", async () => {
  const env = await setup();
  const sessions = Array.from({ length: 3 }, () => launch(["src/main.ts", "serve", "--state", env.path]));
  try {
    await Promise.all(sessions.map(async session => {
      await session.call("initialize", { capabilities: { elicitation: {} } });
      const tools = (await session.call("tools/list")).result!.tools as { name: string }[];
      expect(tools.some(tool => tool.name === "update_grant")).toBe(true);
      expect((await session.call("tools/call", { name: "network_status" })).result!.structuredContent.agent_id).toBe("agent-synthetic");
    }));
    await Promise.all([
      sessions[0]!.call("tools/call", { name: "follow_board", arguments: { board: "test.followed" } }),
      sessions[1]!.call("tools/call", { name: "set_watch", arguments: { name: "test", intent: "Watch for test requests" } }),
    ]);
    for (const session of sessions) {
      const status = (await session.call("tools/call", { name: "network_status" })).result!.structuredContent;
      expect(status.followed_boards).toContain("test.followed");
      expect(status.watches).toContain("test");
      expect(status.grant).toBeNull();
    }
    // CLI update_grant exists and persists only after a separate browser decision.
    const grant = launch(["src/main.ts", "call", "update_grant", "--json", '{"standing_actions":[]}', "--state", env.path]);
    await until(() => /Open (http:\/\/127\.0\.0\.1:\d+\/approve\/\S+)/.test(grant.stderr), () => grant.stderr);
    const url = /Open (http:\/\/127\.0\.0\.1:\d+\/approve\/\S+)/.exec(grant.stderr)![1]!;
    const page = await (await fetch(url)).text();
    const nonce = /name="nonce" value="([^"]+)"/.exec(page)![1]!;
    expect((await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(url).origin }, body: new URLSearchParams({ nonce, decision: "approve" }) })).status).toBe(200);
    expect(await grant.exit, grant.stderr).toBe(0);
    for (const session of sessions) {
      expect((await session.call("tools/call", { name: "network_status" })).result!.structuredContent.grant).toMatchObject({ standing_actions: [] });
    }
    // A real human channel (scripted here) approves in one session; an outage leaves its outbox entry.
    const pending = sessions[0]!.call("tools/call", { name: "create_board", arguments: { board_id: "test.created", description: "A synthetic test board" } });
    await until(() => sessions[0]!.inbox.some(message => message.method === "elicitation/create"));
    const prompt = sessions[0]!.inbox.find(message => message.method === "elicitation/create")!;
    sessions[0]!.send({ id: prompt.id, result: { action: "accept", content: { approve: true } } });
    expect((await pending).result!.structuredContent).toMatchObject({ queued: true });
    env.recover();
    // Three independent CLI starts flush the same outbox while all three servers remain running.
    const callers = Array.from({ length: 3 }, () => launch(["src/main.ts", "call", "network_status", "--state", env.path]));
    await Promise.all(callers.map(async cli => { expect(await cli.exit, cli.stderr).toBe(0); }));
    expect(env.sends).toBe(1);
    expect((await Keystore.open(env.path)).state.outbox).toEqual([]);
    expect(env.operationIds).toHaveLength(1);
    expect((await stat(env.path)).mode & 0o777).toBe(0o600);
  } finally { await Promise.all(sessions.map(session => session.close())); await env.close(); }
});

it("only one server syncs, competing CLI sync skips, and SIGKILL hands the lease to a survivor", async () => {
  const env = await setup();
  env.store.state.watches = [{ name: "all", intent: "All test requests" }];
  await env.store.save();
  const sessions = Array.from({ length: 3 }, () => launch(["test/fixtures/serve-fast.ts", env.path]));
  try {
    await Promise.all(sessions.map(async session => { await session.call("initialize"); await session.call("tools/list"); }));
    await until(() => env.syncTokens.length >= 4);
    expect(new Set(env.syncTokens).size).toBe(1);
    const cli = launch(["src/main.ts", "sync", "--state", env.path]);
    expect(await cli.exit, cli.stderr).toBe(0);
    expect(cli.stderr).toContain("No competing sync");
    expect(await trySyncLease(env.path)).toBeUndefined();
    // The fixture exposes the owner via stderr only for this test (no token/key is printed).
    await until(() => sessions.some(session => session.stderr.includes("sync-owner")));
    const owner = sessions.find(session => session.stderr.includes("sync-owner"))!;
    owner.child.kill("SIGKILL");
    await owner.exit;
    const before = env.syncTokens.length;
    await until(() => env.syncTokens.length > before && new Set(env.syncTokens).size >= 2);
    expect(sessions.filter(session => session.child.signalCode === null && session.child.exitCode === null)).toHaveLength(2);
  } finally { await Promise.all(sessions.map(session => session.close())); await env.close(); }
});
