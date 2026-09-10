# ADB Ready

> Make an Android target ready, then keep the development session working.

ADB Ready is an early-alpha, Android-only developer CLI built around the real
`adb` executable. It provides one predictable interface for inspecting an ADB
environment, finding Android targets, and establishing verified wireless
connections without taking control of unrelated Android Studio sessions.

## Try the alpha

ADB Ready currently requires Node.js 22 or newer and an installed Android SDK
Platform-Tools `adb` executable.

```bash
npx adb-ready@alpha
npx adb-ready@alpha doctor
npx adb-ready@alpha devices
```

The package also exposes the shorter `adbr` command. Both names invoke the same
CLI entrypoint.

## Available now

- Interactive keyboard-driven home screen.
- Environment and ADB diagnostics with `doctor`.
- Unified USB, emulator, and wireless target discovery with `devices`.
- Guided or explicit wireless connection with `connect`.
- Secure Android Wireless debugging pairing with `pair`.
- Deterministic selection by serial, alias, transport ID, or last verified
  target.
- Named project and user profiles with validated configuration.
- Human, plain, JSON, and NDJSON output.
- Portable execution through Node, Bun, and Deno.

Run `npx adb-ready@alpha --help` for the complete command reference.

## Wireless connection

Connect to an explicit endpoint, or omit it to use ADB's mDNS discovery:

```bash
npx adb-ready@alpha connect 192.168.1.42:37123
npx adb-ready@alpha connect
```

ADB Ready verifies the connected target before remembering it. A dry run shows
the planned ADB operations without changing state:

```bash
npx adb-ready@alpha connect 192.168.1.42:37123 --dry-run
```

Pairing codes are never accepted as command-line arguments because command
arguments can be exposed through shell history and process inspection. Use the
hidden interactive prompt:

```bash
npx adb-ready@alpha pair 192.168.1.42:41235
```

For non-interactive automation, send the six-digit code over standard input:

```bash
printf '%s\n' "$ANDROID_PAIRING_CODE" | npx adb-ready@alpha pair 192.168.1.42:41235 --pairing-code-stdin
```

Pairing and connection use different ports. ADB Ready keeps them separate and
does not infer one from the other.

## Selecting the right target

Every selector is explicit and deterministic:

```bash
npx adb-ready@alpha devices --select
npx adb-ready@alpha devices --device emulator-5554
npx adb-ready@alpha devices --transport-id 7
npx adb-ready@alpha devices --last
```

`-s` is an alias for `--device`. A device selector can be an exact ADB serial or
a configured alias. Ambiguous or unavailable targets produce a structured
error instead of silently choosing one.

## Configuration and profiles

ADB Ready searches parent directories for `adb-ready.config.json`. An explicit
file can be selected with `--config PATH` or `ADB_READY_CONFIG`. The published
JSON schema is included in the package as `schema/config-v1.schema.json`.

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
    "local": {
      "timeoutMs": 8000
    },
    "ci": {
      "extends": "local",
      "output": {
        "interactive": false,
        "animation": false,
        "color": false
      }
    }
  }
}
```

Select a profile with `--profile NAME` or `ADB_READY_PROFILE`. Precedence is
command-line options, environment variables, selected profile, project config,
user config, then built-in defaults. Invalid keys, values, references, and
profile cycles fail early with actionable errors.

## Automation output

Use JSON for one complete result or NDJSON for event-oriented consumers:

```bash
npx adb-ready@alpha doctor --json
npx adb-ready@alpha devices --format ndjson --non-interactive
npx adb-ready@alpha connect 192.168.1.42:37123 --dry-run --json
```

Machine data is written to `stdout`; human diagnostics and progress belong on
`stderr`. Non-interactive mode never opens a prompt or takes over the terminal.

## Runtime and package-manager entrypoints

The packed npm artifact is continuously exercised through the common package
manager entrypoints available in the test environment:

```bash
npx adb-ready@alpha doctor
pnpm dlx adb-ready@alpha doctor
yarn dlx adb-ready@alpha doctor
bunx adb-ready@alpha doctor
```

Explicit alternative runtimes are also supported:

```bash
bunx --bun adb-ready@alpha doctor
deno run -A npm:adb-ready@alpha doctor
```

The public platform target is macOS, Linux, and Windows. ADB commands are run as
owned child processes with bounded timeouts and cleanup. ADB Ready never
implicitly restarts the shared ADB server or disconnects unrelated targets.

## ADB compatibility

ADB Ready feature-detects modern ADB capabilities instead of guessing from the
Android version. With ADB 37 it can consume the ADB Wi-Fi 2.0 discovery stream;
older Platform-Tools continue through the legacy mDNS snapshot path.

Wireless discovery still depends on the local network. Guest or corporate Wi-Fi,
client isolation, VPNs, containers, and virtual machines can prevent mDNS or
direct device routing even when pairing settings are correct.

## Development

This repository uses Bun for dependency management and project commands:

```bash
bun install --frozen-lockfile
bun run verify
```

`bun run verify` is the complete local gate: formatting and static analysis,
unit and integration tests, packaged-command checks, Node/Bun/Deno runtime
smoke tests, package-manager consumer tests, privacy checks, tarball validation,
publint, and package type analysis.

Useful focused checks:

```bash
bun run ui:playground
bun run test:integration
bun run verify:real-adb
```

The real-ADB check is read-only. It reports the local ADB environment and never
requires a device mutation.

## Current scope

Reverse and forward ports, app lifecycle, logs, Expo and React Native presets,
and the flagship `adb-ready dev` session are the next product layer. They are
not presented as available until their end-to-end behavior is implemented and
verified.

The source repository remains private during early implementation. The alpha is
currently distributed as `UNLICENSED` software.
