# ADB Ready

> Make an Android target ready, then keep the development session working.

ADB Ready is an early-alpha, Android-only developer CLI built around the real
`adb` executable. It selects one target, prepares verified ports, starts the
project's development command, and keeps the target identity and useful output
inside one structured session.

## Try the alpha

The standard npm entrypoint requires Node.js 22 or newer and Android SDK
Platform-Tools. The same package is also exercised directly with Bun and Deno.

```bash
npx adb-ready@alpha
npx adb-ready@alpha doctor
npx adb-ready@alpha devices
```

The registry alpha is the last published preview and may lag the current source.
Until the next alpha is published, use the repository build below to exercise
the complete command set documented here.

To run the current repository build:

```bash
bun install --frozen-lockfile
bun run build
node dist/cli.js dev
```

The package also exposes the shorter `adbr` command. Both names invoke the same
CLI entrypoint.

## Available now

- Interactive keyboard-driven home screen.
- Environment and ADB diagnostics with `doctor`.
- Unified USB, emulator, and wireless target discovery with `devices`.
- Guided or explicit wireless connection with `connect`.
- Secure Android Wireless debugging pairing with `pair`.
- Verified, conflict-safe TCP reverse and forward port management.
- One-command Expo, React Native, native Gradle, or custom development sessions.
- Automatic project and package-manager detection with explicit overrides.
- One selected target propagated to child tools through `ANDROID_SERIAL`.
- Correlated, bounded, redacted child output and targeted logcat events.
- Direct lifecycle hooks with timeouts and `fail`, `warn`, or `ignore` policies.
- Deterministic selection by serial, alias, transport ID, or last verified
  target.
- Named project and user profiles with validated configuration.
- Human, plain, JSON, and NDJSON output.
- Portable execution through Node, Bun, and Deno.

Run `adb-ready --help` for the complete command reference.

## Development sessions

From an Expo, React Native, or native Gradle project, the default workflow is:

```bash
adb-ready dev
```

Expo and React Native receive a verified reverse mapping for TCP port 8081 by
default. Add or replace the configured port set by repeating `--port`:

```bash
adb-ready dev --port 8081 --port 8000
```

Any project can use a direct custom command. Arguments after `--` are passed as
an argument array without a command shell:

```bash
adb-ready dev -- pnpm run android:local
adb-ready dev -- bun x expo start --host lan --port 8081 --android
```

ADB Ready refuses to replace an existing conflicting reverse mapping. At exit
it removes only mappings created by that session and independently verifies the
result. A failed child keeps its exact exit code. Ctrl-C is forwarded to owned
processes and returns the interrupted exit code after cleanup.

Use `--dry-run` to inspect the exact target-bound ADB and child-process plan
without running hooks, changing ports, or starting the project command:

```bash
adb-ready dev --port 8081 --dry-run --json
```

## Port workflows

Forward and reverse mappings use explicit host/device semantics and are always
verified after a mutation:

```bash
adb-ready ports reverse list
adb-ready ports reverse add 8081
adb-ready ports reverse add 8000 3000
adb-ready ports reverse remove 8081

adb-ready ports forward list
adb-ready ports forward add 9229 3000
adb-ready ports forward remove 9229
```

The current command family intentionally supports TCP endpoints. Other ADB
socket families remain available through raw ADB until they receive an equally
clear public contract.

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
      "timeoutMs": 8000,
      "dev": {
        "preset": "expo",
        "packageManager": "pnpm",
        "reversePorts": [8081, 8000],
        "logs": true,
        "cleanupPorts": true,
        "journal": {
          "maxEntries": 2000,
          "maxBytes": 2097152,
          "minimumSeverity": "info",
          "redactEnvironment": ["PRIVATE_API_TOKEN"]
        },
        "hooks": {
          "onReady": [
            {
              "run": ["node", "scripts/android-ready.mjs"],
              "timeoutMs": 5000,
              "failure": "warn",
              "envAllowlist": ["CI"]
            }
          ]
        }
      }
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

Project command resolution is deterministic: explicit config or CLI choice,
then `packageManager`, npm `devEngines.packageManager`, lockfiles, and finally
an available executable. Conflicting metadata is reported instead of guessed.
Hook commands are direct executable/argument arrays; they do not invoke a shell,
inherit only a small platform environment plus explicitly allowlisted names,
and send their output through the session redactor.

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
See [COMPATIBILITY.md](./COMPATIBILITY.md) for the tested, runtime, and
upstream-capable support tiers, including arm64, x64, WSL, containers, musl,
ChromeOS Linux, and BSD.

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

## Alpha boundary

The current dev session prepares and verifies its initial state; it does not yet
watch and repair a device or mapping after a later disconnect. App install and
lifecycle commands, persistent session files, broader logcat filtering, and
automatic reconnect recovery are intentionally not claimed as available yet.

The source repository remains private during early implementation. The alpha is
currently distributed as `UNLICENSED` software.
