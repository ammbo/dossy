// An approval may carry one question with a preselected answer, such as the standing grant shown
// with joining. Both approval channels show it and return the human's answer.
import { describe, expect, it } from "vitest";
import { BrowserApprover, ElicitationApprover, renderApproval, type ApprovalRequest } from "../src/approval.js";

const approval: ApprovalRequest = {
  action: "join_network",
  title: "Connect this agent to Dossy",
  recipient: "https://dossy.ai",
  disclosure: { contact_email: "ana@example.test" },
  permits: ["Dossy emails ana@example.test a link"],
  choice: {
    title: "What may your agent do without asking each time?",
    options: [{ value: "recommended", label: "Housekeeping" }, { value: "ask", label: "Nothing" }],
    default: "recommended",
  },
};

describe("an approval with a choice", () => {
  it("asks by elicitation with the answer preselected, and returns it only on approval", async () => {
    let schema: Record<string, unknown> = {};
    const answer = (content: Record<string, unknown>, action = "accept") => new ElicitationApprover(async (params) => {
      schema = params.requestedSchema as Record<string, unknown>;
      return { action, content };
    }).request(approval);
    await expect(answer({ approve: true, choice: "ask" })).resolves.toEqual({ approved: true, channel: "elicitation", choice: "ask" });
    expect((schema.properties as Record<string, unknown>).choice).toMatchObject({ enum: ["recommended", "ask"], default: "recommended" });
    expect(schema.required).toEqual(["approve"]);
    await expect(answer({ approve: true, choice: "everything" })).resolves.toMatchObject({ choice: "recommended" });
    await expect(answer({ approve: true })).resolves.toMatchObject({ choice: "recommended" });
    await expect(answer({ approve: false, choice: "ask" })).resolves.toEqual({ approved: false, channel: "elicitation" });
    await expect(answer({}, "decline")).resolves.toEqual({ approved: false, channel: "elicitation" });
    expect(renderApproval(approval)).toContain("ask: Nothing");
  });

  it("shows it on the local page with the answer checked, and returns the human's answer", async () => {
    let url = "";
    const approver = new BrowserApprover({ open: async (address) => { url = address; } });
    try {
      const decision = approver.request(approval);
      while (!url) await new Promise((resolve) => setTimeout(resolve, 5));
      const page = await (await fetch(url)).text();
      expect(page).toContain('value="recommended" checked');
      expect(page).toContain("What may your agent do without asking each time?");
      const nonce = /name="nonce" value="([^"]+)"/.exec(page)?.[1] ?? "";
      const origin = new URL(url).origin;
      await fetch(url, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ nonce, decision: "approve", choice: "ask" }).toString() });
      await expect(decision).resolves.toEqual({ approved: true, channel: "browser", choice: "ask" });
    } finally {
      await approver.close();
    }
  });
});
