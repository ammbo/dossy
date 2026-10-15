// The CLI as its own process: what keeps it alive, what it prints, and what it leaves on disk.
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { BrowserApprover } from "../src/approval.js";
import { Keystore } from "../src/keystore.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

/** Runs a TypeScript entry point in its own Node process. No browser opens; approval links go to stderr. */
function launch(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", ...args], { cwd: packageDir, env: { ...process.env, DOSSY_BROWSER: "none", ...env } });
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output.stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output.stderr += chunk; });
  const exit = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  return { child, output, exit };
}

async function approvalUrl(run: ReturnType<typeof launch>): Promise<string> {
  for (;;) {
    const match = /Open (http:\/\/127\.0\.0\.1:\d+\/approve\/\S+)/.exec(run.output.stderr);
    if (match) return match[1] as string;
    if (run.child.exitCode !== null) throw new Error(`Exited ${run.child.exitCode} before asking for approval: ${JSON.stringify(run.output)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const approval = { action: "update_grant", title: "Change the grant", recipient: "Nobody", disclosure: { standing_actions: [] }, permits: ["Nothing new"] };

it("prints subcommand help without creating state or validating an invite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dossy-help-"));
  try {
    const run = launch(["src/main.ts", "join", "--help", "--state", join(dir, "bridge.json")]);
    expect(await run.exit, run.output.stderr).toBe(0);
    expect(run.output.stdout).toContain("join <invite-url> --email");
    expect(run.output.stderr).toBe("");
    expect(await readdir(dir)).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

describe("browser approvals from the CLI", () => {
  it("keeps the process alive until the human decides, then exits", async () => {
    const run = launch(["test/fixtures/approve-once.ts"]);
    const url = await approvalUrl(run);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(run.child.exitCode).toBeNull();
    const nonce = /name="nonce" value="([^"]+)"/.exec(await (await fetch(url)).text())?.[1] ?? "";
    const decided = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(url).origin }, body: `nonce=${nonce}&decision=approve` });
    expect(decided.status).toBe(200);
    expect(await run.exit).toBe(0);
    expect(JSON.parse(run.output.stdout)).toEqual({ approved: true, channel: "browser" });
  });

  it("reports an explicit approval timeout when nobody decides", async () => {
    const started = Date.now();
    const run = launch(["test/fixtures/approve-once.ts", "400"]);
    expect(await run.exit).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(run.output.stderr).toContain("Waiting for human approval");
    expect(run.output.stderr).toContain("Timed out after 0.4s");
    expect(run.output.stdout).toBe("");
  });

  it("waits ten minutes by default", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const approver = new BrowserApprover({ open: async () => {} });
    try {
      let settled = false;
      const decision = approver.request(approval).catch(error => error).finally(() => { settled = true; });
      const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
      await flush();
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
      await flush();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(decision).resolves.toMatchObject({ code: "approval_timeout" });
    } finally {
      vi.useRealTimers();
      await approver.close();
    }
  });
});

describe("dossy-bridge pair", () => {
  it("names the network it pairs with, saves the agent, and leaves no lock behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dossy-cli-pair-"));
    let origin = "";
    const network = createServer((request, response) => {
      const send = (body: Record<string, unknown>): ServerResponse => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (request.method === "GET" && request.url === "/.well-known/dcp") return send({ issuer: origin });
      if (request.method === "POST" && request.url === "/v0.2/pairings") {
        return send({ pairing_id: "pairing_synthetic", verification_uri_complete: `${origin}/pair?code=SYNTH-1234`, user_code: "SYNTH-1234", key_fingerprint: "synthetic-fingerprint", interval: 0, expires_in: 60 });
      }
      if (request.method === "POST" && request.url === "/v0.2/pairings/pairing_synthetic/poll") return send({ status: "approved", agent_id: "agent_synthetic" });
      return response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => network.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(network.address() as AddressInfo).port}`;
    try {
      const path = join(dir, "bridge.json");
      // As join and serve --invite leave it: the issuer is not recorded yet.
      await Keystore.create(path, origin);
      const pair = () => launch(["src/main.ts", "pair", "--state", path], { DOSSY_BRIDGE_STATE: path });
      const first = pair();
      expect(await first.exit, first.output.stderr).toBe(0);
      expect(first.output.stdout).toContain(`Approve this agent while signed in to ${origin}:`);
      expect(first.output.stdout).toContain("Connected as agent agent_synthetic");
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ agent_id: "agent_synthetic", issuer: origin });
      expect(await readdir(dir)).toEqual(["bridge.json"]);
      // The next command gets the state at once instead of finding it "in use by a running bridge".
      const second = pair();
      expect(await second.exit).toBe(1);
      expect(second.output.stderr).toContain("Already paired as agent agent_synthetic");
    } finally {
      network.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
