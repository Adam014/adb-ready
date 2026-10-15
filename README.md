# ADB Ready

<img src="https://raw.githubusercontent.com/Adam014/adb-ready/main/docs/assets/adb-ready-logo.png" width="96" height="96" alt="" align="right" />

[![npm](https://img.shields.io/npm/v/adb-ready)](https://www.npmjs.com/package/adb-ready)
[![CI](https://github.com/Adam014/adb-ready/actions/workflows/ci.yml/badge.svg)](https://github.com/Adam014/adb-ready/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

A CLI that gets an Android device ready for development and keeps it that way.

It picks one device, sets up `adb reverse` for the ports your project needs,
starts your dev server with that device, and only tells you it's ready once the
app is actually running on it. When wireless debugging drops or the port
changes, it reconnects the same device instead of grabbing another one.

It also lets coding agents like Claude Code, Codex or Cursor use the phone
through MCP, without giving them a shell.

<img src="https://raw.githubusercontent.com/Adam014/adb-ready/main/docs/assets/adb-ready-demo.gif" alt="ADB Ready starting a development session on an Android phone" width="800" />

## Why

I had an `adb-reverse.sh` in my Expo project. It found my phone, reconnected
wireless debugging after the port changed, skipped the emulator, set up the
reverse ports and started Expo with the right `ANDROID_SERIAL`. It broke every
few days in a new way, and once I started letting a coding agent run the app,
it broke more often.

ADB Ready is that script done properly.

## Install

You need Node.js 22+ and Android SDK Platform-Tools (`adb`).

```sh
npm install --save-dev adb-ready
npx adb-ready dev
```

pnpm, Yarn and Bun work too (`pnpm add -D adb-ready`, `yarn add -D adb-ready`,
`bun add -d adb-ready`). `adbr` is a shorter alias for the same command.

Running `adb-ready` with no command opens an interactive menu. If you've never
connected a phone before, start with **Set up first device** there.

## Usage

Start a development session:

```sh
adb-ready dev                         # detects Expo, React Native, Flutter, Capacitor or Gradle
adb-ready dev --port 8081 --port 8000 # also reverse your local API port
adb-ready dev -- pnpm run android     # run your own command instead
```

If Metro is already running, ADB Ready checks it belongs to this project and
attaches to it instead of starting a second one.

Check what's going on:

```sh
adb-ready doctor    # is adb installed, can it see devices, what's wrong
adb-ready devices   # list phones and emulators
adb-ready logs --package com.example.app
```

Work with the app and the screen:

```sh
adb-ready ui tap "text=Sign in"
adb-ready ui fill "id=email" "me@example.com"
adb-ready capture screenshot
```

### With a coding agent

```sh
npx adb-ready agent setup claude-code   # or codex, cursor, vscode, windsurf
```

This adds the MCP server and a skill file to your project. Then you can ask
something like *"start the app on my phone, log in, and check the home screen
loads"*. The agent can start the session, tap and type, take screenshots and
read the app's logs. It can't run shell commands or uninstall apps. More in
[AI agent integration](./docs/agent-integration.md).

### In CI

```sh
npx adb-ready run -- npm run test:e2e
```

`run` waits until the device and app are ready, runs your command, and keeps
its exit code. If it fails, logs, screenshots and a JUnit report are saved in
`.adb-ready/artifacts/`. There's a ready-made
[GitHub Actions emulator workflow](./examples/ci-emulator/) you can copy.

## What it won't do

- It doesn't replace `adb`, Android Studio, Expo or React Native. It runs them.
- It never restarts your ADB server behind your back.
- It never switches to a different device in the middle of a session.
- It doesn't upload anything. No account, no telemetry, no API keys.
- Android only. There's no iOS support and none planned for now.

## Status

This is a young project. I've tested it on a real phone only on macOS with a
Galaxy Z Fold4 over wireless debugging. CI runs it on macOS, Linux and Windows
against emulators. Other phones and setups should work, but I haven't tested them
myself yet. If something breaks on yours, please
[open an issue](https://github.com/Adam014/adb-ready/issues) with the output of
`adb-ready doctor`.

## Docs

- [Getting started](./docs/getting-started.md)
- [Development sessions](./docs/dev-sessions.md)
- [Devices and wireless debugging](./docs/targets-and-wireless.md)
- [UI automation](./docs/ui-automation.md)
- [Logs and debugging](./docs/logs-and-context.md)
- [AI agent integration](./docs/agent-integration.md)
- [CI and automation](./docs/automation.md)
- [Configuration](./docs/configuration.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Compatibility](./COMPATIBILITY.md)

There's more (Firebase Test Lab, Gradle Managed Devices, running on several
devices at once) in the [docs folder](./docs/). `adb-ready --help` lists every
command.

## License

[MIT](./LICENSE). [Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md)
