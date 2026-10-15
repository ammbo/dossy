import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { assertInvite, claudeDesktopConfig, hostPrompt, hosts, installCommand, mergeServerJson, normalizeInvite, registerHost, upsertCodex, codexBlock, serverEntry } from "../../../apps/protocol-site/install.mjs";

const invite = "https://dossy.ai/join?invite=example";
const entry = () => serverEntry("/usr/local/bin/node", "/tmp/dossy-bridge.mjs", invite, "/tmp/bridge-cursor.json");

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

  it("merges one server and keeps the rest of the file", () => {
    const merged = mergeServerJson(`{"mcpServers":{"other":{"command":"stay"},"dossy":{"disabled":true,"env":{"KEEP":"1"}}}}\n`, "mcpServers", entry());
    const parsed = JSON.parse(merged);
    expect(parsed.mcpServers.other.command).toBe("stay");
    expect(parsed.mcpServers.dossy.disabled).toBe(true);
    expect(parsed.mcpServers.dossy.env).toEqual({ KEEP: "1", DOSSY_BRIDGE_STATE: "/tmp/bridge-cursor.json" });
    expect(parsed.mcpServers.dossy.args).toContain("--invite");
  });

  it("appends a Codex table once", () => {
    const block = codexBlock(entry());
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

  it("writes Cursor's config without removing another server", async () => {
    const home = await mkdtemp(join(tmpdir(), "dossy-install-"));
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(join(home, ".cursor", "mcp.json"), `{\n  "mcpServers": { "other": { "command": "stay" } }\n}\n`);
    const result = await registerHost({
      host: "cursor",
      invite,
      bridgePath: "/tmp/dossy-bridge.mjs",
      nodePath: "/usr/local/bin/node",
      home,
      platform: "darwin",
      env: {},
    });
    expect(result.registered).toBe(true);
    const saved = JSON.parse(await readFile(result.config, "utf8"));
    expect(saved.mcpServers.other.command).toBe("stay");
    expect(saved.mcpServers.dossy.args.at(-1)).toBe(invite);
    expect(saved.mcpServers.dossy.env.DOSSY_BRIDGE_STATE).toBe(join(home, ".dossy", "bridge-cursor.json"));
  });

  it("leaves a non-JSON Cursor config untouched", async () => {
    const home = await mkdtemp(join(tmpdir(), "dossy-install-"));
    await mkdir(join(home, ".cursor"), { recursive: true });
    const original = "{ not json\n";
    await writeFile(join(home, ".cursor", "mcp.json"), original);
    const result = await registerHost({ host: "cursor", invite, bridgePath: "/b", nodePath: "/n", home, platform: "darwin", env: {} });
    expect(result.registered).toBe(false);
    expect(await readFile(join(home, ".cursor", "mcp.json"), "utf8")).toBe(original);
    expect(result.snippet).toContain("dossy");
  });

  it("writes Codex config when the codex command is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "dossy-install-"));
    const result = await registerHost({
      host: "codex",
      invite,
      bridgePath: "/tmp/dossy-bridge.mjs",
      nodePath: "/usr/local/bin/node",
      home,
      platform: "darwin",
      env: {},
      run: () => ({ missing: true, status: 1, stderr: "" }),
    });
    expect(result.registered).toBe(true);
    const toml = await readFile(join(home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("tool_timeout_sec = 600");
    expect(toml).toContain("bridge-codex.json");
    const again = await registerHost({
      host: "codex",
      invite,
      bridgePath: "/tmp/dossy-bridge.mjs",
      nodePath: "/usr/local/bin/node",
      home,
      platform: "darwin",
      env: {},
      run: () => ({ missing: true, status: 1, stderr: "" }),
    });
    expect(again.registered).toBe(false);
    expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toBe(toml);
  });

  it("does not invent a Claude Code config when the claude command is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "dossy-install-"));
    const result = await registerHost({
      host: "claude-code",
      invite,
      bridgePath: "/tmp/dossy-bridge.mjs",
      nodePath: "/usr/local/bin/node",
      home,
      platform: "darwin",
      env: {},
      run: () => ({ missing: true, status: 1, stderr: "" }),
    });
    expect(result.registered).toBe(false);
    expect(result.command.join(" ")).toContain("mcp add");
    expect(result.command).toContain("--scope");
    expect(result.command).toContain("user");
    await expect(readFile(join(home, ".claude.json"), "utf8")).rejects.toThrow();
  });
});
