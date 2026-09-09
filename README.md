# ADB Ready

> Make an Android target ready, then keep the development session working.

ADB Ready is an early-alpha, Android-only developer CLI built around the real
`adb` executable. This release establishes the portable and scriptable
foundation for the broader development-session workflow.

## Try the alpha

ADB Ready currently requires Node.js 22 or newer and an installed Android SDK
Platform-Tools `adb` executable.

```bash
npx adb-ready@alpha
npx adb-ready@alpha doctor
npx adb-ready@alpha devices
```

The package also exposes the shorter `adbr` command. Both names invoke the same
CLI entrypoint.

## Available now

- Interactive keyboard-driven home screen.
- Read-only environment and ADB diagnostics with `doctor`.
- Read-only Android target discovery with `devices`.
- Deterministic target selection through `--select`.
- Human, plain, JSON, and NDJSON output.
- Explicit ADB executable, server host, server port, timeout, and presentation
  controls.
- Portable execution through Node, Bun, and Deno.

Run `npx adb-ready@alpha --help` for the complete command reference.

## Runtime and package-manager entrypoints

The same npm package can be launched through the common JavaScript package
managers:

```bash
npx adb-ready@alpha doctor
pnpm dlx adb-ready@alpha doctor
yarn dlx adb-ready@alpha doctor
bunx adb-ready@alpha doctor
```

Explicit alternative runtimes are also supported:

```bash
bunx --bun adb-ready@alpha doctor
deno run -A npm:adb-ready@alpha doctor
```

## Alpha scope

Wireless pairing and recovery, reverse and forward ports, Expo and React Native
presets, and the flagship `adb-ready dev` session are not included yet. The
current commands are intentionally read-only and never restart the ADB server
or mutate a connected device.

This preview is published to validate the CLI foundation and reserve the
canonical package name during active development. The source repository remains
private during the early implementation phase, and this alpha is currently
distributed as `UNLICENSED` software.
