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

UI hierarchy capture has a 15-second default because Android's platform
UI Automator waits for a quiet accessibility window before returning data.
`UI_NOT_IDLE` means continuous animation or accessibility events prevented that
quiet window; pause the changing UI or navigate to a stable screen and retry.
ADB Ready does not silently disable device-wide animations.

Android permits only one active UI Automation service on a target. ADB Ready
therefore serializes the short hierarchy-capture step per target, including
across separate CLI and MCP processes. Independent targets still run in
parallel, and selector processing or input does not hold the capture lock. If
another process does not finish within the configured UI timeout, the command
returns `UI_HIERARCHY_BUSY` instead of misreporting an inaccessible screen.

Choose an acquisition profile when the default one-shot observation is not the
right tradeoff:

```bash
adb-ready inspect ui --acquisition balanced
adb-ready inspect ui --acquisition fast --interactive-only
adb-ready inspect ui --acquisition strict
```

- `balanced` takes one fresh platform-idle snapshot within the normal bounded
  UI timeout and is the default.
- `fast` keeps the same safe target-scoped platform backend but limits the
  attempt to three seconds. It reports a timeout or non-idle screen instead of
  pretending that an empty result is a valid screen.
- `strict` requires two consecutive matching hierarchy digests within at most
  three captures. A continuously changing screen returns
  `UI_HIERARCHY_UNSTABLE`.

Every successful structured snapshot reports its observation time, duration,
attempt count, stability status, source and idle strategy, requested filters,
node limits, truncation, observed display bounds and rotation, and detected
semantic limitations. An empty hierarchy is an explicit `UI_HIERARCHY_EMPTY`
failure. WebView, Compose, and Flutter
markers are reported only when their corresponding platform view is actually
observed; they describe framework accessibility boundaries rather than guessing
why an otherwise unreadable window failed.

## Audit one screen for people and agents

```bash
adb-ready ui audit --json --non-interactive
```

The audit reports enabled controls that have no effective human-readable label,
and controls that have no resource ID for a stable selector. Effective labels
include text, hints, and content descriptions on the control, its descendants,
or an actionable ancestor. Structural focus and scrolling containers are not
misreported as controls merely because they are focusable or scrollable.

Every finding includes its rule rationale and confidence. A partial hierarchy
reduces the confidence of missing-label findings instead of presenting
incomplete evidence as definitive. The audit returns exact current references,
attributes, and bounded totals; it deliberately does not invent a subjective
quality score. A missing label is an accessibility warning. A missing stable ID
is an automation advisory; effective text and content-description labels remain
usable, while a resource ID or Compose test tag exposed through
`testTagsAsResourceId` is more resilient to copy changes.

## Tap and long-press

For a unique stable label or resource ID, act directly by intent:

```bash
adb-ready ui tap 'text=Continue'
adb-ready ui long-press 'id=com.example:id/item'
```

ADB Ready resolves a fresh hierarchy and refuses to guess when a selector has
zero or multiple matches. When unique text or a content description belongs to
a non-clickable label inside an enabled clickable row, ADB Ready taps the
nearest actionable ancestor. Structured results report both the label that
matched and the action node that received the tap. Prefer a current reference
when the exact observed snapshot matters:

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
adb-ready ui fill 'id=com.example:id/name' 'Příliš žluťoučký 🦊' --input-mode unicode
adb-ready ui clear 'id=com.example:id/search'
```

`get` requires one unambiguous match and returns its semantic values, state,
and bounds. `fill` and `clear` focus that exact enabled field, select its
existing value, replace it, then inspect the hierarchy again. A visible normal
field is successful only when its post-action value matches. Android may expose
an empty field's hint as accessibility text; ADB Ready reads the separate
platform `hint` attribute so a declared placeholder is not mistaken for a
remaining value. Password and custom fields can accept input without exposing
their value; those calls stay successful but report `verified: false` and
`text-not-observable`, so the next screen state should be asserted explicitly.

Safe replacement requires the target's Android `input keycombination`
capability. ADB Ready checks it before touching the screen and returns a
structured unsupported-capability problem on older targets rather than
appending to an unknown value.

## Scroll, swipe, type, and keys

```bash
adb-ready ui swipe up
adb-ready ui swipe 900 1200 180 1200
adb-ready ui scroll down 'id=com.example:id/results'
adb-ready ui type "person@example.com" --submit
adb-ready ui press back
```

Direction swipes describe the physical finger gesture and use screen-relative
points, so they work across display sizes. `scroll` describes content/viewport
navigation instead: `scroll down` reveals content below by sending an upward
finger gesture. It can constrain that navigation to one enabled accessibility
node whose `scrollable` property is true; without a selector it uses the screen.
Supported keys are `back`, `home`, `enter`, `menu`, `volume-up`, and
`volume-down`.

Text input is bounded to 1–256 Unicode code points and 4096 UTF-8 bytes. The
default `--input-mode auto` uses Android's built-in `input text` only for the
conservative ASCII set of letters, numbers, spaces, and `._@+,:/-`. Use
`--input-mode ascii` to require that path explicitly.

Unicode, emoji, RTL, CJK, and multiline input use the open-source
[ADBKeyBoard](https://github.com/senzhk/ADBKeyBoard) broadcast contract because
Android's built-in input command does not reliably represent those values. The
IME must already be installed and enabled on the selected target. ADB Ready
checks that contract before touching the screen, temporarily selects the IME,
and restores the exact previous IME in a `finally` path. It never downloads,
installs, enables, or leaves a keyboard selected silently. If the helper or a
restorable current IME is unavailable, the action fails before typing.

Some apps drop text delivered too quickly. Pace either backend by Unicode code
point with a whole-millisecond delay from 0 to 2000:

```bash
adb-ready ui type 'مرحبا بالعالم' --input-mode unicode --typing-delay 40
```

### Protected input

Do not put passwords or tokens in a command argument. Pipe one value to stdin:

```bash
printf '%s' "$TEST_PASSWORD" |
  adb-ready ui fill 'id=com.example:id/password' --secret-stdin --submit
