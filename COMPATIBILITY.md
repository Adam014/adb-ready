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
- Firebase Test Lab workflows delegate to the current Google Cloud CLI supplied
  through `PATH` or `--gcloud PATH`. Provider access, billing, quotas, catalog
  availability, and Cloud Storage permissions remain Google Cloud project
  capabilities rather than host-runtime guarantees.
- USB and wireless visibility depend on what the selected ADB server can access.
  Remote servers are supported through `--adb-host` and `--adb-port`.
- Target-pool leases coordinate processes sharing one host-local per-user state
  directory. They are not a cross-runner distributed lock; multi-host labs need
  explicit runner routing or an external coordination backend.
- npm, pnpm, Yarn, and Bun consumers use the same package and the same
  `adb-ready`/`adbr` entrypoint.

## Honest verification boundary

Deterministic fixtures cover platform paths, ADB output variants, target states,
IPv4/IPv6 discovery, selection, cancellation, timeouts, and packaging. A local
read-only smoke test is available as `bun run verify:real-adb`.

Recorded physical acceptance:

| Host and target | Transport | Verified workflows |
| --- | --- | --- |
| macOS arm64 · Samsung Galaxy Z Fold4 (SM-F936B) · API 36 | Wireless debugging (TLS) | discovery and stable identity; app resolve/info/launch/restart; UI inspect/tap/stale-ref rejection/wait; multi-display screenshot; screen recording; Expo dev/reverse/Ctrl-C cleanup; concurrent MCP request ordering |

Physical USB, emulator, wireless, VPN, container, WSL, and remote-server claims
must be recorded as tested only after they pass on that real environment. ADB
Ready never treats a fixture as proof of hardware compatibility.

Firebase Test Lab command construction, catalog parsing, official exit-code
normalization, bounded evidence collection, cancellation, and failure paths are
covered by deterministic fixtures. The current Google Cloud CLI has also been
used to verify the real unauthenticated failure boundary. A paid remote matrix
has not yet been recorded for this release, so successful provider execution is
not presented as observed acceptance evidence.

Target-pool scheduling, bounded concurrency, fail-fast submission, queue
cancellation, stale-owner recovery, and aggregate semantics are covered by
deterministic fixtures. Cross-host contention and paid provider fan-out remain
outside the observed acceptance boundary until suitable infrastructure is
available.
