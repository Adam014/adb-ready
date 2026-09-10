<div align="center">

# ADB Ready

**One Android target. One reliable development session.**

Select a device, prepare localhost ports, start your project, and keep the
connection healthy—without stitching together fragile ADB scripts.

[![CI](https://github.com/Adam014/adb-ready/actions/workflows/ci.yml/badge.svg)](https://github.com/Adam014/adb-ready/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/adb-ready?label=npm&color=1f9db5)](https://www.npmjs.com/package/adb-ready)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/Bun-tested-14151a?logo=bun&logoColor=white)](https://bun.sh/)
[![Deno](https://img.shields.io/badge/Deno_2-tested-111827?logo=deno&logoColor=white)](https://deno.com/)
[![Platforms](https://img.shields.io/badge/hosts-macOS_%C2%B7_Linux_%C2%B7_Windows-64748b)](./COMPATIBILITY.md)

[Quick start](#quick-start) · [Why ADB Ready](#why-adb-ready) ·
[Workflows](#everyday-workflows) · [Configuration](#configuration) ·
[Automation](#automation) · [Compatibility](#compatibility)

</div>

```text
$ adb-ready dev

✓ Android target selected       Pixel 9 · wireless
✓ Localhost ports ready         8081 → 8081
✓ Development command started   pnpm run start --android
● Session healthy               watching target, ports, and logs
```

ADB Ready is an ADB-first CLI for the complete everyday Android development
loop. It uses the real `adb` installed on your machine, keeps every operation on
one deterministic target, and works with Expo, React Native, native Gradle, or
any custom command.

> **Release status:** the published npm tag is an early preview and can lag the
> current source while `0.1.0` is being validated. The command surface below
> describes the current repository build.

## Why ADB Ready?

Android Studio and raw ADB remain excellent tools. The missing piece is a
repeatable project-level session that joins them together.

| Without ADB Ready | With ADB Ready |
| --- | --- |
| Find a usable serial and keep passing `-s` | Select one stable target once |
| Reconnect Wireless debugging by hand | Detect degradation and attempt bounded recovery |
| Recreate `adb reverse` mappings after a reconnect | Verify and repair the session's mappings |
| Make Expo or React Native use the intended phone | Propagate `ANDROID_SERIAL` to every child process |
| Read unrelated logcat noise | Stream package, PID, tag, level, and buffer-focused logs |
| Copy terminal fragments into an AI chat | Export bounded, redacted diagnostic context |
| Maintain a different shell script per project | Commit one validated project configuration |

ADB Ready does not replace Android Studio, Expo, React Native, or ADB. It gives
those tools one reliable target and one observable lifecycle.

## Quick start

### Requirements

- Android SDK Platform-Tools with `adb` available through `PATH`, an Android SDK
  installation, or `--adb PATH`.
- Node.js 22 or newer for the standard npm entrypoint. Bun and Deno 2 can run
  the same portable package.
- An Android target visible over USB, an emulator, or Wireless debugging.

Try the currently published preview without installing it:

```bash
npx adb-ready@alpha doctor
npx adb-ready@alpha devices
npx adb-ready@alpha
```

Or add it to a project:

```bash
npm install --save-dev adb-ready@alpha
npx adb-ready init
npx adb-ready dev
```

`adb-ready` opens the interactive home when no command is supplied. `adbr` is a
short alias for the exact same executable.

To test the latest source checkout:

```bash
bun install --frozen-lockfile
bun run build
node dist/cli.js doctor
node dist/cli.js dev
```

## The development session

Run this from an Expo, React Native, or native Gradle project:

```bash
adb-ready dev
```

ADB Ready then:

1. discovers and deterministically selects one usable Android target;
2. detects the project and its package manager;
3. creates and verifies required reverse-port mappings;
4. launches the project command with the same `ANDROID_SERIAL`;
5. correlates child output, targeted logcat, ADB operations, and session state;
6. watches the target and ports, applying bounded safe recovery when needed;
7. removes only the mappings created by this session; and
8. stores a bounded, redacted local record for later diagnosis.

Expo and React Native default to reverse TCP port `8081`. Add any local API or
development service by repeating `--port`:

```bash
adb-ready dev --port 8081 --port 8000
```

Use any executable without invoking a command shell:

```bash
adb-ready dev -- pnpm run android:local
adb-ready dev -- bun x expo start --host lan --port 8081 --android
```

Inspect the exact target-bound plan without connecting, changing mappings,
running hooks, or starting the child command:

```bash
adb-ready dev --port 8081 --dry-run --json
```

ADB Ready preserves child exit codes, forwards cancellation to owned processes,
and independently verifies cleanup. It never silently replaces a conflicting
port mapping.

## Everyday workflows

### Check the machine

```bash
adb-ready doctor
adb-ready doctor --json
```

`doctor` performs read-only host, runtime, ADB capability, server, and target
checks, then reports actionable problems instead of dumping raw command output.

### Find the right Android target

```bash
adb-ready devices
adb-ready devices --select
adb-ready devices --device emulator-5554
adb-ready devices --transport-id 7
adb-ready devices --last
```

Selection can use an exact serial, configured alias, transport ID, the last
verified target, or the interactive picker. Ambiguous, offline, and unauthorized
targets fail explicitly instead of being guessed.

### Pair and connect wirelessly

On Android, open **Developer options → Wireless debugging** and choose
**Pair device with pairing code**.

```bash
adb-ready pair 192.168.1.42:41235
adb-ready connect 192.168.1.42:37123
```

The pairing code is entered through a hidden prompt, never as a command-line
argument. For non-interactive automation it can be read from standard input:

```bash
printf '%s\n' "$ANDROID_PAIRING_CODE" \
  | adb-ready pair 192.168.1.42:41235 --pairing-code-stdin
```

Pairing and connection ports are intentionally kept separate. If `connect` is
called without an endpoint, exactly one valid ADB mDNS connect service must be
discoverable.

### Manage verified ports

```bash
adb-ready ports reverse list
adb-ready ports reverse add 8081
adb-ready ports reverse add 8000 3000
adb-ready ports reverse remove 8081

adb-ready ports forward list
adb-ready ports forward add 9229 3000
adb-ready ports forward remove 9229
```

The second port is optional and defaults to the first. Adds are idempotent,
verified after mutation, and refuse to overwrite an existing conflicting
mapping. The current public contract intentionally covers TCP endpoints.

### Stream focused Android logs

```bash
adb-ready logs --package com.example.app
adb-ready logs --tag ReactNativeJS --level W
adb-ready logs --buffer main --buffer crash --tail 200
adb-ready logs --package com.example.app --dump --json
```

Logs can be filtered by package, PID, included or excluded tags, priority,
buffer, tail count, and Android logcat timestamp. Known Android, native, ANR,
and React Native failures become structured findings while unparsed lines stay
visible.

### Inspect a past session

```bash
adb-ready sessions list
adb-ready sessions show
adb-ready sessions events
adb-ready problems
```

`show`, `events`, and `problems` use the latest session when no ID is supplied.
Pass an ID from `sessions list` to inspect a specific run.

### Prepare context for any AI assistant

```bash
adb-ready context
adb-ready context --since 5m --only problems,recovery,logs
adb-ready context SESSION_ID --budget 8000
```

The default output is a local Markdown brief with prioritized evidence. It has
a strict character budget, pseudonymizes device and project identities, redacts
known credentials and private literals, and makes no network request. Review it
before sharing it with any external service.

## Configuration

Generate a minimal config from detected project signals:

```bash
adb-ready init --dry-run
adb-ready init
adb-ready config validate
adb-ready config explain
```

ADB Ready searches parent directories for `adb-ready.config.json`. It supports
an explicit file through `--config PATH` or `ADB_READY_CONFIG`, plus named
profiles through `--profile NAME` or `ADB_READY_PROFILE`.

```json
{
  "$schema": "./node_modules/adb-ready/schema/config-v1.schema.json",
  "version": 1,
  "defaultProfile": "local",
  "targets": {
    "aliases": {
      "phone": "R5CT123456A"
    }
  },
  "profiles": {
    "base": {
      "dev": {
        "preset": "expo",
        "packageManager": "pnpm",
        "reversePorts": [8081, 8000],
        "logs": true,
        "watch": true
      }
    },
    "local": {
      "extends": "base",
      "dev": {
        "recovery": {
          "maxAttempts": 3,
          "totalTimeoutMs": 30000
        },
        "session": {
          "maxSessions": 30,
          "maxAgeDays": 14
        }
      }
    }
  }
}
```

Configuration precedence is deterministic:

```text
CLI → environment → selected profile → project config → user config → defaults
```

Invalid keys, values, references, and profile cycles fail early.
`config explain` shows each resolved value and where it came from. The complete
machine-readable contract ships as
[`schema/config-v1.schema.json`](./schema/config-v1.schema.json).

Advanced configuration supports lifecycle hooks, direct command arrays,
recovery budgets, session retention, event-journal limits, source/severity
filters, and additional environment names to redact. Hook commands run without
a shell, inherit only a small safe environment plus explicit allowlisted names,
and support `fail`, `warn`, or `ignore` policies.

## Automation

Every command uses the same output and execution contract:

```bash
adb-ready devices --json --non-interactive
adb-ready doctor --format plain --no-color
adb-ready logs --format ndjson --non-interactive
adb-ready connect 192.168.1.42:37123 --dry-run --json
```

- `--json` returns one versioned result envelope.
- `--format ndjson` streams versioned events for long-running consumers.
- Machine-readable data goes to `stdout`; human progress and diagnostics go to
  `stderr`.
- Redirected, CI, JSON, and `--non-interactive` runs never prompt or take over
  the terminal.
- `--timeout`, cancellation, stable problem codes, and meaningful exit codes
  make failures scriptable.
- `--adb-host` and `--adb-port` can target an explicitly configured remote ADB
  server for environments such as WSL, containers, VMs, or device labs.

## Runtime entrypoints

The project uses Bun for development, but the distributed CLI does not require
a project to use Bun.

```bash
npx adb-ready@alpha doctor
pnpm dlx adb-ready@alpha doctor
yarn dlx adb-ready@alpha doctor
bunx adb-ready@alpha doctor

bunx --bun adb-ready@alpha doctor
deno run -A npm:adb-ready@alpha doctor
```

One package serves npm, pnpm, Yarn, Bun, Node.js, and Deno users. Project-command
detection is independent of the runtime used to launch ADB Ready.

## Compatibility

The public host target is macOS, Linux, and Windows. The npm artifact is
architecture-neutral JavaScript with no native addon and no artificial OS or
CPU installation block.

ADB Ready feature-detects relevant ADB capabilities rather than assuming them
from the Android version. USB access, mDNS, Wireless debugging, VPN routing,
container networking, and remote ADB visibility still depend on the host and
its Platform-Tools installation.

See [COMPATIBILITY.md](./COMPATIBILITY.md) for CI-tested, runtime-tested, and
upstream-capable support tiers, including arm64, x64, WSL 2, containers, musl,
ChromeOS Linux, and BSD.

## Safety and privacy

- The real `adb` remains the backend; ADB Ready does not replace its protocol.
- A selected target is explicit in every direct ADB operation and child process.
- The shared ADB server is never restarted implicitly.
- Unrelated devices, processes, connections, and port mappings are left alone.
- Mutating operations support dry runs where a meaningful plan exists.
- Pairing codes are excluded from argv and known secret patterns are redacted.
- Session history is private, bounded, stored with restrictive permissions, and
  can be disabled through configuration.
- Nothing is uploaded by ADB Ready.

## Command reference

| Command | Purpose |
| --- | --- |
| `adb-ready` | Open the interactive workflow home |
| `adb-ready dev` | Run and keep one target-bound development session healthy |
| `adb-ready doctor` | Diagnose the local runtime and ADB environment |
| `adb-ready devices` | Discover, inspect, and select Android targets |
| `adb-ready pair` | Pair securely with Android Wireless debugging |
| `adb-ready connect` | Connect and verify a wireless target |
| `adb-ready ports` | List, add, and remove verified TCP mappings |
| `adb-ready logs` | Stream structured, redacted, focused logcat |
| `adb-ready sessions` | List saved sessions and inspect their timelines |
| `adb-ready problems` | Show structured problems from a saved session |
| `adb-ready context` | Compile bounded, redacted diagnostic context |
| `adb-ready init` | Generate a detected project configuration |
| `adb-ready config` | Validate config or explain resolved values |

Run `adb-ready help COMMAND` for command-specific options and `adb-ready --help`
for global targeting, output, timeout, and ADB-server flags.

## Development

```bash
bun install --frozen-lockfile
bun run verify
```

`bun run verify` is the authoritative local gate. It checks formatting and
types, unit and integration behavior, command and runtime smoke tests, package
manager entrypoints, privacy boundaries, the packed npm artifact, `publint`,
and package type analysis.

Focused checks:

```bash
bun run ui:playground
bun run test:integration
bun run verify:real-adb
```

The real-ADB check is read-only and does not mutate a connected device.

## Current boundary

ADB Ready is Android-only and the current release candidate is intentionally
focused on target acquisition, ports, development sessions, recovery, logs,
diagnostics, and automation. App install/lifecycle, file transfer, screenshots,
screen recording, interactive shell, and raw-ADB escape-hatch commands are not
part of the current public command surface.

The repository remains private during release-candidate validation. The preview
is currently distributed as `UNLICENSED` software; an open-source license will
be selected before a public stable release.
