# ADB Ready

> Connect Android. Reverse localhost. Start developing.

ADB Ready is a planned open-source CLI for the complete everyday Android ADB
development workflow.

The product is intentionally Android-only. It is framework-agnostic and should
work in projects using Node, Bun, or Deno and npm, pnpm, Yarn, or Bun without
forcing the project's package manager to change.

The intended experience is one command:

```bash
adb-ready dev
```

That command should discover or recover a target, select it deterministically,
configure required reverse ports, export the same target through
`ANDROID_SERIAL`, launch Expo, React Native, or a custom command, and explain
failures in actionable language.

ADB Ready is broader than a wireless pairing utility. The planned product also
covers device management, pairing, forward/reverse ports, app lifecycle,
logcat, diagnostics, screenshots and recordings, file transfer, shell access,
and scriptable automation.

This repository is currently in product-definition and initial architecture
stage. Public installation and usage documentation will be added with the first
usable implementation.

## Planned Runtime and Distribution Support

ADB Ready is developed with Bun and TypeScript, but Bun is not intended to be a
required end-user runtime. The published CLI will use the portable
Node-compatible API subset shared by Node, Bun, and Deno.

Planned entry points:

```bash
npx adb-ready dev
pnpm dlx adb-ready dev
yarn dlx adb-ready dev
bunx adb-ready dev

# Explicit alternative runtimes
bunx --bun adb-ready dev
deno run -A npm:adb-ready dev
```

Runtime support is a tested contract, not a best-effort claim. A public release
must pass the CLI contract on Node, Bun, and Deno across the supported operating
systems.

## Planned CLI

```text
adb-ready dev
adb-ready devices
adb-ready connect
adb-ready pair
adb-ready ports
adb-ready apps
adb-ready logs
adb-ready doctor
adb-ready shell
```
