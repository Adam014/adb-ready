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

For a unique stable label or resource ID, act directly by intent:

```bash
adb-ready ui tap 'text=Continue'
adb-ready ui long-press 'id=com.example:id/item'
```

ADB Ready resolves a fresh hierarchy and refuses to guess when a selector has
zero or multiple matches. Prefer a current reference when the exact observed
snapshot matters:

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

## Read and fill a specific field

Agents do not need to infer state from a large hierarchy or depend on whatever
field happens to be focused:

```bash
adb-ready ui get 'id=com.example:id/email' --json
adb-ready ui fill 'id=com.example:id/email' 'person@example.com'
adb-ready ui fill 'id=com.example:id/search' 'pixel' --submit
adb-ready ui clear 'id=com.example:id/search'
```

`get` requires one unambiguous match and returns its semantic values, state,
and bounds. `fill` and `clear` focus that exact enabled field, select its
existing value, replace it, then inspect the hierarchy again. A visible normal
field is successful only when its post-action value matches. Password and
custom fields can accept input without exposing their value; those calls stay
successful but report `verified: false` and `text-not-observable`, so the next
screen state should be asserted explicitly.

Safe replacement requires the target's Android `input keycombination`
capability. ADB Ready checks it before touching the screen and returns a
structured unsupported-capability problem on older targets rather than
appending to an unknown value.

## Scroll, swipe, type, and keys

```bash
adb-ready ui swipe up
adb-ready ui swipe 900 1200 180 1200
adb-ready ui scroll up 'id=com.example:id/results'
adb-ready ui type "person@example.com" --submit
adb-ready ui press back
```

Direction swipes use screen-relative points, so they work across display
sizes. `scroll` can constrain that gesture to one enabled accessibility node
whose `scrollable` property is true; without a selector it uses the screen.
Supported keys are `back`, `home`, `enter`, `menu`, `volume-up`, and
`volume-down`.

Android's text-input command passes through a device shell. ADB Ready therefore
accepts only 1–256 ASCII letters, numbers, spaces, and `._@+,:/-`. Unsupported
characters are rejected instead of being reinterpreted by a shell.

## Find, assert, compare, and wait

Query or assert the current hierarchy without changing it:

```bash
adb-ready ui find 'class=android.widget.Button' --json
adb-ready ui assert 'text=Signed in'
adb-ready ui assert 'text=Loading' --state gone
adb-ready ui compare 7c4a31b8d2ef0000000000000000000000000000000000000000000000000000
```

`compare` consumes the complete digest returned by inspection or another UI
action and reports whether the current hierarchy changed.

Waits use exact, explicit selectors:

```bash
adb-ready ui wait 'id=com.example:id/submit' --state visible --timeout 5s
adb-ready ui wait 'text=Loading' --state gone --timeout 10s
adb-ready ui wait 'desc=Open settings'
adb-ready ui wait 'package=com.example.app'
```

Compact selector prefixes are `id=`, `text=`, `desc=`, `class=`, and
`package=`. The default
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

The MCP server exposes the same intent-level workflow through `get_ui`,
`find_ui`, `fill_ui`, `clear_ui`, `scroll_ui`, `assert_ui`, and `compare_ui`.
Its structured selectors can match exact values, prefixes, or substrings and
qualify enabled/actionable state. An optional one-based occurrence is accepted
only when repeated nodes are intentional. Arguments are schema-validated, each
MCP connection stays bound to one target, and no raw ADB or shell tool is
exposed.

[Connect an agent →](./agent-integration.md)
