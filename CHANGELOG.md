# Changelog

All notable changes to ADB Ready are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the project is below `1.0.0`, minor releases may include documented
breaking changes.

## [Unreleased]

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

[Unreleased]: https://github.com/Adam014/adb-ready/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Adam014/adb-ready/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Adam014/adb-ready/compare/v0.0.1-alpha.0...v0.1.0
