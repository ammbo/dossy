import type { Readable, Writable } from "node:stream";
import { BrowserApprover, ElicitationApprover, type Approver } from "./approval.js";
import { Bridge, ToolError } from "./bridge.js";
import { findTool, INSTRUCTIONS, rejectSecretArguments, toolDefinitions } from "./tools.js";

// MCP over stdio: one JSON-RPC message per line, UTF-8, no embedded newlines.
export const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

type Message = { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };

const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export type ServeOptions = {
  input: Readable;
  output: Writable;
  /** Starts the bridge once the host has said which approval channel it supports. */
  connect: (approver: Approver) => Promise<Bridge>;
  /** Used when the host cannot elicit. Defaults to a local page opened in the browser. */
  fallbackApprover?: () => Approver;
};

/** Runs the MCP stdio server until input ends. Requests are handled concurrently, so a tool call that waits for an approval never blocks the approval's own response. */
export function serve(options: ServeOptions): Promise<void> {
  const pending = new Map<string, (message: Message) => void>();
  let nextId = 1;
  let bridge: Promise<Bridge> | undefined;
  let clientCanElicit = false;
  let work: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = work.then(fn);
    work = result.catch(() => {});
    return result;
  };

  const write = (message: Message) => {
    options.output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = `bridge-${nextId++}`;
      pending.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve((message.result ?? {}) as Record<string, unknown>)));
      write({ id, method, params });
    });

  const approver = (): Approver => clientCanElicit
    ? new ElicitationApprover((params) => request("elicitation/create", params))
    : (options.fallbackApprover ?? (() => new BrowserApprover()))();

  const ready = () => {
    bridge ??= options.connect(approver()).catch((error: unknown) => {
      bridge = undefined;
      throw error;
    });
    return bridge;
  };

  const handle = async (message: Message): Promise<unknown> => {
    switch (message.method) {
      case "initialize": {
        const params = message.params ?? {};
        const requested = String(params.protocolVersion ?? SUPPORTED_VERSIONS[0]);
        clientCanElicit = Boolean((params.capabilities as Record<string, unknown> | undefined)?.elicitation);
        return {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "dossy-mcp-bridge", version: "0.2.0" },
          instructions: INSTRUCTIONS,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: toolDefinitions() };
      case "tools/call": {
        const name = String(message.params?.name ?? "");
        const tool = findTool(name);
        if (!tool) throw Object.assign(new Error(`Unknown tool ${name}.`), { rpcCode: INVALID_PARAMS });
        const args = (message.params?.arguments as Record<string, unknown> | undefined) ?? {};
        try {
          rejectSecretArguments(args);
          const connected = await ready();
          const result = await exclusive(() => tool.run(connected, args));
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false };
        } catch (error) {
          const text = error instanceof ToolError || error instanceof Error ? error.message : "The tool failed.";
          return { content: [{ type: "text", text }], isError: true };
        }
      }
      default:
        throw Object.assign(new Error(`Method ${String(message.method)} is not supported.`), { rpcCode: METHOD_NOT_FOUND });
    }
  };

  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (bridge) void exclusive(async () => { await (await ready()).syncToDigest(); }).catch(() => {});
    }, 5 * 60_000);
    timer.unref();
    let buffer = "";
    options.input.setEncoding("utf8");
    options.input.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        let message: Message;
        try {
          message = JSON.parse(line) as Message;
        } catch {
          write({ id: null, error: { code: PARSE_ERROR, message: "Parse error." } });
          continue;
        }
        if (message.method === undefined && message.id !== undefined && message.id !== null) {
          pending.get(String(message.id))?.(message);
          pending.delete(String(message.id));
          continue;
        }
        if (message.id === undefined || message.id === null) continue;
        const id = message.id;
        void handle(message).then(
          (result) => write({ id, result }),
          (error: Error & { rpcCode?: number }) => write({ id, error: { code: error.rpcCode ?? INTERNAL_ERROR, message: error.message } }),
        );
      }
    });
    options.input.on("end", () => { clearInterval(timer); void work.finally(() => resolve()); });
  });
}
