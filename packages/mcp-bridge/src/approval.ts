import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomId } from "@dossy/sdk";

/** Everything a human must see before an outward action: what leaves, to whom, and what it permits. */
export type ApprovalRequest = {
  action: string;
  title: string;
  recipient: string;
  /** The exact content the other party or the network will receive, before encryption. */
  disclosure: unknown;
  permits: string[];
  notes?: string[];
  /** One question the human answers in the same approval, with a preselected answer. */
  choice?: { title: string; options: { value: string; label: string }[]; default: string };
};

/** `choice` is the human's answer to the approval's choice, when it has one and they approved. */
export type ApprovalResult = { approved: boolean; channel: string; choice?: string };

export type ApprovalMode = "agent" | "prompt";

/** The trusted agent/host obtains consent before calling a tool. No second prompt is shown. */
export class AgentHostApprover implements Approver {
  async request(_approval: ApprovalRequest): Promise<ApprovalResult> {
    return { approved: true, channel: "agent_host" };
  }
}

export class ApprovalTimeoutError extends Error {
  readonly code = "approval_timeout";
  constructor(action: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs / 1000}s waiting for human approval of ${action}. No new action was sent. The optional approval prompt must be reachable by the human; the default agent approval mode uses consent already obtained by the agent.`);
  }
}

function chosen(approval: ApprovalRequest, value: unknown): string | undefined {
  if (!approval.choice) return undefined;
  return approval.choice.options.some((option) => option.value === value) ? String(value) : approval.choice.default;
}

/**
 * Supplies authorization for an exact disclosure. The bridge signs an action after an approver
 * returns approved for that exact disclosure. The default trusts consent obtained by the agent's
 * host; optional prompt mode asks again in a separate UI. Neither is independent proof of consent.
 */
export interface Approver {
  request(approval: ApprovalRequest): Promise<ApprovalResult>;
  close?(): Promise<void>;
}

export function renderApproval(approval: ApprovalRequest): string {
  return [
    approval.title,
    "",
    `To: ${approval.recipient}`,
    "",
    "Exactly this will be sent:",
    JSON.stringify(approval.disclosure, null, 2),
    "",
    "This permits:",
    ...approval.permits.map((item) => `- ${item}`),
    ...(approval.notes?.length ? ["", ...approval.notes.map((item) => `Note: ${item}`)] : []),
    ...(approval.choice ? ["", `${approval.choice.title}`, ...approval.choice.options.map((option) => `- ${option.value}: ${option.label}`)] : []),
    "",
    "Nothing is sent unless you approve. Declining sends nothing and leaves no trace on the network.",
  ].join("\n");
}

type Elicit = (params: Record<string, unknown>) => Promise<{ action?: string; content?: Record<string, unknown> }>;

/** Asks through the MCP host's own UI with an elicitation. The host shows it to the human, not the model. */
export class ElicitationApprover implements Approver {
  constructor(private readonly elicit: Elicit) {}

  async request(approval: ApprovalRequest): Promise<ApprovalResult> {
    const choice = approval.choice
      ? {
        choice: {
          type: "string",
          title: approval.choice.title,
          description: approval.choice.options.map((option) => `${option.value}: ${option.label}`).join(" "),
          enum: approval.choice.options.map((option) => option.value),
          default: approval.choice.default,
        },
      }
      : {};
    const response = await this.elicit({
      message: renderApproval(approval),
      requestedSchema: {
        type: "object",
        properties: {
          approve: { type: "boolean", title: "Send exactly this", description: "Approve this one action. Leave unchecked or decline to send nothing." },
          ...choice,
        },
        required: ["approve"],
      },
    });
    const approved = response.action === "accept" && response.content?.approve === true;
    return { approved, channel: "elicitation", ...(approved && approval.choice ? { choice: chosen(approval, response.content?.choice) } : {}) };
  }
}

type Pending = { approval: ApprovalRequest; nonce: string; resolve: (decision: { approved: boolean; choice?: string }) => void; settled: boolean; timer: NodeJS.Timeout };

/**
 * Serves the approval on 127.0.0.1 and opens it in the user's browser. The page address carries a
 * 128-bit token with a form nonce and origin checks. This optional prompt is not a sandbox against
 * a process that can read the user's browser or terminal. Used in prompt mode without elicitation.
 *
 * While a decision is pending, the server and its timeout keep the process alive: a CLI command has
 * nothing else to wait on. Idle, the server lets the process exit.
 */
export class BrowserApprover implements Approver {
  private server?: Server;
  private origin = "";
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly options: { timeoutMs?: number; open?: (url: string) => Promise<void> } = {},
  ) {}

  async request(approval: ApprovalRequest): Promise<ApprovalResult> {
    const server = await this.listen();
    const token = randomId();
    const timeoutMs = this.options.timeoutMs ?? 10 * 60_000;
    const decision = new Promise<{ approved: boolean; choice?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ApprovalTimeoutError(approval.action, timeoutMs)), timeoutMs);
      this.pending.set(token, { approval, nonce: randomId(), resolve, settled: false, timer });
    });
    server.ref();
    process.stderr.write(`dossy-bridge: Waiting for human approval of ${approval.action} in the local browser (up to ${timeoutMs / 1000}s). The write has not been sent. This page is on the bridge machine; a remote VM needs a reachable browser or forwarded port.\n`);
    try {
      // The approval deadline still applies if a custom browser launcher never resolves.
      void (this.options.open ?? openInBrowser)(`${this.origin}/approve/${token}`).catch(() => {
        process.stderr.write("dossy-bridge: Could not open the optional approval page. Check browser access on this machine.\n");
      });
      return { ...(await decision), channel: "browser" };
    } finally {
      clearTimeout(this.pending.get(token)?.timer);
      this.pending.delete(token);
      if (!this.pending.size) server.unref();
    }
  }

  /** Stops serving. Any approval still open is declined. */
  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      pending.settled = true;
      pending.resolve({ approved: false });
    }
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
  }

  private async listen(): Promise<Server> {
    if (this.server) return this.server;
    const server = createServer((request, response) => this.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Approval server did not bind.");
    this.origin = `http://127.0.0.1:${address.port}`;
    this.server = server;
    server.unref();
    return server;
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const headers = {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        // Not no-referrer: under that policy browsers send `Origin: null` on form posts, and the
      // origin check below would refuse the human's own decision.
      "referrer-policy": "same-origin",
    };
    const match = /^\/approve\/([A-Za-z0-9_-]{22})$/.exec(request.url ?? "");
    const pending = match ? this.pending.get(match[1] as string) : undefined;
    if (!pending || request.headers.host !== this.origin.slice("http://".length)) {
      response.writeHead(404, headers).end(page("Not found", "<p>This approval does not exist or has already been decided.</p>"));
      return;
    }
    if (request.method === "GET") {
      response.writeHead(200, headers).end(approvalPage(pending.approval, pending.nonce));
      return;
    }
    if (request.method !== "POST" || request.headers.origin !== this.origin) {
      response.writeHead(403, headers).end(page("Refused", "<p>Approvals are accepted only from this page.</p>"));
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 4096) request.destroy();
    });
    request.on("end", () => {
      const form = new URLSearchParams(body);
      if (form.get("nonce") !== pending.nonce || pending.settled) {
        response.writeHead(403, headers).end(page("Refused", "<p>This form is stale.</p>"));
        return;
      }
      pending.settled = true;
      const approved = form.get("decision") === "approve";
      pending.resolve({ approved, ...(approved && pending.approval.choice ? { choice: chosen(pending.approval, form.get("choice")) } : {}) });
      response.writeHead(200, headers).end(page(approved ? "Approved" : "Declined", approved
        ? "<p>Approved. Your agent will send exactly what you saw. You can close this tab.</p>"
        : "<p>Declined. Nothing was sent. You can close this tab.</p>"));
    });
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;color:#1d1d1f;background:#fafafa}
pre{background:#fff;border:1px solid #ddd;border-radius:8px;padding:1rem;overflow:auto;white-space:pre-wrap;word-break:break-word}
.actions{display:flex;gap:.75rem;margin-top:1.5rem}button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:1px solid #888;background:#fff;cursor:pointer}
button[value=approve]{background:#1d1d1f;color:#fff;border-color:#1d1d1f}.muted{color:#666}
fieldset{border:1px solid #ddd;border-radius:8px;padding:.75rem 1rem}fieldset label{display:block;margin:.4rem 0}
@media (prefers-color-scheme:dark){body{background:#161616;color:#eee}pre{background:#1f1f1f;border-color:#333}button{background:#222;color:#eee}button[value=approve]{background:#eee;color:#111}.muted{color:#aaa}}
</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

function approvalPage(approval: ApprovalRequest, nonce: string): string {
  const notes = approval.notes?.length ? `<ul>${approval.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>` : "";
  const choice = approval.choice
    ? `<fieldset><legend>${escapeHtml(approval.choice.title)}</legend>${approval.choice.options.map((option) =>
      `<label><input type="radio" name="choice" value="${escapeHtml(option.value)}"${option.value === approval.choice?.default ? " checked" : ""}> ${escapeHtml(option.label)}</label>`).join("")}</fieldset>`
    : "";
  return page(approval.title, `
<p><strong>To:</strong> ${escapeHtml(approval.recipient)}</p>
<p>Exactly this will be sent:</p><pre>${escapeHtml(JSON.stringify(approval.disclosure, null, 2))}</pre>
<p>This permits:</p><ul>${approval.permits.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>${notes}
<p class="muted">Nothing is sent unless you approve. Declining sends nothing and leaves no trace on the network.</p>
<form method="post"><input type="hidden" name="nonce" value="${escapeHtml(nonce)}">${choice}
<div class="actions"><button name="decision" value="approve">Approve and send</button><button name="decision" value="decline">Decline</button></div></form>`);
}

export async function openInBrowser(url: string): Promise<void> {
  if (process.env.DOSSY_BROWSER === "none") {
    process.stderr.write(`Open ${url}\n`);
    return;
  }
  const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  await new Promise<void>((resolve) => {
    const child = spawn(command as string, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {
      process.stderr.write(`Open ${url}\n`);
      resolve();
    });
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
    child.on("exit", (code) => {
      if (code) process.stderr.write(`Browser launcher exited with status ${code}. Open ${url}\n`);
    });
  });
}
