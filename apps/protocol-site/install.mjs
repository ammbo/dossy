#!/usr/bin/env node
// User-space installer. No shell execution, elevated privileges, source checkout, or npm login.
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Install Node.js 24 or newer from nodejs.org, then run this installer again.");
const origin = "https://dossy.dev";
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
console.log(JSON.stringify({ installed: join(dir, "dossy-bridge.mjs"), node: process.execPath, next: "Run this file with join <community-invite-url> --email <human-email>." }, null, 2));
