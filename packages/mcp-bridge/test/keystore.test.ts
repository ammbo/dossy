import { mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { expect, it } from "vitest";
import { expandHome, Keystore, withStateSession } from "../src/keystore.js";
import { parseJoinLink } from "../src/join.js";

it("refuses a stale save rather than erasing a newer encryption key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dcp-state-test-"));
  try {
    const path = join(dir, "bridge.json");
    await Keystore.create(path, "https://network.example.test");
    const serving = await Keystore.open(path);
    const syncing = await Keystore.open(path);
    await serving.newKey("reply", "synthetic-request", new Date(Date.now() + 3600_000).toISOString());
    await serving.save();
    syncing.state.digest = [];
    await expect(syncing.save()).rejects.toThrow("no keys were overwritten");
    expect((await Keystore.open(path)).state.keys.reply["synthetic-request"]).toBeDefined();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("serializes saves and permits only one process session for a state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dcp-session-test-"));
  try {
    const path = join(dir, "bridge.json");
    const store = await Keystore.create(path, "https://network.example.test");
    await Promise.all([store.save(), store.save(), store.save()]);
    expect(JSON.parse(await readFile(path, "utf8")).revision).toBe(4);
    await withStateSession(path, async () => {
      await expect(withStateSession(path, async () => {})).rejects.toMatchObject({ code: "ELOCKED" });
    });
    await withStateSession(path, async () => {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("keeps a session's lock through saves inside it and reports the command's own failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dcp-session-save-test-"));
  try {
    const path = join(dir, "bridge.json");
    const store = await withStateSession(path, async () => {
      const created = await Keystore.create(path, "https://network.example.test");
      await created.save();
      await expect(withStateSession(path, async () => {})).rejects.toMatchObject({ code: "ELOCKED" });
      return created;
    });
    expect(await readdir(dir)).toEqual(["bridge.json"]);
    await expect(withStateSession(path, async () => {
      await store.save();
      throw new Error("the command failed");
    })).rejects.toThrow("the command failed");
    expect(await readdir(dir)).toEqual(["bridge.json"]);
    await withStateSession(path, async () => {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("accepts secure invitation URLs and refuses remote HTTP or URL credentials", () => {
  const secret = "synthetic_invite_123456789";
  expect(parseJoinLink(`https://network.example.test/join?invite=${secret}`)).toEqual({ network: "https://network.example.test", invite: secret });
  expect(parseJoinLink(secret)).toEqual({ network: "https://dossy.ai", invite: secret });
  expect(() => parseJoinLink("short-code")).toThrow("invite code");
  expect(() => parseJoinLink(`http://network.example.test/join?invite=${secret}`)).toThrow("HTTPS");
  expect(() => parseJoinLink(`https://user:password@network.example.test/join?invite=${secret}`)).toThrow("credentials");
});

it("reads a leading ~ in a state path as the home directory, so a host config needs no shell", () => {
  expect(expandHome("~/.dossy/bridge-claude-code.json")).toBe(join(homedir(), ".dossy/bridge-claude-code.json"));
  expect(expandHome("~")).toBe(homedir());
  expect(expandHome("/tmp/~/bridge.json")).toBe("/tmp/~/bridge.json");
  expect(expandHome("~other/bridge.json")).toBe("~other/bridge.json");
});
