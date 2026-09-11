# Automation contract

ADB Ready separates stable machine output from human terminal presentation.
Automation never needs to parse animation, color, progress redraws, or prompts.

## Output modes

```bash
adb-ready doctor --json
adb-ready devices --format plain
adb-ready logs --format ndjson --non-interactive
```

| Mode | Contract |
| --- | --- |
| `human` | TTY-aware panels, progress, and actionable diagnostics |
| `plain` | deterministic line-oriented human text without terminal control |
| `json` | one complete versioned result envelope |
| `ndjson` | one versioned event per line, followed by the command result where applicable; saved timelines end with an event-count summary instead of duplicating the full event array |
| `markdown` | bounded diagnostic context; only valid for `context` |

Machine data is written to `stdout`. Human progress and diagnostics are written
to `stderr`. `--quiet` hides successful human output without hiding failures.

## Result envelope

JSON commands return this top-level shape:

```json
{
  "schemaVersion": 1,
  "command": "doctor",
  "commandId": "c5b1435f-7b51-49fb-b80c-42459cbc2177",
  "ok": true,
  "startedAt": "2026-09-10T08:00:00.000Z",
  "finishedAt": "2026-09-10T08:00:00.120Z",
  "durationMs": 120,
  "data": {},
  "problems": []
}
```

Consumers must ignore unknown additive fields and event types within the same
schema version.

The npm package includes two versioned public artifacts:

- `schema/config-v1.schema.json` validates project configuration; and
- `schema/agent-tools-v1.json` catalogs every MCP tool's generated input and
  output schemas plus safety annotations for the matching package version.

## Event envelope

NDJSON events include:

```json
{
  "schemaVersion": 1,
  "sequence": 12,
  "timestamp": "2026-09-10T08:00:00.100Z",
  "type": "port.verified",
  "source": "port",
  "severity": "info",
  "message": "Required reverse mapping is ready.",
  "correlation": {
    "commandId": "c5b1435f-7b51-49fb-b80c-42459cbc2177",
    "sessionId": "session-42"
  },
  "data": {}
}
```

Sequence numbers are monotonic inside a command/session. Use correlation fields
instead of extracting identifiers from messages.

## Exit codes

| Code | Category |
| ---: | --- |
| `0` | success |
| `2` | invalid input or configuration |
| `10` | host/runtime/ADB environment |
| `20` | target discovery or selection |
| `30` | ADB operation |
| `40` | owned child process |
| `70` | internal invariant or unexpected failure |
| `130` | interrupted by the user or caller |

A child process's ordinary non-zero code is preserved when it is more specific
than the category table. Always inspect both the process exit code and the
result envelope's `problems` array.

## Non-interactive guarantees

Use `--non-interactive` whenever no human can answer:

```bash
adb-ready devices --non-interactive --json
adb-ready dev --device "$ANDROID_SERIAL" --non-interactive --format ndjson
```

In non-interactive, redirected, JSON, NDJSON, or CI execution, ADB Ready does not
open prompts, enable raw input, clear the screen, or animate. Ambiguity becomes a
structured failure that asks the caller for an explicit selector.

## Safe planning

Mutating workflows expose `--dry-run` when a deterministic plan is meaningful:

```bash
adb-ready init --dry-run --json
adb-ready connect 192.168.1.42:37123 --dry-run --json
adb-ready ports reverse add 8081 --dry-run --json
adb-ready dev --port 8081 --dry-run --json
```

Plan steps declare their risk. A dry run performs no pairing, connection,
mapping, hook, or child-process mutation.

## Run one bounded verification

Use `run` when CI or an agent must prove a workflow and then exit instead of
leaving a development server open:

```bash
adb-ready run --preset expo --run-timeout 10m -- \
  maestro test .maestro/smoke.yaml
```

ADB Ready selects and exclusively leases one target, prepares the configured
ports and development command, waits for every readiness assertion, runs the
exact command after `--`, and cleans only the resources it created. It never
retries a failed product assertion as if it were an infrastructure failure.

Every executed run prints the path to a project-local evidence directory under
`.adb-ready/artifacts/`. Its manifest references the structured result,
timeline, problems, focused logcat, bounded AI context, JUnit XML, and a concise
GitHub Actions summary. The evidence remains available when readiness or the
verification command fails.

Preview the complete project plan before a device is allocated:

```bash
adb-ready run --preset expo --dry-run --json -- npm run test:e2e
```

## CI example

```yaml
- name: Validate Android development environment
  run: npx adb-ready doctor --json --non-interactive

- name: Validate project configuration
  run: npx adb-ready config validate --json --non-interactive
```

USB passthrough, emulators, remote ADB servers, and device labs remain the CI
environment's responsibility. ADB Ready reports the observed boundary instead
of simulating a connected device.
