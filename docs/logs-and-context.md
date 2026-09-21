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
| `--tail COUNT` | Begin with the most recent matching record count |
| `--since TIMESTAMP` | Pass an Android logcat timestamp boundary |
| `--max-records COUNT` | Bound records retained in the final result |

The same tag cannot be passed to both `--tag` and `--exclude-tag`. ADB Ready
rejects that contradictory request before accessing ADB so an exclusion can
never appear to succeed while logcat returns the tag.

`--tail` is applied after package, process, tag, priority, and buffer filters.
With a live stream, ADB Ready snapshots the matching history and overlaps the
follow boundary so records written during setup are neither lost nor repeated.

Unparsed lines are preserved. Output arriving on `stderr` is not automatically
classified as an error; severity comes from source semantics. Fatal Android
exceptions, native crashes, ANRs, and React Native fatal errors become
structured findings. Package-scoped streams first verify the installed package
identity, prefer Android's restart-stable UID filter when the selected target
supports it, and fall back to the package's current PID on older targets.

Development sessions do not infer application ownership from a broad tag such
as `AndroidRuntime`. Before an application identity is verified, matching
target-wide records are retained as low-priority `log.unattributed` evidence
and never promoted to application problems. A configured `app.android.package`
or `dev --package APP_ID` scopes the stream directly; Expo sessions retarget it
to the package that Android resolves for the verified launch URL.

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

Running-session summaries are reconciled from the append-only event journal at
read time. `sessions list`, `sessions show`, and `context` therefore expose the
latest completely persisted event count, byte count, update time, and known
preset without rewriting the manifest for every log line. A trailing event
that is still being appended is ignored until its terminating newline is
durable, so concurrent inspection never treats a partial JSON record as a
corrupt session.

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
- preserves operational transport IDs and bounds short literal matches to
  complete identifier tokens, preventing unrelated timestamps, ports, hashes,
  and correlation IDs from being altered;
- honors additional environment names configured in
  `dev.journal.redactEnvironment`;
- bounds both the in-memory journal and saved session history; and
- makes no network request.

The context document labels timeline data as untrusted evidence so that copied
logs cannot masquerade as instructions. Redaction is defense in depth, not a
guarantee that arbitrary application output contains no sensitive business
data. Review every export before sharing it.
