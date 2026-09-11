<div align="center">

# ADB Ready

**The local Android runtime for coding agents.**

Prepare one Android target, run your project, operate the app, and return
verified evidence—for developers, agents, and CI.

[![MCP](https://img.shields.io/badge/MCP-native-7c3aed)](./docs/agent-integration.md)
[![CI](https://github.com/Adam014/adb-ready/actions/workflows/ci.yml/badge.svg)](https://github.com/Adam014/adb-ready/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/badge/LCOV-%E2%89%A590%25-16a34a)](https://github.com/Adam014/adb-ready/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/adb-ready?label=npm&color=1f9db5)](https://www.npmjs.com/package/adb-ready)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/Bun-tested-14151a?logo=bun&logoColor=white)](https://bun.sh/)
[![Deno](https://img.shields.io/badge/Deno_2-tested-111827?logo=deno&logoColor=white)](https://deno.com/)
[![Flutter](https://img.shields.io/badge/Flutter-supported-02569B?logo=flutter&logoColor=white)](./docs/dev-sessions.md)
[![Capacitor](https://img.shields.io/badge/Capacitor-supported-119EFF?logo=capacitor&logoColor=white)](./docs/dev-sessions.md)
[![Platforms](https://img.shields.io/badge/hosts-macOS_%C2%B7_Linux_%C2%B7_Windows-64748b)](./COMPATIBILITY.md)

[Quick start](#quick-start) · [What it does](#what-adb-ready-does) ·
[AI agents](#with-a-coding-agent) · [CI](#in-ci-and-automation) ·
[Documentation](#documentation)

<img src="https://raw.githubusercontent.com/Adam014/adb-ready/main/docs/assets/adb-ready-demo.gif" alt="ADB Ready prepares an Android development session, verifies the app UI, and lets a coding agent recover lost localhost access." width="1120" />

</div>

## Quick start

Install ADB Ready in the Android project your team wants to run:

**npm** · default

```bash
npm install --save-dev adb-ready
npx adb-ready dev
```

<details>
<summary><strong>Use pnpm, Yarn, or Bun</strong></summary>

#### pnpm

```bash
pnpm add --save-dev adb-ready
pnpm exec adb-ready dev
```

#### Yarn

```bash
yarn add --dev adb-ready
yarn adb-ready dev
```

#### Bun

```bash
bun add --dev adb-ready
bunx adb-ready dev
```

</details>

ADB Ready handles the state around ADB that a person, script, or coding agent
should not guess: which device belongs to the run, whether the app is ready,
which ports and processes the session owns, and what evidence survives a
failure. It orchestrates your real ADB and framework tools; it does not replace
them or require an ADB Ready account, hosted service, or model API key.

Running `adb-ready` without a command opens the interactive workflow home.
`adbr` is the shorter alias for the same CLI.

## What ADB Ready does

- [**Run the project**](./docs/dev-sessions.md) — select one target, prepare
  ports, launch the framework, and keep the session healthy.
- [**Connect the device**](./docs/targets-and-wireless.md) — discover, pair,
  reconnect, and deterministically bind a physical device or emulator.
- [**Operate the app**](./docs/apps-and-evidence.md#app-lifecycle) — resolve,
  install, launch, restart, deep-link, and inspect the project app.
- [**Verify the UI**](./docs/ui-automation.md) — find semantic elements, act
  by intent, assert state, and capture the screen.
- [**Debug with evidence**](./docs/logs-and-context.md) — keep focused logs,
  session history, screenshots, recordings, and redacted context together.
- [**Automate a real device**](./docs/automation.md#run-one-bounded-verification)
  — gate a finite command on readiness and return stable results, reports, and
  artifacts.

## Choose how you work

### With a coding agent

Connect the current project to Codex, Claude Code, Cursor, VS Code/Copilot,
Windsurf, or another MCP client:

```bash
npx adb-ready agent setup codex
```

Then ask for the outcome you want:

> Start this Expo app on my Android phone, wait until the login screen is
> actually ready, verify my change, and keep the failure evidence.

The local MCP server gives agents typed tools for target readiness, durable
development sessions, app lifecycle, semantic UI, logs, screenshots, and saved
evidence. Every result is schema-validated and checked against fresh device
state. Agents do not receive a generic shell, unrestricted raw ADB, or app
removal.

[Connect an AI agent in minutes →](./docs/agent-integration.md)

### From your terminal

Check the host, inspect visible targets, and start the complete development
loop:

```bash
npx adb-ready doctor
npx adb-ready devices
npx adb-ready dev
```

Expo, React Native, Flutter, Capacitor, Gradle, and custom commands all run
against the same selected target through `ANDROID_SERIAL`. Add local services
with repeated `--port` flags or replace the detected command after `--`:

```bash
adb-ready dev --port 8081 --port 8000
adb-ready dev -- pnpm run android:local
adb-ready dev --dry-run --json
```

[Reach your first ready session →](./docs/getting-started.md)

### In CI and automation

Wait for declared readiness, execute one bounded verification command, preserve
its exit code, and clean only resources created by the run:

```bash
npx adb-ready run -- npm run test:e2e
```

Each executed run retains a redacted evidence bundle with its result,
timeline, problems, focused logcat, AI context, JUnit XML, and GitHub step
summary. Scripts also get deterministic JSON and NDJSON contracts:

```bash
adb-ready devices --json --non-interactive
adb-ready logs --package com.example.app --format ndjson
adb-ready sessions list --status failed --since 24h --limit 5
```

[Build a readiness-gated device job →](./docs/automation.md)

## One target. One verified loop.

```text
find or recover one Android target
        ↓
bind the complete run to that target
        ↓
prepare only the ports the project needs
        ↓
start the framework and wait for declared readiness
        ↓
watch target · ports · logs · child process
        ↓
recover safely or return bounded failure evidence
```

- Existing matching port mappings are reused; conflicts are not overwritten.
- Wireless and port recovery is bounded and independently verified.
- An ADB server restart is never hidden inside recovery.
- On exit, ADB Ready cleans only resources owned by that session.
- The final exit code and a project-scoped session record are preserved.

## Keep your existing stack

| Projects | Package managers | CLI runtimes | Hosts |
| --- | --- | --- | --- |
| Expo · React Native · Flutter · Capacitor · Gradle · custom | npm · pnpm · Yarn · Bun | Node.js · Bun · Deno | macOS · Linux · Windows |

The standard npm entrypoint requires Android SDK Platform-Tools and Node.js 22
or newer. The published package is architecture-neutral JavaScript with no
native addon or artificial OS/CPU block. A working ADB executable remains the
Android transport backend.

[See tested and upstream-capable support tiers →](./COMPATIBILITY.md)

## Trust by default

- One selected target is used consistently for every operation in a session.
- Target leases prevent concurrent ADB Ready processes from mutating the same
  target without an explicit takeover.
- Destructive or device-wide actions require an explicit command or
  confirmation.
- Pairing codes never enter command-line arguments.
- Session data is bounded, redacted, private to the local user, and never
  uploaded by ADB Ready.
- Stale UI references are rejected before input is sent.
- Machine data stays on `stdout`; human diagnostics stay on `stderr`.

[Review the complete threat model →](./docs/threat-model.md)

## Documentation

| Guide | Start here when you want to… |
| --- | --- |
| [Getting started](./docs/getting-started.md) | Reach the first ready development session. |
| [Development sessions](./docs/dev-sessions.md) | Configure frameworks, commands, ports, readiness, and cleanup. |
| [Targets and Wireless debugging](./docs/targets-and-wireless.md) | Pair, connect, recover, or explicitly select a target. |
| [Apps and evidence](./docs/apps-and-evidence.md) | Control the app and capture screenshots or recordings. |
| [Safe UI automation](./docs/ui-automation.md) | Find, act on, and verify the current Android UI. |
| [Logs and AI context](./docs/logs-and-context.md) | Diagnose a failure with bounded, redacted evidence. |
| [AI agent integration](./docs/agent-integration.md) | Connect an MCP-capable coding agent. |
| [Automation](./docs/automation.md) | Use readiness, exit codes, JSON, NDJSON, JUnit, and CI artifacts. |
| [Configuration](./docs/configuration.md) | Share project presets, hooks, aliases, and policies. |
| [Troubleshooting](./docs/troubleshooting.md) | Resolve a known setup, target, UI, or session problem. |
| [Compatibility](./COMPATIBILITY.md) | Check hosts, runtimes, package managers, and support tiers. |
| [Example configs](./examples/README.md) | Copy a framework or custom-project configuration. |

Run `adb-ready --help` for the complete command list or
`adb-ready help COMMAND` for focused options.

## Project

[Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) ·
[Security](./SECURITY.md) · [MIT License](./LICENSE)

ADB Ready is Android-only. It exposes target-bound workflows rather than a
generic remote shell.
