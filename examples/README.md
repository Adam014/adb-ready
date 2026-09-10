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
- [`custom/adb-ready.config.json`](./custom/adb-ready.config.json)

Prefer `adb-ready init` when starting from an existing detected project. Add
only the ports, hooks, and retention rules that the project genuinely needs.
