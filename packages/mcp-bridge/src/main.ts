import { readFileSync } from "node:fs";
import { encodeFrame, handleMessage, takeFrame } from "./stdio.js";
import type { BridgeSecret } from "./tools.js";

const secret = JSON.parse(readFileSync(process.env.DOSSY_SECRET_FILE ?? "", "utf8")) as BridgeSecret;
let buffer: Uint8Array = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]) as Buffer;
  for (;;) {
    const frame = takeFrame(buffer);
    buffer = frame.rest;
    if (!frame.message) return;
    void handleMessage(secret, frame.message).then((response) => {
      if (response) process.stdout.write(encodeFrame(response));
    });
  }
});

export type { BridgeSecret };
