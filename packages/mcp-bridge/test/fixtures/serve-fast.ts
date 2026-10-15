// Uses the production server and lease, with only the five-minute timer shortened for crash tests.
import { Bridge } from "../../src/bridge.js";
import { Keystore } from "../../src/keystore.js";
import { serve } from "../../src/server.js";

const store = await Keystore.open(process.argv[2]!);
await serve({
  input: process.stdin,
  output: process.stdout,
  connect: async approver => {
    const bridge = await Bridge.start(store, approver);
    const sync = bridge.syncToDigest.bind(bridge);
    bridge.syncToDigest = async () => { process.stderr.write("sync-owner\n"); return sync(); };
    return bridge;
  },
  syncIntervalMs: 200,
  leaseCheckMs: 50,
});
