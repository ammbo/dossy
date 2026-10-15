export const BRIDGE_VERSION: string;

export const BRIDGE_PACKAGE: string;

export const hosts: { id: string; name: string; where: string; icon: string; kind: string; key?: string }[];

export function installCommand(hostId: string): string;

export function hostPrompt(): string;

export function normalizeInvite(value: string): string;

export function pickerCss(): string;

export function assertInvite(invite: string): string;

/** Environment variables. Not NodeJS.ProcessEnv, which an app may extend with required keys. */
type Env = Record<string, string | undefined>;

type Launch = { command: string; args: string[]; env: Record<string, string> };

type Entry = { command: string; args: string[]; env: Record<string, string> };

export function nodeHome(options: {
  nodePath: string;
  platform?: string;
  env?: Env;
  realpath?: (path: string) => string;
}): { dir: string; node: string; PATH: string };

export function npxLauncher(options: {
  nodePath: string;
  platform?: string;
  env?: Env;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
}): Launch | undefined;

export function standaloneLauncher(nodePath: string, bridgePath: string): Launch;

export function serverEntry(launch: Launch, invite: string | undefined, statePath: string): Entry;

export function mergeServerJson(text: string, key: string, entry: Entry & Record<string, unknown>): string;

export function mergeJsonFile(
  path: string,
  key: string,
  entry: Entry & Record<string, unknown>,
  options?: { create?: boolean; now?: Date },
): Promise<{ updated: boolean; backup?: string; reason?: string }>;

export function codexBlock(entry: Entry): string;

export function upsertCodex(source: string, block: string): { text: string; updated: boolean };

export function claudeDesktopConfig(home: string, platform: string, env?: Env): string;

export function claudeCodeConfig(home: string, env?: Env): string;

export function registerHost(options: {
  host: string;
  invite: string;
  launch: Launch;
  home: string;
  platform?: string;
  env?: Env;
  run?: (file: string, args: string[]) => { missing?: boolean; status: number; stderr: string };
  now?: Date;
}): Promise<{
  registered: boolean;
  config: string | null;
  command?: string[];
  snippet?: string;
  detail?: string;
  backup?: string;
  state: string;
}>;
