// The open protocol tree must stand alone. Every import resolves inside this tree, to a Node
// built-in, or to a dependency the importing package declares. Nothing names a private platform
// package or path. Run from the repository root of github.com/ammbo/dossy or from public/.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_PACKAGES = ["@dossy/server", "@dossy/network", "@dossy/worker", "@dossy/operator-client", "@dossy/harness"];
const PRIVATE_TEXT = [
  "packages/server",
  "apps/network",
  "apps/worker",
  "operator-client",
  "db/migrations",
  "dossy-platform",
  "PRD Agent-Only",
];
const SOURCE = /\.(ts|mts|mjs|js)$/;
const TEXT = /\.(ts|mts|mjs|js|json|md|yaml|yml|html)$/;
const SPECIFIER = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;
const SELF = new Set(["scripts/check-boundaries.mjs"]);
const problems = [];

function walk(dir, visit) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, visit);
    else visit(path);
  }
}

function owningPackage(file) {
  let dir = dirname(file);
  while (dir.startsWith(root)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, "utf8"));
    if (dir === root) break;
    dir = dirname(dir);
  }
  return {};
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

walk(root, (file) => {
  const rel = relative(root, file);
  if (!TEXT.test(file) || SELF.has(rel.split(sep).join("/"))) return;
  const text = readFileSync(file, "utf8");
  for (const needle of [...PRIVATE_PACKAGES, ...PRIVATE_TEXT]) {
    if (text.includes(needle)) problems.push(`${rel} mentions private "${needle}"`);
  }
  if (!SOURCE.test(file)) return;
  const pkg = owningPackage(file);
  const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }));
  for (const match of text.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (!specifier) continue;
    if (specifier.startsWith(".")) {
      const target = resolve(dirname(file), specifier);
      if (!target.startsWith(root + sep)) problems.push(`${rel} imports ${specifier}, outside the open tree`);
      continue;
    }
    if (specifier.startsWith("node:") || builtinModules.includes(specifier)) continue;
    const name = packageName(specifier);
    if (PRIVATE_PACKAGES.includes(name)) problems.push(`${rel} imports private ${name}`);
    else if (!declared.has(name) && name !== pkg.name) problems.push(`${rel} imports ${name} without declaring it`);
  }
});

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("open tree boundary ok");
