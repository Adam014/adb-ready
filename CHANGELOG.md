# Changelog

All notable changes to ADB Ready are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the project is below `1.0.0`, minor releases may include documented
breaking changes.

## [Unreleased]

### Fixed

- Reconcile running session summaries from their complete persisted events so
  session lists, details, and AI context show current counts, timestamps, and
  the resolved preset before finalization without per-log manifest rewrites.
- Scope development-session crash diagnostics to a verified Android package
  UID or PID, retarget Expo logs after its resolved launch, and keep unrelated
  target-process crashes out of application problems and below attributed
  evidence in prioritized AI context.
- Serialize Android UI hierarchy capture per target across CLI and MCP
  processes, preventing concurrent read-only automation from racing the
  platform's single active UI Automation service, without taking a mutation
  lease for read-only UI queries.
- Replace non-functional framework shortcut claims with ADB Ready-owned Expo
  reload and developer-menu controls over a verified local Expo channel, and
  advertise them only after the interactive control input is active.
- Verify Expo's canonical project identity before attaching to an existing
  Metro server, preventing a development session from silently reusing another
  project's server on the same port.
- Support Expo and other localhost services that listen only on IPv6 by
  creating a session-owned IPv4 loopback bridge for `adb reverse`, then close
  that bridge during ownership-safe cleanup.

### Added

- Model optional Android tooling as typed `supported`, `unavailable`,
  `incompatible`, or `unverified` capabilities and build deterministic,
  non-mutating plans for autonomous target, deployment, verifier, evidence,
  and owned-resource cleanup workflows.
- Reuse or start one exact existing Android virtual device, prove ADB, boot,
  package-manager, and unlock readiness, and stop only emulator processes that
  the active workflow owns.
- Resolve explicit or framework build artifacts from bounded Android output
  metadata, keep ABI variants separate, select only proven target-compatible
  APKs, and reject stale, ambiguous, incomplete, or unsafe candidates.
- Deploy APK and split APK artifacts through one target-scoped ADB transport,
  build and install AAB or APK Set inputs with explicit bundletool, verify the
  installed package, version, and launch activity, and clean only owned
  temporary output.
- Compose existing-AVD startup, deterministic artifact deployment, project
  readiness, one bounded external verifier, normalized evidence, and
  ownership-safe cleanup in the existing `run` command with a mutation-free
  dry-run plan.
- Preserve bounded, redacted native verifier stdout and stderr in every run
  evidence bundle, including structured preparation failures after cleanup.

## [0.4.1] - 2026-09-16

### Fixed

- Resolve Expo Go and development-client launch URLs through Expo's supported
  `/_expo/link` redirect without probing an unhandled route that could consume
  the request timeout, and report distinct timeout, connection, response, and
  unsafe-redirect failures.

## [0.4.0] - 2026-09-15

### Added

- Detect explicit localhost ports in Expo `EXPO_PUBLIC_*` environment URLs,
  include them in development-session reverse mappings and readiness checks,
  and surface only their variable names, ports, and loaded environment-file
  names.
- Show a compact, preset-aware live control bar in interactive `dev` sessions
  while preserving the framework's native stdin and keeping automation silent.
- Attach Expo and React Native sessions to a positively identified Metro server
  that is already running, without starting, controlling, or stopping it.

### Fixed

- Stop and await development-session health monitoring before intentional
  teardown, preventing cancelled probes from creating false recovery evidence.
- Omit a missing Android package `versionName` from structured app information
  instead of serializing Android's `null` sentinel as a real version string.
- Stop reporting an available host package manager as detected project
  metadata in Flutter, Gradle, and other non-JavaScript projects, and omit the
  irrelevant setting from generated native-project configuration.
- Report missing Flutter and Gradle launchers as framework prerequisites with
  the attempted launcher and actionable setup guidance instead of an
  unspecified development-command error.
- Preserve unrelated diagnostic text when a short numeric ADB transport ID is
  observed; transport IDs remain operational evidence and short private
  literals match only complete identifier tokens.
- Parse complete Android 16 lock-screen and foreground-activity state during
  strict readiness checks, and show actionable per-assertion failure details in
  human session output.
- Apply `logs --tail` after logcat filtering, and overlap snapshot-to-follow
  handoff so a live filtered tail neither loses nor repeats setup-time records.
- Reject contradictory log-tag include and exclude filters before accessing
  ADB instead of allowing logcat argument order to silently override exclusion.
