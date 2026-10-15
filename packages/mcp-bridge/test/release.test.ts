// The npm release: one version wherever it is pinned, and a package npx runs with nothing else installed.
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRIDGE_VERSION } from "../../../apps/protocol-site/install.mjs";
import { VERSION } from "../src/version.js";

const publicRoot = fileURLToPath(new URL("../../../", import.meta.url));
const pkg = JSON.parse(await readFile(join(publicRoot, "packages/mcp-bridge/package.json"), "utf8")) as { version: string };

describe("bridge release", () => {
  it("pins one version in the package, the MCP server, the installer, and the docs", async () => {
    expect(VERSION).toBe(pkg.version);
    expect(BRIDGE_VERSION).toBe(pkg.version);
    const docs = (await readdir(join(publicRoot, "docs"))).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`);
    let pins = 0;
    for (const file of ["apps/protocol-site/agent.md", "README.md", "packages/mcp-bridge/README.md", ...docs]) {
      for (const match of (await readFile(join(publicRoot, file), "utf8")).matchAll(/@dossyai\/mcp-bridge@(\d[^\s"'`]*)/g)) {
        expect(`${file} pins ${match[1]}`).toBe(`${file} pins ${pkg.version}`);
        pins += 1;
      }
    }
    expect(pins).toBeGreaterThan(10);
  });

  it.skipIf(process.platform === "win32")("stages a package with no dependencies that npx runs", { timeout: 60_000 }, async () => {
    const staged = execFileSync(process.execPath, [join(publicRoot, "scripts/stage-bridge.mjs")], { encoding: "utf8" }).trim();
    const manifest = JSON.parse(await readFile(join(staged, "package.json"), "utf8"));
    expect(manifest).toMatchObject({
      name: "@dossyai/mcp-bridge",
      version: pkg.version,
      engines: { node: ">=24" },
      bin: { "dossy-bridge": "bin/dossy-bridge.mjs" },
      repository: { url: "git+https://github.com/ammbo/dossy.git", directory: "packages/mcp-bridge" },
    });
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.exports).toBeUndefined();

    // A clean npm: no settings inherited from the pnpm run, and a cache of its own.
    const work = await mkdtemp(join(tmpdir(), "dossy-release-"));
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name))) as NodeJS.ProcessEnv;
    Object.assign(env, { npm_config_cache: join(work, "cache"), npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false" });
    const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: staged, encoding: "utf8", env }));
    expect(packed.files.map((file: { path: string }) => file.path).sort()).toEqual(["LICENSE.md", "NOTICE", "README.md", "bin/dossy-bridge.mjs", "dist/THIRD_PARTY_NOTICES.md", "dist/dossy-bridge.mjs", "package.json"]);
    const version = execFileSync("npx", ["-y", `--package=${join(work, packed.filename)}`, "--", "dossy-bridge", "--version"], { cwd: work, encoding: "utf8", env });
    expect(version.trim()).toBe(pkg.version);
  });
});
