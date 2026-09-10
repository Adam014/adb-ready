<div align="center">

# ADB Ready

**Make Android development accessible to coding agents.**

An MCP-native, local-first CLI that gives agents and developers safe, typed
control of Android targets, apps, UI, logs, evidence, and development sessions.

[![MCP](https://img.shields.io/badge/MCP-native-7c3aed)](./docs/agent-integration.md)
[![CI](https://github.com/Adam014/adb-ready/actions/workflows/ci.yml/badge.svg)](https://github.com/Adam014/adb-ready/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/adb-ready?label=npm&color=1f9db5)](https://www.npmjs.com/package/adb-ready)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/Bun-tested-14151a?logo=bun&logoColor=white)](https://bun.sh/)
[![Deno](https://img.shields.io/badge/Deno_2-tested-111827?logo=deno&logoColor=white)](https://deno.com/)
[![Platforms](https://img.shields.io/badge/hosts-macOS_%C2%B7_Linux_%C2%B7_Windows-64748b)](./COMPATIBILITY.md)

[Quick start](#quick-start) · [AI agents](#android-tools-built-for-ai-agents) · [Why ADB Ready](#why-adb-ready) ·
[Workflows](#find-your-workflow) · [Documentation](#documentation) ·
[Compatibility](#compatibility)

</div>

```text
$ adb-ready dev

✓ Android target selected       Pixel 9 · wireless
✓ Localhost ports ready         8081 → 8081
✓ Development command started   pnpm run start --android
● Session healthy               watching target, ports, and logs
```

Stop rebuilding your Android setup every time a cable moves, Wi-Fi reconnects,
or ADB picks the wrong device. ADB Ready turns scattered ADB operations into
one deterministic workflow that developers, scripts, and AI agents can share.

```bash
npx adb-ready dev
```

## Android tools built for AI agents

ADB Ready turns coding agents from passive log readers into safe Android
operators. Its local MCP server exposes **19 schema-validated tools** for target
readiness, app lifecycle, UI inspection, evidence capture, and verified UI
actions—without giving the model a generic shell or unrestricted ADB access.

```bash
# Connect the current project to your coding agent
npx adb-ready agent setup codex
```

Codex, Claude Code, Cursor, VS Code/Copilot, Windsurf, and other MCP clients can:

- find and bind one deterministic Android target;
- resolve, install, launch, restart, and inspect the project app;
- inspect current UI, tap, type, swipe, press keys, and wait for state changes;
- capture screenshots and read bounded, redacted session evidence; and
- verify actions against fresh device state instead of assuming they worked.

Everything stays local unless your chosen AI client sends tool results to its
model provider. Stale UI references are rejected, destructive app removal is
not exposed to agents, and every tool returns structured evidence.

[Connect an AI agent in minutes →](./docs/agent-integration.md)

## Why ADB Ready?

### Start once. Stay ready.

ADB Ready finds one usable Android target, prepares its ports, launches your
project with the correct `ANDROID_SERIAL`, and watches the session while you
work.

### Recover without the ritual.

When a wireless target or reverse mapping disappears, recovery is bounded,
target-safe, and independently verified. It never silently restarts the shared
ADB server or rewrites another tool's mapping.

### Give agents evidence, not terminal noise.

Focused logcat, structured problems, and a saved redacted timeline keep the
important failure evidence together. Agents receive bounded, machine-readable
context and typed actions instead of guessing from an unstructured terminal.

### Keep your existing stack.

ADB Ready orchestrates the real ADB, framework, and package manager you already
use. It does not replace Android Studio or force your project onto Bun.

| Projects                              | Package managers        | CLI runtimes         |
| ------------------------------------- | ----------------------- | -------------------- |
| Expo · React Native · Gradle · custom | npm · pnpm · Yarn · Bun | Node.js · Bun · Deno |

## Quick start

You need Android SDK Platform-Tools and Node.js 22 or newer for the standard npm
entrypoint.

```bash
# Check ADB and the host
npx adb-ready doctor

# See connected and wireless targets
npx adb-ready devices

# Start the complete development session
npx adb-ready dev
```

Add it to a project when the team should share one version:

```bash
npm install --save-dev adb-ready
npx adb-ready init
npx adb-ready dev
```

Running `adb-ready` without a command opens the interactive workflow home.
`adbr` is the shorter alias for the same CLI.

[Read the five-minute setup →](./docs/getting-started.md)

## Find your workflow

| I want to…                                                  | Start here                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| launch Expo, React Native, Gradle, or my own command        | [`adb-ready dev`](./docs/dev-sessions.md)                                           |
| pair or reconnect an Android device over Wi-Fi              | [Targets and Wireless debugging](./docs/targets-and-wireless.md)                    |
| choose the right device when several are connected          | [Deterministic target selection](./docs/targets-and-wireless.md#explicit-selection) |
| expose Metro, a local API, or a debugger to Android         | [Port workflows](./docs/dev-sessions.md#port-ownership)                             |
| install, inspect, launch, restart, or deep-link my app      | [App lifecycle](./docs/apps-and-evidence.md#app-lifecycle)                          |
| save a verified screenshot or bounded screen recording      | [Evidence capture](./docs/apps-and-evidence.md#evidence-capture)                    |
| give a developer or agent one bounded app/UI snapshot       | [Structured inspection](./docs/apps-and-evidence.md#structured-inspection)          |
| safely tap, type, swipe, press keys, or wait for Android UI | [Safe UI automation](./docs/ui-automation.md)                                       |
| see only the Android logs that matter                       | [Focused logcat](./docs/logs-and-context.md#focused-logcat)                         |
| understand why the last session failed                      | [Session problems](./docs/logs-and-context.md#session-history)                      |
| prepare safe evidence for an AI assistant                   | [Diagnostic context](./docs/logs-and-context.md#diagnostic-context)                 |
| connect Codex, Claude Code, Cursor, Copilot, or Windsurf    | [`adb-ready agent setup`](./docs/agent-integration.md#connect-an-agent)             |
| share project settings without a custom shell script        | [Configuration](./docs/configuration.md)                                            |
| use ADB Ready from CI or another tool                       | [Automation contract](./docs/automation.md)                                         |
| fix a known setup or target problem                         | [Troubleshooting](./docs/troubleshooting.md)                                        |

## What happens in `adb-ready dev`?

```text
find or recover one target
        ↓
verify only the ports your project needs
        ↓
start the project on that same target
        ↓
watch target · ports · logs · child process
        ↓
recover safely or explain exactly what needs you
```

- Expo and React Native receive reverse port `8081` by default.
- Add any local service with repeated `--port` flags.
- Pass any command after `--`; it runs directly without an implicit shell.
- Existing matching mappings are reused. Conflicts are never overwritten.
- On exit, only resources created by that session are cleaned up.
- The final exit code and a bounded, redacted session record are preserved.

```bash
adb-ready dev --port 8081 --port 8000
adb-ready dev -- pnpm run android:local
adb-ready dev --dry-run --json
```

## Built for humans, agents, and automation

The interactive CLI provides keyboard navigation, live state, reduced-motion
support, narrow-terminal fallbacks, and clear recovery feedback. Scripts get a
separate deterministic contract:

```bash
adb-ready devices --json --non-interactive
adb-ready logs --package com.example.app --format ndjson
adb-ready context --since 5m --only problems,recovery,logs
```

- machine data on `stdout`, human diagnostics on `stderr`;
- versioned JSON results and NDJSON events;
- no prompt, animation, or terminal takeover in redirected/CI execution;
- stable problem categories, meaningful exit codes, timeouts, and dry runs; and
- explicit target, ADB path, and remote ADB server overrides.

Local AI agents use the same contracts through a schema-validated MCP stdio
server. The package includes a version-matched public tool schema, while target
binding, fresh-state checks, redaction, and verification remain enforced by ADB
Ready itself. [Explore the agent contract →](./docs/agent-integration.md)

## Documentation

| Guide                                                            | What it answers                                                       |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| [Getting started](./docs/getting-started.md)                     | How do I reach my first ready session?                                |
| [Development sessions](./docs/dev-sessions.md)                   | What does ADB Ready own, watch, recover, and clean up?                |
| [Targets and Wireless debugging](./docs/targets-and-wireless.md) | How are devices paired, connected, and selected safely?               |
| [Apps and evidence](./docs/apps-and-evidence.md)                 | How do I control one app and capture verified device evidence?        |
| [AI agent integration](./docs/agent-integration.md)              | How do Codex, Claude Code, Cursor, or Copilot use safe Android tools? |
| [Safe UI automation](./docs/ui-automation.md)                    | How do humans and agents act on current UI with verifiable evidence?  |
| [Logs and AI context](./docs/logs-and-context.md)                | What is captured, redacted, saved, and exported?                      |
| [Configuration](./docs/configuration.md)                         | How do projects, profiles, hooks, and precedence work?                |
| [Automation](./docs/automation.md)                               | What are the JSON, NDJSON, stdout, and exit-code contracts?           |
| [Threat model](./docs/threat-model.md)                           | Which trust boundaries, controls, and residual risks apply?           |
| [Troubleshooting](./docs/troubleshooting.md)                     | What should I do for each common failure?                             |
| [Compatibility](./COMPATIBILITY.md)                              | Which hosts, runtimes, and environments are covered?                  |
| [Example configs](./examples/README.md)                          | What can I copy for Expo, React Native, Gradle, or custom projects?   |

Run `adb-ready --help` for the full command list or
`adb-ready help COMMAND` for focused options.

## Compatibility

ADB Ready targets macOS, Linux, and Windows, with Node.js, Bun, and Deno runtime
smoke coverage. The package is architecture-neutral JavaScript with no native
addon or artificial OS/CPU block. A working ADB executable remains the only
Android transport backend.

[See tested and upstream-capable support tiers →](./COMPATIBILITY.md)

## Trust by default

- The shared ADB server is never restarted implicitly.
- Destructive or global actions are never hidden inside recovery.
- Pairing codes never enter command-line arguments.
- Session data is bounded, redacted, private to the user, and never uploaded.
- Package contents are allowlisted and checked before release.
- npm publication is prepared for short-lived OIDC credentials and provenance.
- AI clients receive typed bounded tools; raw shell/ADB and destructive app
  removal are not exposed through MCP.
- UI references are bound to the current hierarchy digest, so stale targets are
  rejected before input is sent.

## Project

[Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) ·
[Security](./SECURITY.md) · [MIT License](./LICENSE)

ADB Ready is Android-only. The current development line combines target
readiness, ports, session recovery, logs, verified app lifecycle, and local
evidence capture. It intentionally exposes typed workflows instead of a generic
remote shell.
