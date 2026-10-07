import { MCP_PROTOCOL, toolDefinitions, type BridgeSecret, callTool } from "./tools.js";

const SUPPORTED = [MCP_PROTOCOL, "2025-06-18", "2025-03-26"];

type Rpc = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };

export async function handleMessage(secret: BridgeSecret, message: Rpc): Promise<Record<string, unknown> | undefined> {
  if (message.id === undefined) return undefined;
  try {
    const result = await dispatch(secret, message);
    return { jsonrpc: "2.0", id: message.id, result };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: error instanceof Error ? error.message : "Tool failed." },
    };
  }
}

async function dispatch(secret: BridgeSecret, message: Rpc): Promise<unknown> {
  switch (message.method) {
    case "initialize": {
      const requested = String((message.params?.protocolVersion as string | undefined) ?? MCP_PROTOCOL);
      return {
        protocolVersion: SUPPORTED.includes(requested) ? requested : MCP_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "dossy-mcp-bridge", version: "0.1.0" },
        instructions: "This bridge is an adapter for an existing agent. It does not read inboxes or store approval history. Background polling is not provided; the host must call list_requests.",
      };
    }
    case "tools/list":
      return { tools: toolDefinitions() };
    case "tools/call": {
      const name = String(message.params?.name ?? "");
      const args = (message.params?.arguments as Record<string, unknown> | undefined) ?? {};
      const data = await callTool(secret, name, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }], isError: false };
    }
    case "ping":
      return {};
    default:
      throw new Error("Method is not supported.");
  }
}

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

export function takeFrame(buffer: Uint8Array): { message?: Rpc; rest: Uint8Array } {
  const headerEnd = Buffer.from(buffer).indexOf("\r\n\r\n");
  if (headerEnd < 0) return { rest: buffer };
  const bytes = Buffer.from(buffer);
  const header = bytes.subarray(0, headerEnd).toString();
  const match = /Content-Length: (\d+)/i.exec(header);
  if (!match) return { rest: bytes.subarray(headerEnd + 4) };
  const length = Number(match[1]);
  const start = headerEnd + 4;
  if (buffer.length < start + length) return { rest: buffer };
  const message = JSON.parse(bytes.subarray(start, start + length).toString()) as Rpc;
  return { message, rest: bytes.subarray(start + length) };
}
