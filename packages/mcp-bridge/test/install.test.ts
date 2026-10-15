import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { assertInvite, BRIDGE_PACKAGE, claudeDesktopConfig, codexBlock, hostPrompt, hosts, installCommand, mergeServerJson, nodeHome, normalizeInvite, npxLauncher, registerHost, serverEntry, standaloneLauncher, upsertCodex } from "../../../apps/protocol-site/install.mjs";

const invite = "https://dossy.ai/join?invite=example";
const launch = { command: "/opt/node/bin/npx", args: ["-y", BRIDGE_PACKAGE], env: { PATH: "/opt/node/bin:/usr/bin:/bin" } };
const entry = () => serverEntry(launch, invite, "/tmp/bridge-cursor.json");
const home = () => mkdtemp(join(tmpdir(), "dossy-install-"));
const missing = () => ({ missing: true, status: 1, stderr: "" });
const now = new Date("2026-10-15T12:00:00.000Z");
/** A filesystem where nothing is a symlink and nothing outside `links` exists. */
const resolver = (links: Record<string, string>) => (path: string) => {
  const target = links[path];
  if (!target) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return target;
};

describe("host installer", () => {
  it("names every host in its command and prompt", () => {
    expect(hostPrompt()).toContain("https://dossy.ai/join?invite=<that code>");
    for (const host of hosts) {
      expect(installCommand(host.id)).toContain(`--host ${host.id}`);
      expect(host.icon).toContain("<svg");
    }
  });

  it("turns a bare invite code into a dossy.ai link", () => {
    expect(normalizeInvite("synthetic_invite_123456789")).toBe("https://dossy.ai/join?invite=synthetic_invite_123456789");
    expect(() => assertInvite("http://dossy.ai/join?invite=x")).toThrow(/https/);
    expect(() => normalizeInvite("https://dossy.ai/join\n--host")).toThrow(/https/);
  });

  it("runs the pinned npm release through the npx beside this Node, with that Node first on PATH", () => {
    const unix = npxLauncher({ nodePath: "/opt/node/bin/node", platform: "darwin", env: { PATH: "/usr/bin:/opt/node/bin:/bin" }, exists: () => true, realpath: resolver({ "/opt/node/bin/node": "/opt/node/bin/node" }) });
    expect(BRIDGE_PACKAGE).toMatch(/^@dossy\/mcp-bridge@\d+\.\d+\.\d+$/);
    expect(unix).toEqual({ command: "/opt/node/bin/npx", args: ["-y", BRIDGE_PACKAGE], env: { PATH: "/opt/node/bin:/usr/bin:/bin" } });

    const windows = npxLauncher({ nodePath: "C:\\Program Files\\nodejs\\node.exe", platform: "win32", env: { Path: "C:\\Windows" }, exists: () => true, realpath: resolver({}) });
    expect(windows?.command).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(windows?.args).toEqual(["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js", "-y", BRIDGE_PACKAGE]);
    expect(windows?.env.PATH).toBe("C:\\Program Files\\nodejs;C:\\Windows");

    expect(npxLauncher({ nodePath: "/usr/bin/node", platform: "linux", env: {}, exists: () => false, realpath: resolver({}) })).toBeUndefined();
  });

  it("names the PATH folder that links to this Node, not a versioned folder an upgrade removes", () => {
    const cellar = "/opt/homebrew/Cellar/node/26.11.1/bin/node";
    const realpath = resolver({ [cellar]: cellar, "/opt/homebrew/bin/node": cellar, "/usr/local/bin/node": "/usr/local/Cellar/node/22.0.0/bin/node" });
    const env = { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin" };
    expect(nodeHome({ nodePath: cellar, platform: "darwin", env, realpath })).toEqual({ dir: "/opt/homebrew/bin", node: "/opt/homebrew/bin/node", PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin" });
    expect(npxLauncher({ nodePath: cellar, platform: "darwin", env, exists: () => true, realpath })?.command).toBe("/opt/homebrew/bin/npx");
    // With no PATH folder pointing at it, the Node in use is named directly.
    expect(nodeHome({ nodePath: cellar, platform: "darwin", env: { PATH: "/usr/bin" }, realpath }).node).toBe(cellar);
  });

  it("builds a serve entry with the invite and a state file per host", () => {
    expect(entry()).toEqual({ command: "/opt/node/bin/npx", args: ["-y", BRIDGE_PACKAGE, "serve", "--invite", invite], env: { PATH: "/opt/node/bin:/usr/bin:/bin", DOSSY_BRIDGE_STATE: "/tmp/bridge-cursor.json" } });
    expect(serverEntry(standaloneLauncher("/usr/local/bin/node", "/home/a/.dossy/bin/dossy-bridge.mjs"), undefined, "/s.json")).toEqual({ command: "/usr/local/bin/node", args: ["/home/a/.dossy/bin/dossy-bridge.mjs", "serve"], env: { DOSSY_BRIDGE_STATE: "/s.json" } });
  });

  it("merges one server and keeps the rest of the file", () => {
    const merged = mergeServerJson(`{"mcpServers":{"other":{"command":"stay"},"dossy":{"disabled":true,"env":{"KEEP":"1"}}}}\n`, "mcpServers", entry());
    const parsed = JSON.parse(merged);
    expect(parsed.mcpServers.other.command).toBe("stay");
    expect(parsed.mcpServers.dossy.disabled).toBe(true);
    expect(parsed.mcpServers.dossy.env).toEqual({ KEEP: "1", PATH: "/opt/node/bin:/usr/bin:/bin", DOSSY_BRIDGE_STATE: "/tmp/bridge-cursor.json" });
    expect(parsed.mcpServers.dossy.args).toContain("--invite");
  });

  it("appends a Codex table once, with every env value", () => {
    const block = codexBlock(entry());
    expect(block).toContain(`args = ["-y", "${BRIDGE_PACKAGE}", "serve", "--invite", "${invite}"]`);
    expect(block).toContain('PATH = "/opt/node/bin:/usr/bin:/bin"');
    const first = upsertCodex("model = \"gpt\"\n", block);
    expect(first.updated).toBe(true);
    expect(first.text).toContain("[mcp_servers.dossy]");
    expect(first.text).toContain("tool_timeout_sec = 600");
    const second = upsertCodex(first.text, block);
    expect(second.updated).toBe(false);
    expect(second.text).toBe(first.text);
  });

  it("uses the Desktop config path for each platform", () => {
    expect(claudeDesktopConfig("/Users/a", "darwin")).toBe("/Users/a/Library/Application Support/Claude/claude_desktop_config.json");
    expect(claudeDesktopConfig("/Users/a", "win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" })).toBe(join("C:\\Users\\a\\AppData\\Roaming", "Claude", "claude_desktop_config.json"));
    expect(claudeDesktopConfig("/Users/a", "linux", {})).toBe("/Users/a/.config/Claude/claude_desktop_config.json");
  });

  it("writes Cursor's config without removing another server, after a backup", async () => {
    const dir = await home();
    await mkdir(join(dir, ".cursor"), { recursive: true });
    const original = `{\n  "mcpServers": { "other": { "command": "stay" } }\n}\n`;
    await writeFile(join(dir, ".cursor", "mcp.json"), original);
    const result = await registerHost({ host: "cursor", invite, launch, home: dir, platform: "darwin", env: {}, now });
    expect(result.registered).toBe(true);
    const saved = JSON.parse(await readFile(String(result.config), "utf8"));
    expect(saved.mcpServers.other.command).toBe("stay");
    expect(saved.mcpServers.dossy.command).toBe("/opt/node/bin/npx");
    expect(saved.mcpServers.dossy.args).toEqual(["-y", BRIDGE_PACKAGE, "serve", "--invite", invite]);
    expect(saved.mcpServers.dossy.env.DOSSY_BRIDGE_STATE).toBe(join(dir, ".dossy", "bridge-cursor.json"));
    expect(await readFile(String(result.backup), "utf8")).toBe(original);
  });

  it("leaves a non-JSON Cursor config untouched", async () => {
    const dir = await home();
    await mkdir(join(dir, ".cursor"), { recursive: true });
    const original = "{ not json\n";
    await writeFile(join(dir, ".cursor", "mcp.json"), original);
    const result = await registerHost({ host: "cursor", invite, launch, home: dir, platform: "darwin", env: {} });
    expect(result.registered).toBe(false);
    expect(await readFile(join(dir, ".cursor", "mcp.json"), "utf8")).toBe(original);
    expect(await readdir(join(dir, ".cursor"))).toEqual(["mcp.json"]);
    expect(result.snippet).toContain(BRIDGE_PACKAGE);
  });

  it("writes Codex config when the codex command is missing, and backs up the old one", async () => {
    const dir = await home();
    await mkdir(join(dir, ".codex"), { recursive: true });
    await writeFile(join(dir, ".codex", "config.toml"), "model = \"gpt\"\n");
    const result = await registerHost({ host: "codex", invite, launch, home: dir, platform: "darwin", env: {}, run: missing, now });
    expect(result.registered).toBe(true);
    const toml = await readFile(join(dir, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("model = \"gpt\"");
    expect(toml).toContain("tool_timeout_sec = 600");
    expect(toml).toContain("bridge-codex.json");
    expect(await readFile(String(result.backup), "utf8")).toBe("model = \"gpt\"\n");
    const again = await registerHost({ host: "codex", invite, launch, home: dir, platform: "darwin", env: {}, run: missing });
    expect(again.registered).toBe(false);
    expect(again.snippet).toContain("[mcp_servers.dossy]");
    expect(await readFile(join(dir, ".codex", "config.toml"), "utf8")).toBe(toml);
  });

  it("registers Claude Code through its CLI, with the same env the file fallback writes", async () => {
    const dir = await home();
    const calls: string[][] = [];
    const result = await registerHost({ host: "claude-code", invite, launch, home: dir, platform: "darwin", env: {}, run: (file, args) => { calls.push([file, ...args]); return { status: 0, stderr: "" }; } });
    expect(result.registered).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.slice(0, 6)).toEqual(["claude", "mcp", "add", "--scope", "user", "--transport"]);
    expect(call).toContain(`PATH=${launch.env.PATH}`);
    expect(call).toContain(`DOSSY_BRIDGE_STATE=${join(dir, ".dossy", "bridge-claude-code.json")}`);
    expect(call.slice(call.indexOf("--") + 1)).toEqual(["/opt/node/bin/npx", "-y", BRIDGE_PACKAGE, "serve", "--invite", invite]);
  });

  for (const [why, run] of [
    ["missing", missing],
    ["crashing", () => ({ missing: false, status: 1, stderr: "TypeError: something in the CLI broke\n" })],
  ] as const) {
    it(`adds the server to ~/.claude.json when the claude command is ${why}`, async () => {
      const dir = await home();
      const original = `${JSON.stringify({ numStartups: 12, projects: { "/w": { allowedTools: [] } }, mcpServers: { other: { type: "stdio", command: "stay", args: [] } } }, null, 2)}\n`;
      await writeFile(join(dir, ".claude.json"), original);
      const result = await registerHost({ host: "claude-code", invite, launch, home: dir, platform: "darwin", env: {}, run, now });
      expect(result.registered).toBe(true);
      expect(result.config).toBe(join(dir, ".claude.json"));
      expect(result.detail).toMatch(why === "missing" ? /not installed/ : /claude mcp add failed\. TypeError/);
      const saved = JSON.parse(await readFile(join(dir, ".claude.json"), "utf8"));
      expect(saved.numStartups).toBe(12);
      expect(saved.projects).toEqual({ "/w": { allowedTools: [] } });
      expect(saved.mcpServers.other).toEqual({ type: "stdio", command: "stay", args: [] });
      expect(saved.mcpServers.dossy).toEqual({ type: "stdio", ...serverEntry(launch, invite, join(dir, ".dossy", "bridge-claude-code.json")) });
      expect(await readFile(String(result.backup), "utf8")).toBe(original);
    });
  }

  it("follows CLAUDE_CONFIG_DIR for the Claude Code fallback", async () => {
    const dir = await home();
    await mkdir(join(dir, "alt"), { recursive: true });
    await writeFile(join(dir, "alt", ".claude.json"), "{}\n");
    const result = await registerHost({ host: "claude-code", invite, launch, home: dir, platform: "darwin", env: { CLAUDE_CONFIG_DIR: join(dir, "alt") }, run: missing, now });
    expect(result.config).toBe(join(dir, "alt", ".claude.json"));
    expect(JSON.parse(await readFile(join(dir, "alt", ".claude.json"), "utf8")).mcpServers.dossy.command).toBe("/opt/node/bin/npx");
  });

  it("prints the entry instead of inventing a Claude Code config that does not exist", async () => {
    const dir = await home();
    const result = await registerHost({ host: "claude-code", invite, launch, home: dir, platform: "darwin", env: {}, run: missing });
    expect(result.registered).toBe(false);
    expect(result.command?.join(" ")).toContain("mcp add --scope user");
    expect(JSON.parse(String(result.snippet)).mcpServers.dossy).toMatchObject({ type: "stdio", command: "/opt/node/bin/npx" });
    expect(result.detail).toContain("does not exist");
    await expect(readFile(join(dir, ".claude.json"), "utf8")).rejects.toThrow();
  });

  it("leaves a Claude Code config that is not plain JSON alone", async () => {
    const dir = await home();
    await writeFile(join(dir, ".claude.json"), "{ broken");
    const result = await registerHost({ host: "claude-code", invite, launch, home: dir, platform: "darwin", env: {}, run: missing });
    expect(result.registered).toBe(false);
    expect(result.snippet).toContain(BRIDGE_PACKAGE);
    expect(await readFile(join(dir, ".claude.json"), "utf8")).toBe("{ broken");
    expect(await readdir(dir)).toEqual([".claude.json"]);
  });

  it("gives hosts without a working CLI the entry to add", async () => {
    const dir = await home();
    const result = await registerHost({ host: "hermes", invite, launch, home: dir, platform: "darwin", env: {}, run: missing });
    expect(result.registered).toBe(false);
    expect(result.command).toContain(`--args=${BRIDGE_PACKAGE}`);
    expect(JSON.parse(String(result.snippet)).mcpServers.dossy.args).toEqual(["-y", BRIDGE_PACKAGE, "serve", "--invite", invite]);
    expect(result.detail).toContain("not installed");
  });
});
