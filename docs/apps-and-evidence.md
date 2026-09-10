# Apps and evidence

ADB Ready resolves project identity locally when possible, then binds
target-based app operations and evidence to one deterministic Android target.
It reports success only after the requested postcondition is observed.

## App identity

Inspect the project app without hard-coding its package name:

```bash
adb-ready app resolve
adb-ready app info
```

Resolution prefers an explicit `APP_ID`, then project configuration and
detected Android project metadata. Every resolved result includes provenance.
If equally valid candidates remain, ADB Ready asks for an explicit choice
instead of selecting the first package.

Explicit, configured, Gradle, Expo, and manifest identity can be resolved with
no running emulator, connected phone, or ADB binary. Only the final
installed-package fallback requires a target.

Set a stable project value when detection is not sufficient:

```json
{
  "app": {
    "android": {
      "package": "com.example.app"
    }
  }
}
```

List installed packages when investigating a target:

```bash
adb-ready apps list
adb-ready apps list --system --filter google
adb-ready apps list --all --json --non-interactive
```

User packages are the default. Enumeration and machine output are bounded.

## App lifecycle

```bash
adb-ready app install ./android/app/build/outputs/apk/debug/app-debug.apk --replace
adb-ready app launch
adb-ready app restart
adb-ready app stop
adb-ready open 'myapp://orders/42' --package com.example.app
```

- Installation currently accepts one ordinary APK. Split APK sets, `.apks`,
  `.aab`, and implicit downloads are not accepted.
- Install, launch, stop, restart, and explicit deep-link handlers are checked
  after ADB accepts the request.
- `restart` is a verified stop followed by a verified launch.
- Add `--activity .MainActivity` only when Android cannot resolve a launchable
  activity.
- Add `--grant-runtime-permissions` to an install only when that behavior is
  intended.

Preview exact target-scoped ADB operations without changing the device:

```bash
adb-ready app restart --dry-run --json
adb-ready app clear-data --dry-run
```

`clear-data` and `uninstall` are destructive. Interactive use requires a
confirmation; automation must pass `--allow-destructive`. A dry run never asks
for destructive approval because it performs no mutation.

## Structured inspection

Build a compact snapshot of the project app, foreground state, and a small
classified log window:

```bash
adb-ready inspect app
adb-ready inspect app com.example.app --json --non-interactive
```

Screenshots are deliberately not captured by this read-only command. The
result reports `adb-ready capture screenshot` as the explicit next action so
sensitive pixels never enter evidence or AI context implicitly.

Read the current Android accessibility hierarchy:

```bash
adb-ready inspect ui --interactive-only
adb-ready inspect ui --max-depth 20 --json --non-interactive
```

The snapshot is capped at 2,000 nodes and includes a SHA-256 digest. Each node
reference contains a prefix of that digest, so callers can distinguish stale
references after the UI changes. `--interactive-only` keeps enabled actionable
nodes; `--max-depth` accepts 1–100. Secure windows and missing accessibility
data are reported as unavailable rather than as an empty successful snapshot.

UI text and hierarchy data are marked `sensitive: true`. They are returned only
by the explicit inspect command and are never included in diagnostic AI context
automatically.

## Evidence capture

Capture a PNG directly from the selected target:

```bash
adb-ready capture screenshot
adb-ready capture screenshot --out artifacts/login.png
```

Capture a bounded MP4 recording:

```bash
adb-ready capture screen-record --duration 15s
adb-ready capture screen-record --duration 30s --out artifacts/repro.mp4
```

Evidence paths are relative to the current project. A capture never follows a
symlink outside that root and never replaces an existing file unless `--force`
is explicit. Files are written through a private temporary path and published
only after validation.

The result contains:

- a project-relative path;
- media type and byte size;
- SHA-256 digest;
- selected target and capture-command provenance.

Binary data is stored as a file rather than embedded into JSON or AI context.
Screenshots and recordings can contain private information; ADB Ready does not
upload or implicitly attach them to diagnostic context.

## Target selection and automation

All commands accept the standard target selectors:

```bash
adb-ready app info --device SERIAL
adb-ready capture screenshot --transport-id ID
adb-ready app restart --last
```

Use `--json --non-interactive` for one versioned result on `stdout`, or
`--format ndjson` for structured progress plus the final result. Human progress
and errors remain on `stderr`.
