#!/usr/bin/env node

import process from "node:process";
import { processIo, runCli } from "./cli/main.js";

const controller = new AbortController();
const abort = () => controller.abort();
process.once("SIGINT", abort);
process.once("SIGTERM", abort);

try {
  process.exitCode = await runCli(process.argv.slice(2), processIo(), {}, controller.signal);
} finally {
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
}
