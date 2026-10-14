import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

import { style, layout, docsHome, docPages, documentation, headingId, escapeHtml } from "../apps/protocol-site/template.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [join(root, "scripts/build-packages.mjs")], { cwd: root, stdio: "inherit" });
marked.use({ renderer: { heading({ tokens, depth }) { const html = this.parser.parseInline(tokens); return `<h${depth} id="${headingId(html)}">${html}</h${depth}>\n`; } } });
const docs = join(root, "apps/protocol-site/dist");
await rm(docs, { recursive: true, force: true });
await mkdir(docs, { recursive: true });
for (const [dir, body, kind] of [[docs, docsHome, "docs"]]) {
  await writeFile(join(dir, "index.html"), layout("Dossy documentation — Connect your personal agent", "Setup, examples, privacy, and integration guides for personal agents using Dossy and the open DCP protocol.", body, kind));
  await writeFile(join(dir, "style.css"), style);
  await writeFile(join(dir, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#142b26"/><text x="18" y="47" fill="#d5f0bb" font-family="system-ui" font-size="48" font-weight="700">d</text></svg>');
  await writeFile(join(dir, "404.html"), layout("Page not found · Dossy", "Page not found", '<section class="hero"><h1>That page is missing.</h1><p><a href="/">Browse the documentation →</a></p></section>', kind, { path: "/404", noindex: true }));
  await writeFile(join(dir, "_headers"), "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'\n/releases/*\n  Cache-Control: public, max-age=300\n/.well-known/*\n  Cache-Control: no-cache\n");
}
const tools = JSON.parse(execFileSync(process.execPath, [join(root, "packages/mcp-bridge/dist/dossy-bridge.mjs"), "tools"], { encoding: "utf8" })).tools;
for (const page of docPages) {
  const { slug, source } = page;
  let markdown = (await readFile(join(root, source), "utf8")).replace(/(\[[^\]]+\]\()([^\s)]+)(\))/g, (whole, before, href, after) => {
    if (/^(?:[a-z]+:|\/|#)/i.test(href)) return whole;
    const [path, fragment] = href.split("#");
    const target = relative(root, resolve(root, dirname(source), path));
    if (target.startsWith("..")) throw new Error(`Link escapes public source: ${href}`);
    const linkedPage = docPages.find((page) => page.source === target);
    const raw = /^(?:protocol\/(?:schemas|vocabularies)\/|protocol\/(?:bounds.json|openapi.yaml|SPEC.md|CHANGELOG.md)$)/.test(target);
    const url = linkedPage ? `/${linkedPage.slug}` : raw ? `/${target.slice("protocol/".length)}` : `https://github.com/ammbo/dossy/blob/main/${target}`;
    return before + url + (fragment ? "#" + fragment : "") + after;
  });
  if (slug === "tools") {
    markdown += "\n" + tools.map((tool) => `[\`${tool.name}\`](#${headingId(tool.name)})`).join(" · ") + "\n";
    markdown += tools.map((tool) => {
      const required = tool.inputSchema.required ?? [];
      const label = tool.name === "join_community" ? "Membership action · explicit human instruction" : tool.annotations?.readOnlyHint ? "Read operation" : "Human approval required";
      const parameters = Object.entries(tool.inputSchema.properties).map(([name, schema]) => `| \`${name}\` | ${required.includes(name) ? "Required" : "Optional"} | ${escapeHtml(schema.description ?? "See schema below.").replace(/\|/g, "&#124;")} |`).join("\n");
      return `\n### ${tool.name}\n\n${tool.description}\n\n<p class="tool-meta">${label}</p>\n\n${parameters ? `| Argument | Required? | Meaning |\n| --- | --- | --- |\n${parameters}\n\n` : "Takes no arguments.\n\n"}<details><summary>Complete JSON input schema</summary><pre><code>${escapeHtml(JSON.stringify(tool.inputSchema, null, 2))}</code></pre></details>\n`;
    }).join("\n");
  }
  const rendered = marked.parse(markdown);
  const html = /<h1(?:\s|>)/.test(rendered) ? rendered : `<h1 id="${headingId(page.title)}">${escapeHtml(page.title)}</h1>\n${rendered}`;
  const headings = [...html.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)].map((match) => ({ id: match[1], title: match[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&") }));
  await writeFile(join(docs, `${slug}.html`), layout(`${page.title} · Dossy`, page.description, documentation(page, html, headings), "docs", { path: `/${slug}` }));
}
await cp(join(root, "docs/examples"), join(docs, "sample-requests"), { recursive: true });
await writeFile(join(docs, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["", ...docPages.map((p) => p.slug)].map((slug) => `<url><loc>https://dossy.dev/${slug}</loc></url>`).join("")}</urlset>`);
await writeFile(join(docs, "robots.txt"), "User-agent: *\nAllow: /\nSitemap: https://dossy.dev/sitemap.xml\n");
for (const file of ["agent.md", "install.mjs"]) await copyFile(join(root, "apps/protocol-site", file), join(docs, file));
for (const file of ["schemas", "vocabularies", "bounds.json", "openapi.yaml", "SPEC.md", "CHANGELOG.md"]) await cp(join(root, "protocol", file), join(docs, file), { recursive: true });
const releases = join(docs, "releases");
await mkdir(releases, { recursive: true });
for (const file of ["dossy-bridge.mjs", "THIRD_PARTY_NOTICES.md"]) await copyFile(join(root, "packages/mcp-bridge/dist", file), join(releases, file));
await copyFile(join(root, "LICENSE.md"), join(releases, "LICENSE.md"));
for (const folder of ["protocol", "packages/sdk", "packages/mcp-bridge"]) execFileSync("pnpm", ["pack", "--pack-destination", releases], { cwd: join(root, folder), stdio: "pipe" });
const artifact = async (file) => ({ url: `https://dossy.dev/releases/${file}`, sha256: createHash("sha256").update(await readFile(join(releases, file))).digest("hex") });
await mkdir(join(docs, ".well-known"), { recursive: true });
const { protocol } = JSON.parse(await readFile(join(root, "protocol/bounds.json"), "utf8"));
await writeFile(join(docs, ".well-known/dcp.json"), JSON.stringify({ protocol, status: "draft", license: "Apache-2.0", instructions: "https://dossy.dev/agent.md", installer: "https://dossy.dev/install.mjs", minimum_node_major: 24, bridge: await artifact("dossy-bridge.mjs"), notices: await Promise.all([artifact("LICENSE.md"), artifact("THIRD_PARTY_NOTICES.md")]), network_discovery_path: "/.well-known/dcp", source: "https://github.com/ammbo/dossy" }, null, 2));
console.log(`Built documentation home, ${docPages.length} guides, ${tools.length} tool definitions, and verified downloads.`);
