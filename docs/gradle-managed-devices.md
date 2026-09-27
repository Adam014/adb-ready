# Gradle Managed Devices

Use this workflow when the Android build already declares virtual devices or
device groups in Gradle. Gradle remains the lifecycle owner: it provisions the
emulator, installs the app and tests, applies sharding, runs instrumentation,
and tears the target down. ADB Ready does not select, lease, or send commands to
that transient emulator.

## Discover declared tasks

Run discovery from the Gradle project root:

```bash
adb-ready test gradle
```

ADB Ready invokes the checked-in `gradlew` or `android/gradlew` Wrapper and
lists only task descriptions that identify a managed device or device group.
If the Wrapper lives elsewhere, pass it explicitly:

```bash
adb-ready test gradle --gradle tools/gradlew
```

Task names belong to the project. Typical Android Gradle Plugin names resemble
`pixel2api35DebugAndroidTest` and
`phoneAndTabletGroupDebugAndroidTest`; ADB Ready does not invent a device,
variant, or group name.

## Preview and run one task

Preview the exact direct process invocation without starting Gradle:

```bash
adb-ready test gradle :app:pixel2api35DebugAndroidTest --dry-run --json
```

Then execute the same bounded task:

```bash
adb-ready test gradle :app:pixel2api35DebugAndroidTest --run-timeout 20m
```

Before execution, ADB Ready asks Gradle to resolve that exact task. A missing
task fails before test infrastructure starts. The task is passed directly to
the Wrapper without a shell.

## Groups, sharding, and server rendering

A declared group task runs through the same boundary:

```bash
adb-ready test gradle :app:phoneAndTabletGroupDebugAndroidTest
```

Request Gradle's managed-device sharding property when the build and Android
Gradle Plugin support it:

```bash
adb-ready test gradle :app:pixel2api35DebugAndroidTest --shards 4
```

On a headless host, opt into Gradle's documented SwiftShader property:

```bash
adb-ready test gradle :app:pixel2api35DebugAndroidTest --software-rendering
```

ADB Ready passes these properties for the current invocation. It never edits
Gradle files, creates SDK components, or changes a project's declared devices.

## Results and evidence

After execution, ADB Ready reads native files from the Android Gradle Plugin
managed-device result and report directories. It retains bounded XML,
HTML, JSON, logs, text, screenshots, and video under:

```text
.adb-ready/artifacts/gradle-managed-<run-id>/
```

Machine output keeps these outcomes distinct:

- `passed` — Gradle exited successfully and retained JUnit has no failures;
- `assertion-failed` — fresh JUnit reports a failed or errored test;
- `infrastructure-failed` — Gradle could not complete provisioning or execution
  and no test assertion explains the failure;
- `timed-out` — the configured finite timeout expired;
- `cancelled` — the caller interrupted the task;
- `GRADLE_MANAGED_TASK_NOT_FOUND` — exact task preflight failed.

The original Gradle result and report trees remain the source artifacts. The
ADB Ready copy is bounded, redacted where textual, and convenient for CI upload
or an agent. Failed tasks can only classify assertions from files written by
that execution. A successful up-to-date Gradle task may retain the output that
Gradle validated from its cache, explicitly marked with `gradle-cache`
provenance.

## Responsibility boundary

Use `adb-ready test gradle` for Gradle-owned virtual devices. Use
`adb-ready run` when ADB Ready must own one already visible ADB target, prepare
ports and a development service, run a finite verifier, and clean only its own
resources. Connected-device tasks therefore remain under `run`; they are not
misrepresented as Gradle Managed Devices.
