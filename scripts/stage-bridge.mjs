// Stages the npm release of @dossy/mcp-bridge in packages/mcp-bridge/dist/npm.
// The published package is the standalone CLI only: one bundled file with no runtime dependencies,
// so `npx -y @dossy/mcp-bridge@<version>` installs nothing else. Run build:packages first.
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bridge = join(root, "packages/mcp-bridge");
const out = join(bridge, "dist/npm");

const pkg = JSON.parse(await readFile(join(bridge, "package.json"), "utf8"));
const source = await readFile(join(bridge, "src/version.ts"), "utf8");
const version = /VERSION = "([^"]+)"/.exec(source)?.[1];
if (version !== pkg.version) throw new Error(`src/version.ts says ${version} but package.json says ${pkg.version}.`);

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "bin"), { recursive: true });
await mkdir(join(out, "dist"), { recursive: true });
for (const file of ["dossy-bridge.mjs", "THIRD_PARTY_NOTICES.md"]) await copyFile(join(bridge, "dist", file), join(out, "dist", file));
await copyFile(join(bridge, "bin/dossy-bridge.mjs"), join(out, "bin/dossy-bridge.mjs"));
await copyFile(join(bridge, "README.md"), join(out, "README.md"));
for (const file of ["LICENSE.md", "NOTICE"]) await copyFile(join(root, file), join(out, file));

const manifest = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  type: "module",
  bin: pkg.bin,
  engines: pkg.engines,
  license: pkg.license,
  homepage: pkg.homepage,
  repository: pkg.repository,
  keywords: pkg.keywords,
  files: ["bin", "dist", "LICENSE.md", "NOTICE", "README.md"],
  publishConfig: pkg.publishConfig,
};
await writeFile(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(out);
