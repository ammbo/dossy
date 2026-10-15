#!/usr/bin/env node
// User-space installer. No shell execution, elevated privileges, source checkout, or npm login.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const origin = "https://dossy.dev";

const icon = (paths) => `<svg viewBox="0 0 18 18" aria-hidden="true">${paths}</svg>`;

/** Hosts the installer can register. Local hosts get the bridge. Hosted agents get the paste prompt. */
export const hosts = [
  { id: "claude-code", name: "Claude Code", where: "Registers for every project with claude mcp add --scope user.", icon: icon('<rect x="2" y="3" width="14" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 8l2.2 1.6L5 11.2M9 11.5h4" fill="none" stroke="currentColor" stroke-width="1.4"/>'), kind: "claude" },
  { id: "claude-desktop", name: "Claude", where: "Writes claude_desktop_config.json for the Desktop app.", icon: icon('<path d="M9 1.8v14.4M1.8 9h14.4M3.4 3.4l11.2 11.2M14.6 3.4L3.4 14.6" fill="none" stroke="currentColor" stroke-width="1.5"/>'), kind: "json", key: "mcpServers" },
  { id: "cursor", name: "Cursor", where: "Writes ~/.cursor/mcp.json for every project.", icon: icon('<path d="M4 2.5l10 6.2-4.2.6 2.4 5.2-2 1-2.5-5.3L4 13.5z" fill="currentColor"/>'), kind: "json", key: "mcpServers" },
  { id: "codex", name: "Codex", where: "Registers with codex mcp add, or writes ~/.codex/config.toml.", icon: icon('<path d="M7 3.5H4.5v11H7M11 3.5h2.5v11H11" fill="none" stroke="currentColor" stroke-width="1.5"/>'), kind: "codex" },
  { id: "hermes", name: "Hermes", where: "Registers with hermes mcp add when that command is installed.", icon: icon('<path d="M4 13.5 9 3.5l5 10M6 10h6" fill="none" stroke="currentColor" stroke-width="1.5"/>'), kind: "hermes" },
  { id: "openclaw", name: "OpenClaw", where: "Registers with openclaw mcp add when that command is installed.", icon: icon('<path d="M3.5 12.5c2-6 9-6 11 0M6 8.5h6" fill="none" stroke="currentColor" stroke-width="1.5"/>'), kind: "openclaw" },
  { id: "windsurf", name: "Windsurf", where: "Writes ~/.codeium/windsurf/mcp_config.json.", icon: icon('<path d="M2 11c1.6-3.2 2.6-3.2 4.2 0s2.6 3.2 4.2 0 2.6-3.2 4.2 0" fill="none" stroke="currentColor" stroke-width="1.5"/>'), kind: "json", key: "mcpServers" },
  { id: "copilot", name: "Copilot", where: "Writes ~/.copilot/mcp-config.json.", icon: icon('<circle cx="9" cy="9" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="9" r="1.7" fill="currentColor"/>'), kind: "json", key: "mcpServers" },
  { id: "town", name: "Town", where: "Paste the setup into Town. Town adds tools from the conversation.", icon: icon('<path d="M3 14V7l6-4 6 4v7H3z" fill="none" stroke="currentColor" stroke-width="1.4"/>'), kind: "prompt" },
  { id: "instinct", name: "Instinct", where: "Paste the setup into Instinct.", icon: icon('<path d="M9 2.5 11 7h4.5L12 10l1.2 4.5L9 12 4.8 14.5 6 10 2.5 7H7z" fill="none" stroke="currentColor" stroke-width="1.2"/>'), kind: "prompt" },
  { id: "muse", name: "Muse", where: "Paste the setup into Muse and ask it to join.", icon: icon('<path d="M4 13c2-5 8-5 10 0M6.5 7.5h5" fill="none" stroke="currentColor" stroke-width="1.5"/>'), kind: "prompt" },
  { id: "dots", name: "Dots", where: "Paste the setup into your dot.", icon: icon('<circle cx="5" cy="9" r="1.3" fill="currentColor"/><circle cx="9" cy="9" r="1.3" fill="currentColor"/><circle cx="13" cy="9" r="1.3" fill="currentColor"/>'), kind: "prompt" },
  { id: "viktor", name: "Viktor", where: "Paste the setup into Viktor.", icon: icon('<path d="M5 4h8v10H5zM7 8h4M7 11h4" fill="none" stroke="currentColor" stroke-width="1.4"/>'), kind: "prompt" },
  { id: "hark", name: "Hark", where: "Paste the setup into Hark.", icon: icon('<path d="M4 9a5 5 0 0 1 10 0v3H4z" fill="none" stroke="currentColor" stroke-width="1.4"/>'), kind: "prompt" },
  { id: "grok", name: "Grok", where: "Paste the setup into Grok.", icon: icon('<path d="M4 13.5 9 4l5 9.5M6.2 10h5.6" fill="none" stroke="currentColor" stroke-width="1.5"/>'), kind: "prompt" },
  { id: "gemini", name: "Gemini", where: "Paste the setup into Gemini.", icon: icon('<path d="M9 2.5 11 7 15.5 9 11 11 9 15.5 7 11 2.5 9 7 7z" fill="none" stroke="currentColor" stroke-width="1.2"/>'), kind: "prompt" },
  { id: "mcp", name: "Other", where: "Prints an mcpServers entry for a host that is not listed.", icon: icon('<path d="M9 3.5v11M3.5 9h11" fill="none" stroke="currentColor" stroke-width="1.6"/>'), kind: "print" },
];

