# Threat model

ADB Ready runs locally with the same Android access as the selected ADB server.
Its security goal is to make that authority explicit, narrow, target-bound, and
observable; it cannot sandbox ADB, the Android device, a project command, or an
AI client that already has broader host access.

## Trust boundaries

| Boundary | ADB Ready assumes | ADB Ready enforces |
| --- | --- | --- |
| CLI caller | arguments may be malformed or automated | strict parsing, no implicit shell, bounded values, explicit destructive approval |
| ADB server and device | may be remote, stale, unavailable, or return hostile text | exact target selection, postcondition checks, output bounds, terminal sanitization |
| Project filesystem | may contain symlinks, existing files, or untrusted config | root containment, schema validation, atomic writes, no overwrite by default |
| Session storage | contains sensitive diagnostics | per-user location, bounded retention, redaction, restrictive file modes |
| MCP client | chooses what reaches a model provider | local stdio only, typed tools, one bound target, no generic shell/raw ADB |
| npm and CI | dependencies and release credentials can be attacked | pinned lockfile, package allowlist, short-lived OIDC publishing, provenance |

## Protected assets

- pairing codes, environment secrets, logs, screenshots, and UI text;
- the identity and state of the intended Android target and app;
- project files and existing ADB port mappings;
- the integrity of the published npm package and its command/tool contracts.

## Main threats and controls

### Command and input injection

Child commands use an executable plus argument array without an implicit shell.
MCP exposes allowlisted workflows rather than command execution. Android text
input accepts only a conservative character set; key actions map to numeric
allowlisted keycodes.

### Wrong-target mutation

Every target-aware operation uses an exact ADB serial or transport ID. Ambiguous
selection fails. An MCP connection binds one target and refuses a silent
switch. UI references include the current hierarchy digest and are revalidated
immediately before mutation.

### Unsafe file mutation

Capture and setup paths are constrained to the project, checked for unsafe
symlinks, written atomically, and not replaced without an explicit policy. MCP
APK installation accepts only an existing project-local file.

### Secret or terminal escape disclosure

Human output is terminal-sanitized. Stored diagnostic events are bounded and
redacted. Pairing codes use protected input or stdin and never enter process
arguments. Screenshots and UI hierarchies require explicit calls and never join
AI context automatically.

### Unbounded or misleading automation

Process output, recordings, UI trees, session storage, context, retries, and
waits are bounded. Results distinguish process acceptance (`ok`) from observed
postconditions (`verified`). An unchanged UI is reported as a verification gap,
not silently upgraded to verified success.

### Network exposure

The 0.2 MCP server uses stdio and opens no listener. ADB itself may connect to a
local or remote server selected by the user; that existing authority is outside
ADB Ready's isolation boundary.

## Intentionally absent

- arbitrary shell or raw ADB MCP tools;
- automatic downloads, mutable `latest` execution, or implicit tool installs;
- MCP data clearing and uninstall operations;
- autonomous destructive recovery;
- automatic screenshot or UI-text upload.

## Residual risk

A trusted ADB server can control connected Android targets, and an approved AI
client may transmit tool results under its own provider policy. Accessibility
hierarchies can expose on-screen personal data. Project commands and installed
APKs execute with their normal platform authority. Users must review targets,
MCP approvals, artifacts, and captured evidence accordingly.

Report a vulnerability through the private channel in the
[Security Policy](../SECURITY.md).
