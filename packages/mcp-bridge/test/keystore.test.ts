import { mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { expect, it } from "vitest";
import { expandHome, Keystore, withStateSession } from "../src/keystore.js";
import { parseJoinLink } from "../src/join.js";

it("merges a stale save without erasing a newer encryption key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dcp-state-test-"));
  try {
    const path = join(dir, "bridge.json");
    await Keystore.create(path, "https://network.example.test");
    const serving = await Keystore.open(path);
    const syncing = await Keystore.open(path);
    await serving.newKey("reply", "synthetic-request", new Date(Date.now() + 3600_000).toISOString());
    await serving.save();
    syncing.state.digest = [];
    await syncing.save();
    expect((await Keystore.open(path)).state.keys.reply["synthetic-request"]).toBeDefined();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("preserves concurrent collections, removals, grants, receipts and caches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dcp-merge-test-"));
  try {
    const path = join(dir, "bridge.json");
    const original = await Keystore.create(path, "https://network.example.test");
    original.state.followed = ["remove-me"];
    original.state.watches = [{ name: "old", intent: "remove this" }];
    await original.save();
    const a = await Keystore.open(path);
    const b = await Keystore.open(path);
    const until = new Date(Date.now() + 3600_000).toISOString();
    a.state.followed = ["a"];
    b.state.followed!.push("b");
    a.state.watches = [{ name: "a", intent: "first" }];
    b.state.watches!.push({ name: "b", intent: "second" });
    a.state.grant = { standing_actions: [], notify: { kind: "none" }, approved_at: new Date().toISOString() };
    a.state.fetched = { a: { request_id: "a", expires_at: until } };
    b.state.fetched = { b: { request_id: "b", expires_at: until } };
    a.state.cursors.network = { phase: "feed", feedCursor: "opaque-new-cursor" };
    b.state.digest = [{ request_id: "b", expires_at: until }];
    const receipt = { at: new Date().toISOString(), action: "test", object: { type: "request", id: "test" }, recipient: "test", payload_digest: "test", authorization_ref: "a", disclosure: {}, channel: "test", approved: true };
    a.record(receipt);
    b.record({ ...receipt, authorization_ref: "b" });
    a.state.outbox.push({ operation_id: "a", method: "test", args: [], queued_at: receipt.at, keep_until: until });
    b.state.outbox.push({ operation_id: "b", method: "test", args: [], queued_at: receipt.at, keep_until: until });
    await Promise.all([a.save(), b.save()]);
    const saved = (await Keystore.open(path)).state;
    expect(saved.followed?.sort()).toEqual(["a", "b"]);
    expect(saved.watches?.map(w => w.name).sort()).toEqual(["a", "b"]);
    expect(saved.grant).toEqual(a.state.grant);
    expect(Object.keys(saved.fetched!).sort()).toEqual(["a", "b"]);
    expect(saved.cursors.network.feedCursor).toBe("opaque-new-cursor");
    expect(saved.receipts.map(r => r.authorization_ref).sort()).toEqual(["a", "b"]);
    expect(saved.outbox.map(item => item.operation_id).sort()).toEqual(["a", "b"]);
    // A stale session cannot resurrect an acknowledged action or cleared digest.
    const stale = await Keystore.open(path);
    const clearing = await Keystore.open(path);
    clearing.state.outbox = [];
    clearing.state.digest = [];
    await clearing.save();
    stale.state.followed!.push("c");
    await stale.save();
    expect((await Keystore.open(path)).state).toMatchObject({ outbox: [], digest: [] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("concurrent first starts adopt one signing identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dcp-create-test-"));
  try {
    const path = join(dir, "bridge.json");
    const stores = await Promise.all(Array.from({ length: 3 }, () => Keystore.create(path, "https://network.example.test")));
    expect(new Set(stores.map(store => JSON.stringify(store.state.signing_jwk))).size).toBe(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("keeps each approved grant whole instead of combining concurrent approvals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dcp-grant-test-"));
  try {
    const path = join(dir, "bridge.json");
    const original = await Keystore.create(path, "https://network.example.test");
    original.state.grant = { standing_actions: ["create_board"], notify: { kind: "none" }, approved_at: "before" };
    await original.save();
    const a = await Keystore.open(path), b = await Keystore.open(path);
    a.state.grant = { standing_actions: ["create_board", "withdraw"], notify: { kind: "none" }, approved_at: "a" };
    b.state.grant = { standing_actions: ["create_board"], notify: { kind: "desktop" }, approved_at: "b" };
    await a.save();
    await b.save();
    expect((await Keystore.open(path)).state.grant).toEqual(b.state.grant);
    expect(b.state.grant.standing_actions).not.toContain("withdraw");
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
