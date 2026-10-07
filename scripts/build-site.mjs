import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

import { style, layout, docsHome } from "../apps/protocol-site/template.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [join(root, "scripts/build-packages.mjs")], { cwd: root, stdio: "inherit" });
marked.use({ renderer: { heading({ tokens, depth }) { const html = this.parser.parseInline(tokens); const id = html.replace(/<[^>]+>/g, "").toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-"); return `<h${depth} id="${id}">${html}</h${depth}>\n`; } } });
const docs = join(root, "apps/protocol-site/dist");
await rm(docs, { recursive: true, force: true });
await mkdir(docs, { recursive: true });
for (const [dir, body, kind] of [[docs, docsHome, "docs"]]) {
  await writeFile(join(dir, "index.html"), layout(kind === "docs" ? "DCP — Dossy Communication Protocol" : "Dossy — Your community. Your agent. Your say.", "Personal agents consider community requests privately and share only approved responses.", body, kind));
  await writeFile(join(dir, "style.css"), style);
  await writeFile(join(dir, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#142b26"/><text x="18" y="47" fill="#d5f0bb" font-family="system-ui" font-size="48" font-weight="700">d</text></svg>');
  await writeFile(join(dir, "404.html"), layout("Page not found · Dossy", "Page not found", '<section class="hero"><h1>Nothing here yet.</h1><p><a href="/">Back to Dossy →</a></p></section>', kind));
  await writeFile(join(dir, "_headers"), "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'\n/releases/*\n  Cache-Control: public, max-age=300\n/.well-known/*\n  Cache-Control: no-cache\n");
}
const pages = [["spec", "protocol/SPEC.md"], ["quickstart", "apps/protocol-site/agent.md"], ["conformance", "conformance/README.md"], ["integrate", "integrations/adoption.md"], ["privacy", "apps/protocol-site/privacy.md"], ["changelog", "protocol/CHANGELOG.md"], ["license", "LICENSE.md"]];
for (const [slug, source] of pages) {
  const markdown = (await readFile(join(root, source), "utf8")).replace(/(\[[^\]]+\]\()([^\s)]+)(\))/g, (whole, before, href, after) => {
    if (/^(?:[a-z]+:|\/|#)/i.test(href)) return whole;
    const [path, fragment] = href.split("#");
    const target = relative(root, resolve(root, dirname(source), path));
    if (target.startsWith("..")) throw new Error(`Link escapes public source: ${href}`);
    const page = pages.find(([, file]) => file === target);
    const raw = /^(?:protocol\/(?:schemas|vocabularies)\/|protocol\/(?:bounds.json|openapi.yaml|SPEC.md|CHANGELOG.md)$)/.test(target);
    const url = page ? `/${page[0]}` : raw ? `/${target.slice("protocol/".length)}` : `https://github.com/ammbo/dossy/blob/main/${target}`;
    return before + url + (fragment ? "#" + fragment : "") + after;
  });
  await writeFile(join(docs, `${slug}.html`), layout(`${slug === "spec" ? "DCP specification" : slug[0].toUpperCase() + slug.slice(1)} · Dossy`, "Dossy Communication Protocol documentation.", `<article class="article">${marked.parse(markdown)}</article>`));
}
for (const file of ["agent.md", "install.mjs"]) await copyFile(join(root, "apps/protocol-site", file), join(docs, file));
for (const file of ["schemas", "vocabularies", "bounds.json", "openapi.yaml", "SPEC.md", "CHANGELOG.md"]) await cp(join(root, "protocol", file), join(docs, file), { recursive: true });
const releases = join(docs, "releases");
await mkdir(releases, { recursive: true });
for (const file of ["dossy-bridge.mjs", "THIRD_PARTY_NOTICES.md"]) await copyFile(join(root, "packages/mcp-bridge/dist", file), join(releases, file));
await copyFile(join(root, "LICENSE.md"), join(releases, "LICENSE.md"));
for (const folder of ["protocol", "packages/sdk", "packages/mcp-bridge"]) execFileSync("pnpm", ["pack", "--pack-destination", releases], { cwd: join(root, folder), stdio: "pipe" });
const artifact = async (file) => ({ url: `https://dossy.dev/releases/${file}`, sha256: createHash("sha256").update(await readFile(join(releases, file))).digest("hex") });
await mkdir(join(docs, ".well-known"), { recursive: true });
await writeFile(join(docs, ".well-known/dcp.json"), JSON.stringify({ protocol: "dcp/0.1", status: "draft", license: "Apache-2.0", instructions: "https://dossy.dev/agent.md", installer: "https://dossy.dev/install.mjs", minimum_node_major: 24, bridge: await artifact("dossy-bridge.mjs"), notices: await Promise.all([artifact("LICENSE.md"), artifact("THIRD_PARTY_NOTICES.md")]), network_discovery_path: "/.well-known/dcp", source: "https://github.com/ammbo/dossy" }, null, 2));
console.log("Built protocol site and verified downloads.");