```

`--secret-stdin` reads at most 4096 bytes to EOF, removes one final line ending,
and preserves embedded newlines. Plaintext is excluded from host process
arguments, operation plans, terminal output, structured results, event
journals, screenshots created by this action, and AI context. The value exists
only in process memory and the pipe used to deliver it to the selected target.
For Unicode, the on-device shell receives base64 rather than plaintext.

This is a bounded host-side guarantee, not a secure-input claim about Android
or the app: the selected IME and target receive the value, a normal visible
field may display it, and device/OEM auditing can observe shell activity. Use a
password field and assert a non-secret postcondition. A protected field cannot
expose its value for exact verification, so ADB Ready returns
`text-not-observable` rather than inventing success.

## Keyboard and runtime-permission dialogs

Inspect or dismiss the software keyboard without sending a blind Back action:

```bash
adb-ready ui keyboard status --json
adb-ready ui keyboard dismiss
```

ADB Ready requires Android's InputMethodManager `mInputShown` state and its
WindowInsets `type=ime` visibility to both exist and agree. `dismiss` sends Back
only after both report visible, then reads both services again and succeeds only
after both report hidden. An already hidden keyboard is a verified no-op.
Missing or conflicting signals return `UI_KEYBOARD_STATE_UNSUPPORTED` or
`UI_KEYBOARD_STATE_AMBIGUOUS`; ADB Ready does not guess from inset height or
press Back against an unknown screen.

Inspect one standard Android runtime-permission prompt before choosing an exact
decision:

```bash
adb-ready ui permission inspect --json
adb-ready ui permission respond allow-while-using
adb-ready ui permission respond allow-once --dry-run --json
adb-ready ui permission respond deny
```

Inspection returns only the decisions actually present on the current dialog.
Responses match PermissionController package and resource IDs, never translated
button labels or coordinates copied from another device. A fresh hierarchy must
show that the specific prompt changed or disappeared after the tap. Multiple,
unknown, or OEM-specific states fail closed. Notification permission setup,
biometric prompts, Settings mutation, and generic system-dialog acceptance are
intentionally outside this workflow.

## Find, assert, compare, and wait

Query or assert the current hierarchy without changing it:

```bash
adb-ready ui find 'class=android.widget.Button' --json
adb-ready ui assert 'text=Signed in'
adb-ready ui assert 'text=Loading' --state gone
adb-ready ui compare 7c4a31b8d2ef0000000000000000000000000000000000000000000000000000
```

The CLI `compare` command consumes the complete digest returned by inspection
or another UI action and reports whether the current hierarchy changed. It
does not persist the earlier sensitive hierarchy.

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
- `before.acquisitionDurationMs` and `after.acquisitionDurationMs` expose the
  measured cost of each UI Automator snapshot instead of hiding slow devices.
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

The MCP server exposes the same intent-level workflow through `audit_ui`, `get_ui`,
`find_ui`, `fill_ui`, `clear_ui`, `scroll_ui`, `assert_ui`, `compare_ui`,
`inspect_keyboard`, `dismiss_keyboard`, `inspect_permission_dialog`, and
`respond_to_permission_dialog`.
Its structured selectors can match exact values, prefixes, or substrings and
qualify enabled/actionable state. An optional one-based occurrence is accepted
only when repeated nodes are intentional. Arguments are schema-validated, each
MCP connection stays bound to one target, and no raw ADB or shell tool is
exposed.

`type_text_ui` and `fill_ui` accept `inputMode` and `typingDelayMs`. For a
secret, set `secretEnv` to the *name* of an environment variable already passed
to the local MCP server and omit `text`. ADB Ready reads the value locally; the
MCP request, tool result, and retained agent conversation contain only the
variable name. Supplying both fields, neither field, or a missing/empty variable
fails before device mutation.

`inspect_ui` retains at most eight sensitive snapshots in memory for that MCP
connection only. `compare_ui` accepts one of those complete digests and returns
a bounded semantic diff: added, removed, updated, and moved nodes with current
selector context. `changed` describes the requested filtered view, while
`digestChanged` also reveals changes outside that view. Unchanged screens return
empty change lists. Bases expire
after five minutes and are never written to disk; missing or expired digests
require a fresh `inspect_ui`. A diff is rejected rather than guessed when its
target, display bounds or rotation, hierarchy filters, acquisition contract, or
completeness differs from the base.

[Connect an agent →](./agent-integration.md)
