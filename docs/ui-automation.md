# Safe UI automation

ADB Ready can inspect and operate the current Android UI without exposing a
generic shell. Every mutation reads the accessibility hierarchy first, sends
one allowlisted Android input action, and reads the hierarchy again.

## Inspect before acting

```bash
adb-ready inspect ui --interactive-only
adb-ready inspect ui --interactive-only --json --non-interactive
```

Each node has a reference such as `ui:7c4a31b8d2ef:14`. The middle value is a
prefix of the current hierarchy digest. A reference is accepted only while the
device still returns that same UI digest; after any screen change, inspect
again. Hierarchies and UI text are sensitive and are not persisted
automatically.

## Tap and long-press

Prefer a current reference because it ties the action to observed UI state:

```bash
adb-ready ui tap ui:7c4a31b8d2ef:14
adb-ready ui long-press ui:7c4a31b8d2ef:21
```

Explicit coordinates are available when the accessibility tree has no usable
node. They must be integers inside the current display:

```bash
adb-ready ui tap 540 1200
adb-ready ui long-press 540 1200
```

ADB Ready rejects stale, disabled, non-actionable, missing-bounds, and
out-of-display targets before input is sent.

## Swipe, type, and keys

```bash
adb-ready ui swipe up
adb-ready ui swipe 900 1200 180 1200
adb-ready ui type "person@example.com" --submit
adb-ready ui press back
```

Direction swipes use screen-relative points, so they work across display
sizes. Supported keys are `back`, `home`, `enter`, `menu`, `volume-up`, and
`volume-down`.

Android's text-input command passes through a device shell. ADB Ready therefore
accepts only 1–256 ASCII letters, numbers, spaces, and `._@+,:/-`. Unsupported
characters are rejected instead of being reinterpreted by a shell.

## Wait for a postcondition

Waits use exact, explicit selectors:

```bash
adb-ready ui wait 'id=com.example:id/submit' --state visible --timeout 5s
adb-ready ui wait 'text=Loading' --state gone --timeout 10s
adb-ready ui wait 'desc=Open settings'
adb-ready ui wait 'package=com.example.app'
```

Selector prefixes are `id=`, `text=`, `desc=`, and `package=`. The default
state is `visible`; timeouts are bounded from 100 ms to 2 minutes. Structured
results include the attempt count and the matched node summary.

## Verification contract

```bash
adb-ready ui tap ui:7c4a31b8d2ef:14 --dry-run --json
adb-ready ui press back --json --non-interactive
```

- `ok: true` means Android accepted the allowlisted input operation.
- `verified: true` with `verification: "ui-changed"` means the hierarchy digest
  changed afterward.
- `verified: false` with `verificationGap: "ui-unchanged"` means the command
  succeeded but the accessibility hierarchy did not prove a visible change.
- A successful `ui wait` is independently verified by its selector
  postcondition.
- `--dry-run` returns the exact ADB plan without sending input.

An unchanged hierarchy is not treated as a false failure: volume changes,
cursor movement, and actions outside UI Automator can succeed without changing
the tree. Automation should use `ui wait` for the expected postcondition when
the next state is known.

## AI agents

The MCP server exposes `tap_ui`, `long_press_ui`, `swipe_ui`, `type_text_ui`,
`press_key_ui`, and `wait_for_ui`. Arguments are schema-validated, each MCP
connection stays bound to one target, and no raw ADB or shell tool is exposed.

[Connect an agent →](./agent-integration.md)
