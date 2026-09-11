# Logs, problems, and AI context

ADB Ready keeps diagnostic evidence structured before it renders or exports it.
Deterministic parsers and problem codes remain responsible for safety; AI is an
optional consumer of redacted evidence, never an execution authority.

## Focused logcat

Stream logs from one selected target:

```bash
adb-ready logs --package com.example.app
adb-ready logs --pid 24109
adb-ready logs --tag ReactNativeJS --level W
adb-ready logs --exclude-tag Choreographer --tail 200
adb-ready logs --buffer main --buffer system --buffer crash
```

A live stream starts at the current end of the device buffer, so a new session
does not report stale crashes from an earlier run. Use `--tail`, `--since`, or
`--dump` when historical records are intentional.

Use `--dump` for a bounded snapshot that exits:

```bash
adb-ready logs --package com.example.app --dump --max-records 500 --json
```

Available filters:

| Option | Meaning |
| --- | --- |
| `--package NAME` | Resolve the running package and filter by UID when supported, with PID fallback |
| `--pid PID` | Select one exact process |
| `--tag TAG` | Include a tag; repeat to include more |
| `--exclude-tag TAG` | Suppress a tag; repeat to exclude more |
| `--level PRIORITY` | Minimum `V`, `D`, `I`, `W`, `E`, `F`, `A`, or silent `S` priority |
| `--buffer NAME` | Read `main`, `system`, or `crash`; repeat for more |
| `--tail COUNT` | Begin with the most recent record count |
| `--since TIMESTAMP` | Pass an Android logcat timestamp boundary |
| `--max-records COUNT` | Bound records retained in the final result |

Unparsed lines are preserved. Output arriving on `stderr` is not automatically
classified as an error; severity comes from source semantics. Fatal Android
exceptions, native crashes, ANRs, and React Native fatal errors become
structured findings.

## Session history

Development sessions incrementally persist redacted NDJSON and an atomic
manifest in the host's user-state directory, not inside the project.

```bash
adb-ready sessions list
adb-ready sessions show SESSION_ID
adb-ready sessions events SESSION_ID --format ndjson
adb-ready problems SESSION_ID
```

Find the useful run without scanning a long global list:

```bash
adb-ready sessions list --status failed --since 24h --limit 5
adb-ready sessions list --preset expo
adb-ready sessions list --all-projects
```

History is scoped to the current project by default. Status, time, preset, and
count filters apply before output; `--all-projects` is an explicit escape hatch
for a machine-wide audit.

When the ID is omitted, the latest saved session is selected. Default retention
keeps at most 30 finalized sessions, 14 days, and 20 MiB. Active sessions are
not pruned as finalized history.

Storage locations follow host conventions:

| Host | Default directory |
| --- | --- |
| macOS | `~/Library/Application Support/adb-ready/sessions` |
| Linux and other Unix | `$XDG_STATE_HOME/adb-ready/sessions` or `~/.local/state/adb-ready/sessions` |
| Windows | `%LOCALAPPDATA%\adb-ready\sessions` with `%APPDATA%`/home fallback |

Directories and created files use restrictive permissions where the host
supports POSIX permission bits.

## Diagnostic context

Compile the latest session into a provider-neutral Markdown brief:

```bash
adb-ready context
adb-ready context SESSION_ID
adb-ready context --since 5m
adb-ready context --only problems,recovery,logs
adb-ready context --budget 8000
```

Available filters are `problems`, `recovery`, `logs`, `child`, `state`, `target`,
and `ports`. The compiler prioritizes structured problems, failures, warnings,
recovery, and nearby diagnostic output within the requested character budget.
It reports how many events were filtered or omitted.
Repeated successful health checks are represented once with their count and
final timestamp. The stored NDJSON remains complete, so compact AI context does
not discard diagnostic evidence.

Use JSON when another local tool should consume the result envelope:

```bash
adb-ready context --format json > adb-ready-context.json
```

## Privacy boundary

Before persistence or export, ADB Ready:

- redacts known token, credential, pairing-code, URL, and path patterns;
- replaces observed device and project identities with short SHA-256
  fingerprints;
- honors additional environment names configured in
  `dev.journal.redactEnvironment`;
- bounds both the in-memory journal and saved session history; and
- makes no network request.

The context document labels timeline data as untrusted evidence so that copied
logs cannot masquerade as instructions. Redaction is defense in depth, not a
guarantee that arbitrary application output contains no sensitive business
data. Review every export before sharing it.
