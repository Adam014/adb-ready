#!/usr/bin/env node

import process from "node:process";
import { activateAgentTaskFromEnvironment } from "./agent/dev-task.js";
import { processIo, runCli } from "./cli/main.js";

const controller = new AbortController();
const abort = () => controller.abort();
process.once("SIGINT", abort);
process.once("SIGTERM", abort);

const managedTask = await activateAgentTaskFromEnvironment(process.env);
try {
  process.exitCode = await runCli(process.argv.slice(2), processIo(), {}, controller.signal);
} finally {
  await managedTask?.finish(typeof process.exitCode === "number" ? process.exitCode : 70);
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
}
