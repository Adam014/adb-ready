# GitHub-hosted Android emulator

This fixture powers ADB Ready's maintained emulator acceptance workflow. It
demonstrates the ownership boundary used in ordinary CI:

1. the runner provisions and owns one Android emulator;
2. ADB Ready binds a finite run to its exact serial;
3. the fixture verifies Android boot and identity, opens Settings, and captures
   native evidence; and
4. ADB Ready retains normalized NDJSON, JUnit, screenshot, window, and manifest
   evidence before the runner tears its emulator down.

The workflow is [`android-emulator.yml`](../../.github/workflows/android-emulator.yml).
Every external Action is pinned to a full commit. The job uses no repository
secret and uploads evidence with `if: always()`.

Do not copy the fixture's custom development process into an application. Keep
your real project command and readiness assertions, then use the same bounded
shape:

```bash
npx adb-ready run \
  --device emulator-5554 \
  --run-timeout 10m \
  --json \
  --non-interactive \
  -- npm run test:e2e
```

ADB Ready does not implicitly create SDKs or AVDs. If another workflow layer
created the emulator, ADB Ready attaches without claiming ownership and leaves
emulator teardown to that layer.
