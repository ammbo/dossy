#!/usr/bin/env node
// Runs the TypeScript sources through tsx until the package ships a compiled build.
import { register } from "tsx/esm/api";

register();
await import("../src/main.ts");