export const installCommand = (hostId) => `curl -fsSL https://dossy.dev/install.mjs -o install-dossy.mjs && node install-dossy.mjs --host ${hostId} --invite 'YOUR_INVITE'`;

export const hostPrompt = () => "Read https://dossy.dev/agent.md and join with this invite. If I gave you a code and not a link, use https://dossy.ai/join?invite=<that code>. Ask me which email to use, show me the key fingerprint, and ask for the 6-digit code.";

export function pickerCss() {
  return hosts.map((host) => `.agent-picker:has(#host-${host.id}:checked) #panel-${host.id}{display:block}`).join("");
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function renderAgents() {
  const prompt = hostPrompt();
  const menu = hosts.map((host, index) => `<input type="radio" name="dossy-agent" id="host-${host.id}"${index === 0 ? " checked" : ""}><label for="host-${host.id}"><span class="agent-mark">${host.icon}</span>${escapeHtml(host.name)}</label>`).join("");
  const panels = hosts.map((host) => {
    const command = host.kind === "prompt" ? "" : installCommand(host.id);
    const add = command
      ? `<li><strong>Add Dossy</strong><p>Run this in a terminal. On Windows, save the installer and pass the same arguments to node. A code by itself is enough.</p><div class="agent-command"><pre><code>${escapeHtml(command)}</code></pre><button type="button" class="copy-button copy-inline" data-copy="${escapeHtml(command)}">Copy</button></div></li>`
      : "";
    return `<section class="agent-panel" id="panel-${host.id}"><h3>Set up Dossy in ${escapeHtml(host.name)}</h3><p>${escapeHtml(host.where)}</p><div class="agent-setup"><button type="button" class="copy-button" data-copy="${escapeHtml(prompt)}">Copy setup</button><a href="/bridge">Setup notes</a></div><pre class="agent-prompt"><code>${escapeHtml(prompt)}</code></pre><ol>${add}<li><strong>Paste it</strong><p>Copy setup, then paste that message into ${escapeHtml(host.name)} with your invite.</p></li><li><strong>Confirm</strong><p>Check the key fingerprint, then read back the 6-digit code from your email.</p></li></ol></section>`;
  }).join("");
  return `<div class="agent-picker"><div class="agent-menu" role="radiogroup" aria-label="Agents">${menu}</div>${panels}</div><script src="/agent-picker.js" defer></script>`;
}

const INVITE_CODE = /^[A-Za-z0-9_-]{16,256}$/;

/** A bare code joins the hosted network. A full https link is kept as given. */
export function normalizeInvite(value) {
  if (typeof value !== "string") throw new Error("The invite must be a code or an https link.");
  const trimmed = value.trim();
  if (INVITE_CODE.test(trimmed)) return `https://dossy.ai/join?invite=${trimmed}`;
  assertInvite(trimmed);
  return trimmed;
}

export function assertInvite(invite) {
  if (typeof invite !== "string" || /[\u0000-\u001f]/.test(invite)) throw new Error("The invite must be a single-line https link.");
  let url;
  try {
    url = new URL(invite);
  } catch {
    throw new Error("The invite must be a single-line https link.");
  }
  if (url.protocol !== "https:") throw new Error("The invite must be a single-line https link.");
  return invite;
}

export function serverEntry(nodePath, bridgePath, invite, statePath) {
  return { command: nodePath, args: [bridgePath, "serve", "--invite", invite], env: { DOSSY_BRIDGE_STATE: statePath } };
}

/** Merge one stdio server into a JSON config. Other servers and extra fields on this server stay. */
export function mergeServerJson(text, key, entry) {
  const parsed = text.trim() ? JSON.parse(text) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Config root must be a JSON object.");
  const current = parsed[key];
  const servers = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  const previous = servers.dossy && typeof servers.dossy === "object" && !Array.isArray(servers.dossy) ? servers.dossy : {};
  const previousEnv = previous.env && typeof previous.env === "object" && !Array.isArray(previous.env) ? previous.env : {};
  servers.dossy = { ...previous, ...entry, env: { ...previousEnv, ...entry.env } };
  parsed[key] = servers;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function codexBlock(entry) {
  const args = entry.args.map((arg) => tomlString(arg)).join(", ");
  return `[mcp_servers.dossy]\ncommand = ${tomlString(entry.command)}\nargs = [${args}]\ntool_timeout_sec = 600\n\n[mcp_servers.dossy.env]\nDOSSY_BRIDGE_STATE = ${tomlString(entry.env.DOSSY_BRIDGE_STATE)}\n`;
}

/** Append the Codex table when it is absent. An existing table is left untouched. */
export function upsertCodex(source, block) {
  if (/^\[mcp_servers\.dossy\]/m.test(source)) return { text: source, updated: false };
  const trimmed = source.replace(/\s*$/, "");
  return { text: `${trimmed ? `${trimmed}\n\n` : ""}${block}`, updated: true };
}

export function claudeDesktopConfig(home, platform, env = {}) {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude", "claude_desktop_config.json");
}

export function configFile(host, home, platform, env = {}) {
  if (host.id === "claude-desktop") return claudeDesktopConfig(home, platform, env);
  if (host.id === "cursor") return join(home, ".cursor", "mcp.json");
  if (host.id === "windsurf") return join(home, ".codeium", "windsurf", "mcp_config.json");
  if (host.id === "copilot") return join(home, ".copilot", "mcp-config.json");
  if (host.id === "codex") return join(home, ".codex", "config.toml");
  return undefined;
}

function runCommand(file, args, run) {
  if (run) return run(file, args);
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 30_000 });
  if (result.error?.code === "ENOENT") return { missing: true, status: 1, stderr: "" };
  return { missing: false, status: result.status ?? 1, stderr: String(result.stderr ?? "").slice(0, 500) };
}

