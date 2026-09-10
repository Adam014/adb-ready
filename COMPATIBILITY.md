# Compatibility

ADB Ready is distributed as portable JavaScript and delegates Android transport
work to the user's real `adb` executable. It does not contain native addons and
does not block installation by operating system or CPU architecture.

## Support policy

| Tier | Environments | Contract |
| --- | --- | --- |
| CI target | macOS arm64, Linux x64, Windows x64 | The complete verification gate is configured to run on every push and pull request. |
| Runtime target | Node.js 22, 24, and 26; current Bun; Deno 2 npm compatibility | The packed CLI entrypoint and deterministic command contract must launch successfully. |
| Upstream-capable | macOS x64, Linux arm64, Windows arm64, musl Linux, WSL 2, containers, ChromeOS Linux, and BSD | Supported when a compatible JavaScript runtime and a working `adb` executable are available. Reports are accepted and no package metadata intentionally blocks these hosts. |

“Upstream-capable” is not a lower-priority user class. It records that the
availability of Platform-Tools, USB passthrough, mDNS, or host networking can be
controlled by the operating environment rather than ADB Ready. Compatibility
claims move to the CI tier only after they have a reproducible test environment.

## Architecture and dependencies

- The npm artifact is architecture-neutral JavaScript.
- Node.js 22 or newer is the installation baseline.
- `adb` remains an external dependency and can be supplied through `PATH`, an
  Android SDK location, or `--adb PATH`.
- USB and wireless visibility depend on what the selected ADB server can access.
  Remote servers are supported through `--adb-host` and `--adb-port`.
- npm, pnpm, Yarn, and Bun consumers use the same package and the same
  `adb-ready`/`adbr` entrypoint.

## Honest verification boundary

Deterministic fixtures cover platform paths, ADB output variants, target states,
IPv4/IPv6 discovery, selection, cancellation, timeouts, and packaging. A local
read-only smoke test is available as `bun run verify:real-adb`.

Physical USB, emulator, wireless, VPN, container, WSL, and remote-server claims
must be recorded as tested only after they pass on that real environment. ADB
Ready never treats a fixture as proof of hardware compatibility.