- Document every supported app-install and package-list action option in the
  focused command help, including filtering and install verification flags.
- Make UI audits follow Android hierarchy semantics: inherit effective labels
  through control descendants and actionable ancestors, exclude structural
  focus and scrolling containers, and explain every finding with confidence
  and rule rationale.
- Make `ui scroll` directions describe content navigation—such as `down`
  revealing content below—while keeping `ui swipe` directions as physical
  finger gestures.
- Reject unreadable or one-frame, zero-duration Android screen recordings
  instead of publishing them as verified evidence, and report the measured
  duration and frame count for valid recordings.
- Recognize Android's separate accessibility hint when verifying `ui clear`,
  so an empty field displaying its placeholder is not reported as a failure.
- Let unique text and description selectors target their nearest enabled
  actionable ancestor while reporting both the matched label and action node.
- Keep the interactive home and focused menus inside the detected terminal
  width, including real narrow PTYs, without implicit last-column wrapping.
- Prevent a development session from reporting ready after its owned command
  has already exited; distinguish passed readiness checks from the complete
  session-ready gate and promote the first actionable child error.
- Keep successful readiness and health polling silent in human output and out
  of the durable session journal while retaining failures and state changes.
- Keep Expo's automatic Android launch on the one selected ADB transport: start
  Metro without Expo's all-device `--android` path, resolve the official launch
  URL with an Expo 55-compatible fallback, and open it through target-scoped
  ADB before reporting the session ready.
- Prevent an Expo development session from reporting ready while a detected
  localhost API is unreachable from the selected Android target.
- Make `adb-ready help version` follow the same focused-help contract as every
  other visible top-level command without loading project configuration or ADB.
- Fail with a specific service conflict when Metro's configured host port is
  occupied by another service instead of launching into an ambiguous port error.

## [0.3.5] - 2026-09-12

### Changed

- Enforce at least 95% coverage of measurable executable lines added or
  replaced by a pull request, in addition to the existing repository-wide
  line and function coverage floors.
- Keep external source maps available in local builds while excluding their
  unreferenced payload from the published npm package.
- Make the read-only real-ADB check report logical targets and raw transports
  separately and fail when ADB returns an unrecognized device state.

### Fixed

- Preserve complete mDNS transport serials containing Bonjour collision
  suffixes such as ` (2)`, preventing one physical device from appearing as a
  second unknown target.
- Classify connected `_adb-tls-connect._tcp` service transports as TLS even
  when their mDNS serial contains a Bonjour collision suffix.

## [0.3.4] - 2026-09-12

### Added

- Publish the verified LCOV report to Codecov through short-lived GitHub OIDC
  credentials and show the measured `main` coverage in a live README badge.

### Changed

- Raise the authoritative LCOV line and function coverage floors from 90% to
  95% with additional lifecycle, recovery, agent, configuration, persistence,
  platform, terminal, and protocol boundary tests.

### Fixed

- Keep a development session running when optional local session history cannot
  be initialized or finalized, while reporting the persistence gap as a warning.
- Return a structured target-lease availability error when its per-user state
  directory cannot be created instead of leaking an internal filesystem error.

## [0.3.3] - 2026-09-11

### Changed

- Fail closed before npm publishing unless the immutable release tag already
  has a matching draft GitHub release.
- Isolate the push-level permission needed to inspect that draft release in a
  preflight job that never checks out or executes repository code.
- Allow the audited workflow on protected `main` to promote an exact immutable
  release tag, so release-infrastructure fixes never require moving that tag.
- Document Deno's 24-hour minimum dependency age and the explicit override
  reserved for immediate post-publish verification.
- Enforce 90% LCOV line and function coverage floors in the authoritative
  verification gate and preserve its LCOV report in CI.

## [0.3.2] - 2026-09-11

### Fixed

- Keep the commandless capability overview as clean structured JSON when
  `--non-interactive` is combined with `--json` or `--format json`, regardless
  of flag order, and cover the installed package through both executable
  aliases.

### Changed

- Keep the public security support table aligned with the current release line
  through an automated release check.
- Clarify which verification, real-device, and support-expansion evidence is
  required for each kind of release.

## [0.3.1] - 2026-09-11

### Changed

- Clarify package ownership and normalize the maintainer identity used by
  repository history and published package metadata.
- Reorganize the public README around six user outcomes and explicit entry
  paths for coding agents, terminal users, and CI automation.
