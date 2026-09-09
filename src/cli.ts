#!/usr/bin/env node

import process from "node:process";

const VERSION = "0.0.0";

const HELP = `ADB Ready

Make an Android target ready, then keep the development session working.

Usage:
  adb-ready [command] [options]
  adbr [command] [options]

Commands:
  doctor       Inspect the local ADB environment
  devices      List visible Android targets

Options:
  -h, --help       Show help
  -V, --version    Show version
`;

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  process.stdout.write(HELP);
} else if (args.includes("--version") || args.includes("-V")) {
  process.stdout.write(`${VERSION}\n`);
} else {
  process.stderr.write(`Unknown command or option: ${args[0]}\nRun adb-ready --help for usage.\n`);
  process.exitCode = 2;
}
