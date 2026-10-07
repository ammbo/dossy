import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { BrowserApprover, serve, type Approver, type Bridge } from "../src/index.js";

type Rpc = { id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string } };

/** An MCP host over in-memory stdio. */
function host(connect: (approver: Approver) => Promise<Bridge>) {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = serve({ input, output, connect, fallbackApprover: () => ({ request: async () => ({ approved: false, channel: "test" }) }) });
  const inbox: Rpc[] = [];
  const waiters: (() => void)[] = [];
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      inbox.push(JSON.parse(buffer.slice(0, newline)) as Rpc);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      waiters.splice(0).forEach((wake) => wake());
    }
  });
  const next = async (match: (message: Rpc) => boolean): Promise<Rpc> => {
    for (;;) {
      const index = inbox.findIndex(match);
      if (index >= 0) return inbox.splice(index, 1)[0] as Rpc;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  let id = 0;
  return {
    send: (message: Rpc) => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`),
    raw: (line: string) => input.write(`${line}\n`),
    call: async (method: string, params: Record<string, unknown> = {}) => {
      const callId = ++id;
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: callId, method, params })}\n`);
      return next((message) => message.id === callId);
    },
    next,
    close: async () => {
      input.end();
      await done;
    },
  };
}

const fakeBridge = (approver: Approver) => ({
  networkStatus: async () => ({ network: "https://network.test" }),
  withdraw: async (resource: string, id: string) => {
    const decision = await approver.request({ action: "withdraw", title: `Withdraw ${resource} ${id}`, recipient: "The network", disclosure: { withdraw: { resource, id } }, permits: ["Closes it"] });
    return decision.approved ? { sent: true } : { sent: false, declined: true };
  },
}) as unknown as Bridge;

describe("MCP stdio server", () => {
  it("speaks newline-delimited JSON-RPC and lists typed tools without account powers", async () => {
    const mcp = host(async (approver) => fakeBridge(approver));
    const init = await mcp.call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    expect(init.result?.protocolVersion).toBe("2025-06-18");
    expect(String(init.result?.instructions)).toContain("Silence is the default");
    const unknown = await mcp.call("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
    expect(unknown.result?.protocolVersion).toBe("2025-11-25");
    const listed = (await mcp.call("tools/list")).result?.tools as { name: string; inputSchema: Record<string, unknown> }[];
    expect(listed.length).toBeGreaterThan(10);
    for (const tool of listed) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    expect(listed.map((tool) => tool.name)).not.toContain("register_agent");
    expect(listed.map((tool) => tool.name)).not.toContain("revoke_agent");
    const status = await mcp.call("tools/call", { name: "network_status", arguments: {} });
    expect(status.result?.structuredContent).toEqual({ network: "https://network.test" });
    await mcp.close();
  });

  it("asks the host for approval by elicitation, and a decline sends nothing", async () => {
    const mcp = host(async (approver) => fakeBridge(approver));
    await mcp.call("initialize", { protocolVersion: "2025-11-25", capabilities: { elicitation: {} } });
    const call = mcp.call("tools/call", { name: "withdraw", arguments: { resource: "offer", id: "offer-1" } });
    const elicitation = await mcp.next((message) => message.method === "elicitation/create");
    expect(String(elicitation.params?.message)).toContain('"id": "offer-1"');
    expect(String(elicitation.params?.message)).toContain("Nothing is sent unless you approve");
    mcp.send({ id: elicitation.id, result: { action: "decline" } });
    const result = await call;
    expect(result.result?.structuredContent).toEqual({ sent: false, declined: true });

    const approvedCall = mcp.call("tools/call", { name: "withdraw", arguments: { resource: "offer", id: "offer-2" } });
    const second = await mcp.next((message) => message.method === "elicitation/create");
    mcp.send({ id: second.id, result: { action: "accept", content: { approve: true } } });
    expect((await approvedCall).result?.structuredContent).toEqual({ sent: true });
    await mcp.close();
  });

  it("refuses private keys as arguments, unknown tools, unknown methods, and bad JSON", async () => {
    const mcp = host(async (approver) => fakeBridge(approver));
    await mcp.call("initialize", { capabilities: {} });
    const secret = await mcp.call("tools/call", { name: "network_status", arguments: { signing_jwk: { d: "secret" } } });
    expect(secret.result?.isError).toBe(true);
    expect((await mcp.call("tools/call", { name: "register_agent", arguments: {} })).error?.code).toBe(-32602);
    expect((await mcp.call("resources/list")).error?.code).toBe(-32601);
    mcp.raw("{not json");
    expect((await mcp.next((message) => message.id === null)).error?.code).toBe(-32700);
    await mcp.close();
  });
});

describe("browser approval page", () => {
  it("shows the exact disclosure and accepts a decision only from its own page", async () => {
    let url = "";
    const approver = new BrowserApprover({ open: async (address) => { url = address; }, timeoutMs: 5000 });
    const decision = approver.request({ action: "submit_offer", title: "Reply", recipient: "The requester", disclosure: { interest: true, note: "<script>x</script>" }, permits: ["Read until tomorrow"] });
    while (!url) await new Promise((resolve) => setTimeout(resolve, 5));
    const page = await (await fetch(url)).text();
    expect(page).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(page).not.toContain("<script>x</script>");
    const nonce = /name="nonce" value="([^"]+)"/.exec(page)?.[1] ?? "";
    const origin = new URL(url).origin;
    const forged = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.test" }, body: `nonce=${nonce}&decision=approve` });
    expect(forged.status).toBe(403);
    const guessed = await fetch(`${origin}/approve/${"A".repeat(22)}`);
    expect(guessed.status).toBe(404);
    const real = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin }, body: `nonce=${nonce}&decision=approve` });
    expect(real.status).toBe(200);
    expect(await decision).toEqual({ approved: true, channel: "browser" });
    await approver.close();
  });
});