async function writePrivate(path, text) {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

/**
 * Point one host at the installed bridge. A JSON config is merged. Claude Code and Codex use
 * their own CLIs when those commands exist, so this does not rewrite their files by hand.
 */
export async function registerHost({ host: hostId, invite, bridgePath, nodePath, home, platform = process.platform, env = process.env, run }) {
  const host = hosts.find((item) => item.id === hostId);
  if (!host) throw new Error(`Unknown host "${hostId}". Known hosts: ${hosts.map((item) => item.id).join(", ")}.`);
  invite = normalizeInvite(invite);
  const statePath = join(home, ".dossy", `bridge-${host.id}.json`);
  const entry = serverEntry(nodePath, bridgePath, invite, statePath);
  const base = { host: host.id, name: host.name, state: statePath, prompt: hostPrompt(host) };

  if (host.kind === "prompt") return { ...base, registered: false, promptOnly: true, config: null };

  if (host.kind === "print") {
    return { ...base, registered: false, config: null, snippet: `${JSON.stringify({ mcpServers: { dossy: entry } }, null, 2)}\n` };
  }

  if (host.kind === "hermes" || host.kind === "openclaw") {
    const file = host.kind === "hermes" ? "hermes" : "openclaw";
    const values = [bridgePath, "serve", "--invite", invite];
    const flag = host.kind === "hermes" ? "--args" : "--arg";
    const args = ["mcp", "add", "--command", nodePath, ...values.flatMap((value) => [`${flag}=${value}`]), `--env=DOSSY_BRIDGE_STATE=${statePath}`, "dossy"];
    const result = runCommand(file, args, run);
    return { ...base, registered: result.status === 0, config: null, command: [file, ...args], detail: result.missing ? `The ${file} command is not installed. Paste the setup into ${host.name} instead.` : result.stderr };
  }

  if (host.kind === "claude") {
    const args = ["mcp", "add", "--scope", "user", "--transport", "stdio", "--env", `DOSSY_BRIDGE_STATE=${statePath}`, "dossy", "--", nodePath, bridgePath, "serve", "--invite", invite];
    const result = runCommand("claude", args, run);
    return { ...base, registered: result.status === 0, config: join(home, ".claude.json"), command: ["claude", ...args], detail: result.missing ? "The claude command is not installed." : result.stderr };
  }

  if (host.kind === "codex") {
    const args = ["mcp", "add", "--env", `DOSSY_BRIDGE_STATE=${statePath}`, "dossy", "--", nodePath, bridgePath, "serve", "--invite", invite];
    const result = runCommand("codex", args, run);
    const file = configFile(host, home, platform, env);
    if (result.status === 0) return { ...base, registered: true, config: file, command: ["codex", ...args] };
    let existing = "";
    try {
      existing = await readFile(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const next = upsertCodex(existing, codexBlock(entry));
    if (!next.updated) return { ...base, registered: false, config: file, detail: "Codex already has [mcp_servers.dossy]. The installer left that table as it is." };
    await writePrivate(file, next.text);
    return { ...base, registered: true, config: file, detail: result.missing ? "codex was not on PATH, so the installer wrote config.toml." : result.stderr };
  }

  const file = configFile(host, home, platform, env);
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let next;
  try {
    next = mergeServerJson(existing, host.key, entry);
  } catch {
    return { ...base, registered: false, config: file, detail: `${file} is not plain JSON, so it was left unchanged.`, snippet: `${JSON.stringify({ [host.key]: { dossy: entry } }, null, 2)}\n` };
  }
  await writePrivate(file, next);
  return { ...base, registered: true, config: file };
}

function parseArgs(argv) {
  let host;
  let invite;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--host") host = argv[++index];
    else if (arg === "--invite") invite = argv[++index];
    else throw new Error(`Unknown argument ${arg}. Use --host <${hosts.map((item) => item.id).join("|")}> --invite <https-link>.`);
  }
  if ((host === undefined && argv.includes("--host")) || (invite === undefined && argv.includes("--invite"))) throw new Error("--host and --invite each need a value.");
  return { host, invite };
}

async function installBridge() {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Install Node.js 24 or newer from nodejs.org, then run this installer again.");
  const response = await fetch(`${origin}/.well-known/dcp.json`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("Could not fetch the DCP installation manifest.");
  const manifest = await response.json();
  const dir = process.env.DOSSY_INSTALL_DIR ?? join(homedir(), ".dossy", "bin");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const artifact of [manifest.bridge, ...manifest.notices]) {
    const url = new URL(artifact.url);
    if (url.origin !== origin || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("Invalid installation manifest.");
    const download = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!download.ok) throw new Error(`Download failed for ${url.pathname}.`);
    const bytes = new Uint8Array(await download.arrayBuffer());
    if (bytes.length > 8 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("Download integrity verification failed.");
    const name = url.pathname.split("/").at(-1);
    if (!name || name.includes("..")) throw new Error("Invalid artifact filename.");
    const temporary = join(dir, `${name}.${process.pid}.tmp`);
    await writeFile(temporary, bytes, { mode: 0o700 });
    await rename(temporary, join(dir, name));
  }
  return join(dir, "dossy-bridge.mjs");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Install the Dossy bridge, and optionally register it with one agent host.\n\nnode install.mjs [--host ${hosts.map((item) => item.id).join("|")}] [--invite <https-link>]\n\nOn Windows, save this file and pass the same flags to node. The curl one-liner is for macOS and Linux.`);
    return;
  }
  if (options.host && !hosts.some((item) => item.id === options.host)) throw new Error(`Unknown host "${options.host}". Known hosts: ${hosts.map((item) => item.id).join(", ")}.`);
  if (options.host && !options.invite) throw new Error("--host needs --invite, the https link a member sent you.");
  if (options.invite) options.invite = normalizeInvite(options.invite);
  const installed = await installBridge();
  const result = { installed, node: process.execPath };
  if (!options.host) {
    result.next = "Run again with --host <host> --invite <https-link>, or add this file to your MCP setup with serve --invite <invite-url>.";
  } else {
    const registration = await registerHost({ host: options.host, invite: options.invite, bridgePath: installed, nodePath: process.execPath, home: homedir() });
    Object.assign(result, registration);
    result.next = registration.registered
      ? `Restart ${registration.name}. The invite in its setup is spent once you confirm the emailed code. Then paste the prompt to that agent.`
      : registration.detail ?? "The bridge is installed. Registration did not change the host config.";
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.registered === false && !result.promptOnly) process.exitCode = 1;
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
