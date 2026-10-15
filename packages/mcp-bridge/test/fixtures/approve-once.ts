// Asks for one browser approval the way `dossy-bridge call` does: nothing else keeps the process
// alive while the human decides. Prints the decision. An optional argument overrides the timeout.
import { BrowserApprover } from "../../src/approval.js";

const timeoutMs = process.argv[2] ? Number(process.argv[2]) : undefined;
const approver = new BrowserApprover({ timeoutMs });
void (async () => {
  try {
    const result = await approver.request({
      action: "update_grant",
      title: "Change what your agent may do without asking",
      recipient: "Nobody. This stays on this machine.",
      disclosure: { standing_actions: [], notify: { kind: "none" } },
      permits: ["Your agent asks you before every action"],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await approver.close(); }
})();
