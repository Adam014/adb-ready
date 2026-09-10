# Apps and evidence

ADB Ready binds app operations and evidence to the same deterministic Android
target used by the rest of the CLI. It reports success only after the requested
postcondition is observed.

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
