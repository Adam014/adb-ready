# Getting started

This guide takes a project from an unknown Android setup to its first ADB Ready
development session.

## 1. Install the prerequisites

Install Android SDK Platform-Tools and confirm that `adb` launches:

```bash
adb version
```

The standard npm entrypoint requires Node.js 22 or newer. The same package can
also run explicitly with Bun or Deno 2.

## 2. Install ADB Ready

```bash
npm install --save-dev adb-ready
```

Run it through the project's package manager so every team member uses the same
version:

```bash
npx adb-ready doctor
```

The full source build can be tested from a repository checkout:

```bash
bun install --frozen-lockfile
bun run build
node dist/cli.js doctor
```

## 3. Check the environment

```bash
adb-ready doctor
adb-ready devices
```

`doctor` is read-only. Resolve any reported `ADB_NOT_FOUND`, authorization, or
server problem before starting a session.

If more than one target is ready, select one explicitly:

```bash
adb-ready devices --select
adb-ready dev --device emulator-5554
```

## 4. Create project configuration

Preview the detected configuration before writing it:

```bash
adb-ready init --dry-run
adb-ready init
adb-ready config validate
```

Configuration is optional. Expo, React Native, and Gradle projects can be
detected without it; a committed config is useful when a team shares ports,
target aliases, recovery policy, or hooks.

## 5. Start developing

```bash
adb-ready dev
```

For Expo and React Native, TCP port `8081` is reversed by default. Add a local
API port as needed:

```bash
adb-ready dev --port 8081 --port 8000
```

Use a direct command for any other toolchain:

```bash
adb-ready dev -- pnpm run android:local
```

The child receives `ANDROID_SERIAL`, and the same serial is used for every ADB
operation in the session.

## 6. Diagnose a failed run

ADB Ready keeps a bounded, redacted local session history by default:

```bash
adb-ready problems
adb-ready sessions events
adb-ready context --since 5m --only problems,recovery,logs
```

`context` only writes local output. It does not contact an AI provider or any
other remote service.

## Next steps

- [Development sessions](./dev-sessions.md)
- [Targets and Wireless debugging](./targets-and-wireless.md)
- [Logs, problems, and AI context](./logs-and-context.md)
- [Configuration reference](./configuration.md)
- [Automation contract](./automation.md)
- [Troubleshooting](./troubleshooting.md)
