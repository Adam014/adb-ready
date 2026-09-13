# Development sessions

`adb-ready dev` owns one target-bound development lifecycle. It composes target
acquisition, ports, a project command, logs, health monitoring, cleanup, and a
local diagnostic record.

## Presets

| Preset | Detection | Default command | Default reverse port |
| --- | --- | --- | --- |
| Expo | `expo` dependency | project `start` script with `--android`, otherwise Expo CLI | `8081` |
| React Native | `react-native` dependency | project `android` script, otherwise React Native CLI | `8081` |
| Flutter | `pubspec.yaml` | `flutter run -d <selected-target>` | none |
| Capacitor | `@capacitor/android` or `@capacitor/core` dependency | Capacitor CLI for the selected target | none |
| Gradle | wrapper or Gradle build file | wrapper `installDebug` | none |
| Custom | explicit config or `--` | exact executable and argument array | none |

Select a preset when detection is intentionally unavailable or ambiguous:

```bash
adb-ready dev --preset expo
adb-ready dev --preset react-native --package-manager pnpm
adb-ready dev --preset flutter
adb-ready dev --preset capacitor
adb-ready dev --preset gradle --device emulator-5554
```

An exact command after `--` wins over preset command resolution:

```bash
adb-ready dev -- bun x expo start --host lan --port 8081 --android
```

No shell is inserted. Quoting, wildcard, pipe, and substitution syntax are
therefore passed as literal arguments instead of being executed unexpectedly.

## Target contract

One selected transport is used for the entire session:

- every direct ADB command uses its exact serial or transport ID;
- the child command receives `ANDROID_SERIAL`;
- hooks receive `ANDROID_SERIAL`, `ADB_READY_SESSION_ID`,
  `ADB_READY_PRESET`, and `ADB_READY_TARGET_ID`; and
- recovery accepts a changed wireless endpoint only when identity evidence
  safely ties it to the selected target.

Use `--device`, `--transport-id`, `--last`, or `--select` to override the normal
selection policy.

## Port ownership

The session treats each requested mapping as one of three states:

- **already present:** reuse it and never remove it;
- **missing:** add, verify, remember ownership, and remove it on clean exit;
- **conflicting:** stop without overwriting another tool's mapping.

Disable cleanup only when the mapping should intentionally outlive the process:

```bash
adb-ready dev --no-cleanup-ports
```

## Existing Metro servers

For Expo and React Native, ADB Ready checks the local host behind the default
device port `8081` before launching the project command. It attaches only when
`/status` returns Metro's exact running-status response. An open port alone is
not sufficient evidence.

An attached Metro server remains externally owned:

- ADB Ready does not start, restart, send terminal controls to, or stop it.
- `Ctrl+C` ends only the ADB Ready session and cleans only mappings created by
  that session.
- Human, plain, JSON, and NDJSON results identify the external attachment.
- Session health checks detect when the external server disappears, but recovery
  never restarts a process ADB Ready does not own.
- A non-Metro service on the configured host port fails with
  `DEVELOPMENT_SERVICE_CONFLICT` and an actionable explanation.

Run Metro in its original terminal when you need its native reload or developer
controls. A newly started Metro process continues to receive its controls
directly through ADB Ready.

## Health and recovery

Once ready, the session watches:

- selected target state;
- required reverse mappings; and
- the owned logcat stream when logs are enabled.

Recovery waits for a bounded stabilization period, attempts to reacquire the
same target, restores only missing session mappings, restarts the targeted log
stream when necessary, and verifies the complete state independently.

The default recovery budget is three attempts with exponential delay capped at
four seconds and a total 30-second deadline. Exhaustion produces
`SESSION_RECOVERY_FAILED` and stops the owned child. A shared ADB server restart
is never an automatic recovery action.

Configure the budget explicitly:

```json
{
  "version": 1,
  "dev": {
    "watch": true,
    "recovery": {
      "maxAttempts": 3,
      "initialDelayMs": 500,
      "maxDelayMs": 4000,
      "totalTimeoutMs": 30000
    }
  }
}
```

Set `dev.watch` to `false` only for a deliberately one-shot child process.

## Live terminal controls

An interactive `adb-ready dev` session shows a compact control bar after it
becomes ready. ADB Ready preserves the framework's native terminal input rather
than intercepting or redefining it:

- Expo shows `r` reload, `m` developer menu, `j` debugger, and `?` commands.
- Flutter shows `r` hot reload, `R` hot restart, and `h` commands.
- Other presets state that framework input is active without promising
  unsupported shortcuts.
- `Ctrl+C` stops the owned child and performs the normal verified cleanup.

The control bar is never rendered by `run`, JSON/NDJSON output, redirected
streams, CI, `--non-interactive`, or `--quiet`. This keeps scripts deterministic
and leaves arbitrary child input untouched.

## Lifecycle hooks

Supported phases are:

```text
beforeDev → onTargetReady → onPortsReady → onReady
          → onChildExit (owned child only) → finally
```

Hooks are executable/argument arrays, not shell strings. Each hook may set a
working directory, timeout, failure policy, and explicit environment allowlist.

```json
{
  "version": 1,
  "dev": {
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
}
```

`fail` stops the workflow, `warn` records a warning and continues, and `ignore`
continues without turning the hook result into a problem. Hook output passes
through the same redaction boundary as the session journal.

## Exit behavior

- A successful child returns `0` after verified cleanup.
- An ordinary child failure preserves its exit code.
- Ctrl-C reaches owned children and returns `130` after cleanup.
- Cleanup or recovery failures remain visible as structured problems.
- A dry run performs no hooks, mappings, connection, or child execution.

Use `adb-ready sessions show` for the final summary and
`adb-ready sessions events` for the correlated timeline.
