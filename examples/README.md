# Configuration examples

These files are intentionally small starting points. Copy the closest example
to the project root as `adb-ready.config.json`, then run:

```bash
adb-ready config validate
adb-ready config explain
adb-ready dev --dry-run
```

- [`expo/adb-ready.config.json`](./expo/adb-ready.config.json)
- [`react-native/adb-ready.config.json`](./react-native/adb-ready.config.json)
- [`gradle/adb-ready.config.json`](./gradle/adb-ready.config.json)
- [`flutter/adb-ready.config.json`](./flutter/adb-ready.config.json)
- [`capacitor/adb-ready.config.json`](./capacitor/adb-ready.config.json)
- [`custom/adb-ready.config.json`](./custom/adb-ready.config.json)
- [`ci-emulator/`](./ci-emulator/) — maintained GitHub-hosted emulator
  acceptance with a finite run and retained failure evidence
- [`ci-physical/`](./ci-physical/) — manual self-hosted physical-device job
  with explicit serial selection, host-local leasing, and bounded evidence
- [`automation/README.md`](./automation/README.md) — one finite AVD, deployment,
  verifier, evidence, and cleanup job

Prefer `adb-ready init` when starting from an existing detected project. Add
only the ports, hooks, and retention rules that the project genuinely needs.
