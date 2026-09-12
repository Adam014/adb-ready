# Contributing to ADB Ready

Thank you for helping make Android development sessions more reliable.

## Before opening a change

- Search existing issues and pull requests.
- Keep proposals focused on Android developer workflows and the real ADB
  backend.
- For behavior changes, describe the user problem, the observed ADB behavior,
  and the intended safety boundary.
- Never commit device identifiers, pairing codes, credentials, private logs, or
  unrelated project data.

## Local setup

The repository uses Bun for dependency management and contributor commands.
The built CLI must remain portable across its advertised Node, Bun, and Deno
runtimes.

```bash
git clone https://github.com/Adam014/adb-ready.git
cd adb-ready
bun install --frozen-lockfile
bun run verify
```

Useful focused commands:

```bash
bun run dev -- --help
bun run test
bun run test:coverage
bun run test:integration
bun run ui:playground
bun run verify:real-adb
```

The authoritative verification enforces at least 95% LCOV line and function
coverage, then generates `coverage/lcov.info`. CI publishes the verified report
to Codecov, which supplies the live coverage badge in the README. Coverage measures
exercised code; it does not replace the real-device acceptance matrix.

The real-ADB verification is read-only. Do not add a hardware mutation to it.

## Implementation expectations

- Use TypeScript for the public CLI and the real `adb` executable as the
  backend.
- Keep platform-specific behavior behind adapters.
- Spawn executables with explicit argument arrays; do not introduce an implicit
  command shell.
- Bind every operation in a session to one selected target, including child
  processes through `ANDROID_SERIAL`.
- Keep machine-readable output on `stdout` and human diagnostics on `stderr`.
- Preserve interactive, redirected, JSON, CI, reduced-motion, narrow-terminal,
  and non-interactive behavior.
- Add focused tests for parsers, selection, plans, failure classification, and
  every safety-sensitive branch.
- Update public documentation when behavior changes.

## Pull requests

Keep commits reviewable and chronological. A pull request should explain its
user-visible outcome, safety implications, test evidence, and any real-device
coverage. `bun run verify` must pass before review.

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
