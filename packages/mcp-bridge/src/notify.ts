import { spawn } from "node:child_process";
import type { NotificationChannel } from "./keystore.js";

export type NotificationRoute = "urgent" | "digest";
export type MatchSummary = { count: number; watches: string[]; route: NotificationRoute };
export type Notifier = (channel: NotificationChannel, summary: MatchSummary) => Promise<void>;

/**
 * Tells the human that new requests are waiting through their local notification preferences. A
 * desktop notification carries only a count. A command runs exactly as the human approved it,
 * with the count and watch names in environment variables, never in the command line, so text
 * from a request can never reach a shell.
 */
export const notifyHuman: Notifier = async (notify, summary) => {
  if (!notify || notify.kind === "none" || summary.count === 0) return;
  const message = `${summary.count} ${summary.route === "urgent" ? "urgent " : ""}Dossy request${summary.count === 1 ? "" : "s"} waiting. Ask your agent to check.`;
  if (notify.kind === "desktop") {
    if (process.platform === "darwin") await run("osascript", ["-e", `display notification "${message}" with title "Dossy"`]);
    else if (process.platform === "linux") await run("notify-send", ["Dossy", message]);
    return;
  }
  if (notify.kind === "command" && notify.command) {
    await run(notify.command, [], { shell: true, env: { DOSSY_MATCH_COUNT: String(summary.count), DOSSY_MATCHED_WATCHES: summary.watches.join("\n"), DOSSY_NOTIFICATION_ROUTE: summary.route, DOSSY_MESSAGE: message } });
  }
};

function run(command: string, args: string[], options: { shell?: boolean; env?: Record<string, string> } = {}): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true, shell: options.shell ?? false, env: { ...process.env, ...options.env } });
    child.on("error", () => resolve());
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
