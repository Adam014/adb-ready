# Autonomous Android verification

Preview the complete workflow without starting an emulator, installing an app,
or launching a process:

```bash
adb-ready run \
  --avd Pixel_9_API_36 \
  --artifact android/app/build/outputs/apk/debug/app-debug.apk \
  --package com.example.app \
  --dry-run \
  --json \
  -- maestro '--device={target.serial}' test .maestro/smoke.yaml
```

Remove `--dry-run` to execute the verified job. Use `--deploy --variant debug`
instead of `--artifact` when the project contains exactly one compatible debug
artifact. ADB Ready refuses ambiguous outputs instead of selecting by filename
or modification time.

The verifier is invoked directly, receives the same target in `ANDROID_SERIAL`
and `ADB_READY_TARGET_SERIAL`, and retains its bounded output in the run's local
evidence bundle. A matching emulator that was already running is left running;
only an emulator started by this invocation is stopped.
