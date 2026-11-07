import { build } from "esbuild";
import ts from "typescript";
import { copyFile, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const [folder, entry, platform] of [["protocol", "index.ts", "neutral"], ["packages/sdk", "src/index.ts", "neutral"], ["packages/mcp-bridge", "src/index.ts", "node"]]) {
  const dir = join(root, folder);
  await mkdir(join(dir, "dist"), { recursive: true });
  await build({ absWorkingDir: root, entryPoints: [join(dir, entry)], outfile: join(dir, "dist/index.js"), bundle: true, packages: "external", platform, format: "esm", target: "es2022" });
  const program = ts.createProgram([join(dir, entry)], { declaration: true, emitDeclarationOnly: true, rootDir: join(dir, dirname(entry)), outDir: join(dir, "dist"), module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, strict: true, skipLibCheck: true, esModuleInterop: true, resolveJsonModule: true });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => root, getNewLine: () => "\n" }));
  program.emit();
  for (const file of ["LICENSE.md", "NOTICE"]) await copyFile(join(root, file), join(dir, file));
  if (folder === "protocol") {
    for (const file of ["bounds.json", "vocabularies", "schemas"]) await cp(join(dir, file), join(dir, "dist", file), { recursive: true });
  }
}

const bridge = join(root, "packages/mcp-bridge");
// Keep path labels identical for the private checkout, public checkout, and release workflow.
const result = await build({ absWorkingDir: root, entryPoints: [join(bridge, "src/main.ts")], outfile: join(bridge, "dist/dossy-bridge.mjs"), bundle: true, metafile: true, platform: "node", format: "esm", target: "node24", banner: { js: 'import { createRequire as __dossyCreateRequire } from "node:module"; const require = __dossyCreateRequire(import.meta.url);' } });
// Bundled dependencies retain their license notices in every downloadable distribution.
const visited = new Set();
let notices = "# Third-party notices\n\n";
for (const input of Object.keys(result.metafile.inputs)) {
  let dir = dirname(resolve(root, input));
  while (dir !== dirname(dir)) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      if (pkg.name && !pkg.name.startsWith("@dossy/") && !visited.has(pkg.name)) {
        visited.add(pkg.name);
        notices += `## ${pkg.name} ${pkg.version ?? ""}\n\n`;
        const licenseTexts = new Set();
        const noticeNames = new Set(["license", "license.md", "license.txt", "license-mit", "notice"]);
        // Use actual directory entries so Linux also finds mixed-case names such as License.
        for (const name of (await readdir(dir)).filter((file) => noticeNames.has(file.toLowerCase())).sort()) {
          try {
            const licenseText = await readFile(join(dir, name), "utf8");
            if (!licenseTexts.has(licenseText)) {
              licenseTexts.add(licenseText);
              notices += `${licenseText}\n\n`;
            }
          } catch {}
        }
      }
      break;
    } catch { dir = dirname(dir); }
  }
}
await writeFile(join(bridge, "dist/THIRD_PARTY_NOTICES.md"), notices);
console.log("Built protocol, SDK, and standalone bridge.");
