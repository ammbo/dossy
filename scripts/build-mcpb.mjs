// Packs the Claude Desktop extension, packages/mcp-bridge/dist/dossy.mcpb: the manifest, the bundled
// bridge, and its notices in a zip, as the MCPB format describes. Run build:packages first.
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bridge = join(root, "packages/mcp-bridge");
const stage = join(bridge, "dist/mcpb");
const out = join(bridge, "dist/dossy.mcpb");

const manifest = JSON.parse(await readFile(join(bridge, "mcpb/manifest.json"), "utf8"));
const version = /VERSION = "([^"]+)"/.exec(await readFile(join(bridge, "src/version.ts"), "utf8"))?.[1];
if (manifest.version !== version) throw new Error(`mcpb/manifest.json says ${manifest.version} but src/version.ts says ${version}.`);

await rm(stage, { recursive: true, force: true });
await rm(out, { force: true });
await mkdir(join(stage, "server"), { recursive: true });
await copyFile(join(bridge, "mcpb/manifest.json"), join(stage, "manifest.json"));
await copyFile(join(bridge, "dist/dossy-bridge.mjs"), join(stage, "server/dossy-bridge.mjs"));
await copyFile(join(bridge, "dist/THIRD_PARTY_NOTICES.md"), join(stage, "THIRD_PARTY_NOTICES.md"));
await copyFile(join(root, "LICENSE.md"), join(stage, "LICENSE.md"));
// -X leaves out extra file attributes, so the archive depends only on the files.
execFileSync("zip", ["-q", "-X", "-r", out, "."], { cwd: stage, stdio: "inherit" });
console.log(out);
