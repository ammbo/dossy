export const hosts: { id: string; name: string; where: string; icon: string; kind: string; key?: string }[];

export function installCommand(hostId: string): string;

export function hostPrompt(): string;

export function normalizeInvite(value: string): string;

export function pickerCss(): string;

export function assertInvite(invite: string): string;

export function serverEntry(
  nodePath: string,
  bridgePath: string,
  invite: string,
  statePath: string,
): { command: string; args: string[]; env: { DOSSY_BRIDGE_STATE: string } };

export function mergeServerJson(
  text: string,
  key: string,
  entry: { command: string; args: string[]; env: Record<string, string> },
): string;

export function codexBlock(entry: { command: string; args: string[]; env: { DOSSY_BRIDGE_STATE: string } }): string;

export function upsertCodex(source: string, block: string): { text: string; updated: boolean };

export function claudeDesktopConfig(home: string, platform: string, env?: NodeJS.ProcessEnv): string;

export function registerHost(options: {
  host: string;
  invite: string;
  bridgePath: string;
  nodePath: string;
  home: string;
  platform?: string;
  env?: NodeJS.ProcessEnv;
  run?: (file: string, args: string[]) => { missing?: boolean; status: number; stderr: string };
}): Promise<{ registered: boolean; config: string | null; command?: string[]; snippet?: string; state: string }>;