- Add copy-and-paste installation paths for npm, pnpm, Yarn, and Bun.
- Replace the simulated terminal snippet with an optimized product walkthrough
  showing development startup, UI verification, and agent-driven recovery,
  while keeping the marketing asset out of the installed npm package.
- Require an explicit release tag when manually dispatching the release
  workflow instead of retaining a stale version default.

## [0.3.0] - 2026-09-11

### Added

- Scope saved sessions, latest-problem lookup, AI context, and MCP session
  resources to the canonical current project by default, with an explicit
  `--all-projects` escape hatch for cross-project audits.
- Add privacy-safe cross-process Android target leases with heartbeats, bounded
  expiry, stale-owner recovery, and ownership-checked cleanup for app, UI,
  port, recording, and development-session mutations.
- Let `dev --dry-run` resolve and validate the project, command, ports, and
  lifecycle hooks without requiring ADB or allocating an Android target. An
  explicit target selector still produces the target-resolved plan.
- Add composable readiness contracts for boot, unlock, process, foreground
  activity, exact UI selectors, host ports, HTTP responses, and bounded log
  presence or absence. Expo and React Native sessions now verify Android boot
  and Metro reachability before reporting ready.
- Add `adb-ready run -- COMMAND` as a finite automation entrypoint: start the
  configured development service, satisfy readiness, execute one timeout-bound
  verification command, preserve its exit code, and clean owned resources.
- Produce an atomic, redacted evidence bundle for every executed `run` with a
  versioned manifest, structured result, NDJSON timeline, problems, logcat,
  bounded AI context, JUnit XML, and GitHub step-summary Markdown.
- Advertise and validate a versioned result-envelope output schema for every
  MCP tool, return screenshot pixels as MCP image content, and issue stable
  connection-scoped target handles that reject stale or cross-connection use.
- Let MCP `ensure_ready` reconnect an explicitly addressed endpoint or the only
  unambiguous paired wireless service before binding it.
- Exercise the complete MCP contract on Node.js, Bun, and Deno across both the
  legacy 2025-11-25 and modern 2026-07-28 protocol eras.
- Add semantic UI find, assert, digest comparison, and selector-driven tap or
  long-press workflows. Structured selectors support exact, prefix, and
  contains matching plus enabled/actionable qualifiers; ambiguous mutations
  fail instead of guessing.
- Add project-scoped `start_dev_session`, `get_dev_session`, and
  `stop_dev_session` MCP tools backed by opaque durable handles. Managed
  sessions continue outside one tool call, survive client reconnects, report
  heartbeats and terminal exit state, and stop only their verified owned
  process group.
- Add status, recency, preset, and count filters to project-scoped session
  history.
- Install a single APK or a complete split APK set through verified `install`
  and `install-multiple` workflows in both CLI and MCP.
- Detect and run Flutter and Capacitor Android projects on the exact selected
  target, with boot readiness and no invented default port mappings.
- Add intent-level UI read, field fill/clear, and container-scoped scroll
  workflows for CLI and MCP. Field replacement is capability-gated before
  mutation and verifies observable values instead of inferring success from
  input exit codes.
- Add a project-scoped MCP session index with status, preset, recency, limit,
  and stable cursor pagination so agents can locate relevant saved evidence
  without scanning unrelated history.
- Add a bounded CLI/MCP screen audit that identifies enabled actionable nodes
  without human-readable labels and controls without stable resource IDs,
  returning concrete nodes instead of a subjective score.
- Bind finite verification commands to the leased target through
  `ANDROID_SERIAL`, `ADB_READY_TARGET_SERIAL`, and an explicit
  `{target.serial}` argument placeholder for tools such as Maestro that require
  their own device flag.
- Report measured acquisition time alongside every before/after UI snapshot so
  agents and CI can identify slow accessibility inspection without guessing.

### Changed

- Compact repeated successful health checks in bounded AI context while
  preserving the complete redacted NDJSON timeline as source evidence.
- Reorganize the interactive home around development, test automation, device,
  debugging, and project tasks; preserve root presentation flags and use copy
  that remains meaningful in narrow terminals.
- Add the screen agent-readiness audit to the task-oriented Debug & evidence
  menu without expanding the root menu.
- Lead the public README with the agent outcome, immediate setup, and a concrete
  first task before the implementation details.

### Fixed

- Return a structured capability overview for bare machine-mode invocation and
  suggest high-confidence corrections for mistyped commands or options.
