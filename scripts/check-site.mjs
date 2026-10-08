// Verify generated routes, fragments, release integrity, and the executable documentation example.
// An optional first argument supplies a second static directory for checking cross-site links.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { generateEncryptionPair, validateRequestDocument, loadBounds } from "../packages/sdk/dist/index.js";
import { headingId } from "../apps/protocol-site/template.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docs = join(root, "apps/protocol-site/dist");
const sites = new Map([["https://dossy.dev", docs]]);
if (process.argv[2]) sites.set("https://dossy.ai", resolve(process.argv[2]));
const isFile = async (path) => stat(path).then((info) => info.isFile(), () => false);
const resolveRoute = async (dir, pathname) => {
  const base = resolve(dir, `.${decodeURIComponent(pathname)}`);
  if (base !== dir && !base.startsWith(dir + sep)) throw new Error("Route escaped static directory.");
  for (const candidate of [base, `${base.replace(/\/$/, "")}.html`, join(base, "index.html")]) if (await isFile(candidate)) return candidate;
  throw new Error(`Missing route ${pathname} in ${dir}`);
};
let pages = 0;
let links = 0;
for (const [origin, dir] of sites) {
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".html")) continue;
    const html = await readFile(join(dir, name), "utf8");
    assert.equal((html.match(/<h1(?:\s|>)/g) ?? []).length, 1, `${name}: one page heading`);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta name="description" content="[^"]+">/);
    assert.match(html, /<link rel="canonical" href="https:\/\/dossy\.(?:ai|dev)\/[^\"]*">/);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, `${name}: duplicate fragment IDs`);
    const base = new URL(name === "index.html" ? "/" : `/${name.slice(0, -5)}`, origin);
    for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      const url = new URL(match[1].replace(/&amp;/g, "&"), base);
      const targetDir = sites.get(url.origin);
      if (!targetDir) continue;
      const file = await resolveRoute(targetDir, url.pathname);
      if (url.hash && file.endsWith(".html")) {
        const target = await readFile(file, "utf8");
        assert.ok(target.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `${name}: missing fragment ${url}`);
      }
      links += 1;
    }
    pages += 1;
  }
}
const manifest = JSON.parse(await readFile(join(docs, ".well-known/dcp.json"), "utf8"));
for (const artifact of [manifest.bridge, ...manifest.notices]) {
  const url = new URL(artifact.url);
  assert.equal(url.origin, "https://dossy.dev");
  const bytes = await readFile(await resolveRoute(docs, url.pathname));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256, `Release digest: ${url.pathname}`);
}
const tools = JSON.parse(execFileSync(process.execPath, [join(docs, "releases/dossy-bridge.mjs"), "tools"], { encoding: "utf8" })).tools;
const reference = await readFile(join(docs, "tools.html"), "utf8");
for (const tool of tools) assert.ok(reference.includes(`id="${headingId(tool.name)}"`), `Undocumented tool ${tool.name}`);
const sample = JSON.parse(await readFile(join(docs, "sample-requests/advice.json"), "utf8"));
const markdown = await readFile(join(root, "docs/examples.md"), "utf8");
const command = markdown.match(/publish_request --json '([^']+)'/);
assert.ok(command, "Missing executable advice example");
assert.deepEqual(JSON.parse(command[1]), sample, "CLI example must match downloadable arguments");
const bounds = loadBounds();
const now = new Date();
const key = await generateEncryptionPair();
validateRequestDocument({
  protocol: bounds.protocol, revision: 1, vocabulary: bounds.vocabulary,
  marketplace_id: sample.marketplace_id, class: sample.class, tags: sample.tags,
  criteria: sample.criteria, terms: sample.terms, note: sample.note,
  expires_at: new Date(now.getTime() + sample.expires_in_hours * 3600_000).toISOString(),
  max_connections: sample.max_connections,
  offer_schema: { required: ["interest"], allowed: ["interest", ...sample.offer_fields] },
  reply_key: key.publicJwk,
}, bounds, now);
console.log(`Site checks passed: ${pages} HTML pages, ${links} local/cross-site links, ${tools.length} tools, release hashes, and executable advice example.`);
