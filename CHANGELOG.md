# Changelog

All notable changes to ADB Ready are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the project is below `1.0.0`, minor releases may include documented
breaking changes.

## [Unreleased]

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

[Unreleased]: https://github.com/Adam014/adb-ready/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Adam014/adb-ready/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/Adam014/adb-ready/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Adam014/adb-ready/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Adam014/adb-ready/compare/v0.0.1-alpha.0...v0.1.0