- Apply retention limits per project before the global safety cap so one noisy
  project cannot evict another project's recent diagnostic history.
- Keep packaged command-matrix development sessions inside an isolated
  temporary state directory instead of polluting the user's session store.
- Correct the public installation guide so its compatibility note no longer
  contradicts the documented split APK support.
- Give accessibility hierarchy acquisition its own 15-second default deadline
  in inspect and UI workflows while preserving an explicit global timeout.
  This prevents ordinary slower OEM UI Automator dumps from failing at the
  generic five-second ADB boundary.
- Classify Android's successful-exit `could not get idle state` response as a
  distinct `UI_NOT_IDLE` problem with a safe recovery instruction instead of
  misreporting an inaccessible hierarchy.
- Finalize an explicitly stopped managed development task as interrupted even
  when Windows terminates the owned child before its signal handler can write
  the terminal record.

## [0.2.0] - 2026-09-10

### Added

- Resolve Android application IDs with provenance, enumerate installed
  packages, and inspect one project app on a deterministic target.
- Resolve known project application IDs without requiring ADB or a connected
  target; use installed packages only as the final fallback.
- Install, launch, stop, restart, clear, uninstall, and deep-link apps with
  explicit destructive policy, mutation-free dry runs, and postcondition
  verification.
- Capture verified PNG screenshots and bounded MP4 screen recordings into
  atomically published project-local evidence files with SHA-256 metadata,
  including OEM multi-display screenshot output with a bounded text preamble.
- Inspect one app and the current accessibility hierarchy as bounded,
  explicitly sensitive snapshots with digest-scoped UI references.
- Give local AI agents 19 typed Android tools and saved-session context over a
  tested Node.js, Bun, and Deno MCP stdio server without exposing raw shell/ADB
  or destructive app removal. Calls within one connection are serialized to
  preserve deterministic target and UI state.
- Generate or safely merge project MCP setup for Codex, Claude Code, Cursor,
  and VS Code, with non-mutating snippets for Windsurf and generic clients.
- Expose current targets, saved manifests, paginated redacted events, and
  bounded Markdown context as local MCP resources.
- Safely tap, long-press, swipe, type, press allowlisted keys, and wait for exact
  UI postconditions with stale-reference protection and before/after evidence.
- Replace the command-heavy interactive home with focused workflow categories
  and progressive disclosure.

## [0.1.2] - 2026-09-10

### Changed

- Start live log streams at the current buffer position by default, while
  keeping explicit history available through `--tail`, `--since`, and `--dump`.
- Color live logcat and child output by parsed severity and conservative message
  semantics without treating every `stderr` line as an error.
- Present a safely handled `Ctrl-C` as an interruption while preserving exit
  code 130 and a failed machine result for automation.

### Fixed

- Correlate duplicate ADB 37 mDNS service-name and stable endpoint transports
  only when exact discovery and observed hardware identity prove they match.
- Prevent port-list results from being misclassified as saved-session results in
  human and plain output.
- Emit saved session timelines as one event per NDJSON line followed by a compact
  result summary instead of duplicating the complete event array.

## [0.1.1] - 2026-09-10

### Fixed

- Keep successful background target and port health probes in diagnostic
  events without repeatedly printing them over development-server output.

## [0.1.0] - 2026-09-10

### Added

- Interactive and non-interactive Android workflow entrypoints.
- Deterministic USB, emulator, and Wireless debugging target selection.
- Secure pairing, wireless connection, and ADB capability diagnostics.
- Verified TCP reverse and forward port management.
- Expo, React Native, native Gradle, and direct custom development sessions.
- Bounded target and port health recovery with independently verified repairs.
- Targeted structured logcat, private session history, problem inspection, and
  redacted AI-ready context export.
- JSON Schema-backed project configuration, profiles, lifecycle hooks, and
  explainable configuration precedence.
- Human, plain, JSON, and NDJSON output across Node, Bun, and Deno entrypoints.

[Unreleased]: https://github.com/Adam014/adb-ready/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Adam014/adb-ready/compare/v0.3.5...v0.4.0
[0.3.5]: https://github.com/Adam014/adb-ready/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/Adam014/adb-ready/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/Adam014/adb-ready/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/Adam014/adb-ready/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Adam014/adb-ready/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Adam014/adb-ready/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Adam014/adb-ready/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/Adam014/adb-ready/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Adam014/adb-ready/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Adam014/adb-ready/compare/v0.0.1-alpha.0...v0.1.0
