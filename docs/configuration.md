# Configuration reference

ADB Ready uses declarative JSON with a versioned JSON Schema. It does not execute
JavaScript or TypeScript configuration.

## Files and precedence

The project config is the nearest `adb-ready.config.json` found from the current
directory upward. A user config can supply personal defaults without changing
the repository.

| Host | User config |
| --- | --- |
| macOS | `~/Library/Application Support/adb-ready/config.json` |
| Linux and other Unix | `$XDG_CONFIG_HOME/adb-ready/config.json` or `~/.config/adb-ready/config.json` |
| Windows | `%APPDATA%\adb-ready\config.json` with home fallback |

Select another project file with `--config PATH` or `ADB_READY_CONFIG`.

Values are resolved in this order, highest priority first:

```text
CLI → environment → selected profile → project config → user config → defaults
```

Inspect the result rather than guessing:

```bash
adb-ready config validate
adb-ready config explain
adb-ready config explain --json
```

## Minimal configuration

```json
{
  "$schema": "./node_modules/adb-ready/schema/config-v1.schema.json",
  "version": 1,
  "dev": {
    "preset": "expo",
    "reversePorts": [8081, 8000]
  }
}
```

`adb-ready init` creates the smallest detected document and never overwrites an
existing file unless `--force` is explicit. Use `--dry-run` first.

## Root fields

| Field | Purpose |
| --- | --- |
| `version` | Required configuration contract version; currently `1` |
| `$schema` | Editor validation and completion |
| `defaultProfile` | Named profile selected when no CLI/environment profile is set |
| `adb` | Executable path or remote server host/port |
| `timeoutMs` | Default bounded operation timeout |
| `output` | Interactive, animation, color, and Unicode preferences |
| `targets.aliases` | Friendly name to exact ADB serial mapping |
| `dev` | Development-session configuration |
| `profiles` | Named, optionally inherited overrides |

## Development fields

| Field | Values or shape |
| --- | --- |
| `preset` | `expo`, `react-native`, `gradle`, or `custom` |
| `packageManager` | `npm`, `pnpm`, `yarn`, or `bun` |
| `command` | `{ "executable": string, "args": string[], "cwd"?: string }` |
| `reversePorts` | integers or `{ "device": number, "host"?: number }` objects |
| `logs` | enable the session's targeted log stream |
| `cleanupPorts` | remove only mappings created by this session |
| `watch` | monitor and recover target, port, and log health |
| `recovery` | attempt count, initial/max delay, and total deadline |
| `session` | persistence and retention limits |
| `journal` | in-memory bounds, sources, severity, and extra redaction names |
| `hooks` | direct argv hooks for supported lifecycle phases |

Unknown keys and invalid nested values fail validation rather than being
silently ignored.

## Profiles

Profiles can inherit from one named parent. Cycles and missing references are
reported as configuration errors.

```json
{
  "version": 1,
  "defaultProfile": "local",
  "profiles": {
    "base": {
      "dev": {
        "preset": "react-native",
        "reversePorts": [8081],
        "watch": true
      }
    },
    "local": {
      "extends": "base",
      "dev": {
        "reversePorts": [8081, 8000]
      }
    },
    "ci": {
      "extends": "base",
      "output": {
        "interactive": false,
        "animation": false,
        "color": false
      }
    }
  }
}
```

```bash
adb-ready dev --profile local
ADB_READY_PROFILE=ci adb-ready doctor --json
```

## Environment overrides

Supported environment variables include:

| Variable | Value |
| --- | --- |
| `ADB_READY_CONFIG` | project config path |
| `ADB_READY_PROFILE` | profile name |
| `ADB_READY_ADB_PATH` | ADB executable path |
| `ADB_READY_ADB_HOST` / `ADB_READY_ADB_PORT` | remote ADB server |
| `ADB_READY_TIMEOUT_MS` | integer milliseconds |
| `ADB_READY_PRESET` | development preset |
| `ADB_READY_PACKAGE_MANAGER` | package manager |
| `ADB_READY_REVERSE_PORTS` | comma-separated device ports |
| `ADB_READY_DEV_LOGS` | boolean |
| `ADB_READY_CLEANUP_PORTS` | boolean |
| `ADB_READY_DEV_WATCH` | boolean |
| `ADB_READY_SESSION_PERSIST` | boolean |
| `ADB_READY_RECOVERY_*` | attempt and timing bounds |
| `ADB_READY_SESSION_*` | retention bounds |
| `ADB_READY_JOURNAL_*` | journal bounds, severity, and redaction names |
| `ADB_READY_COLOR`, `ADB_READY_UNICODE`, `ADB_READY_ANIMATION`, `ADB_READY_INTERACTIVE` | output booleans |

Boolean values accept `true/false`, `1/0`, `yes/no`, or `on/off`.

## Complete schema

The authoritative field types and bounds are in
[`schema/config-v1.schema.json`](../schema/config-v1.schema.json). Prefer the
schema over copying a large configuration: begin with `adb-ready init`, then add
only values the project actually needs.
