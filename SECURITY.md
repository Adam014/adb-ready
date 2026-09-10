# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| `0.1.x` | Yes |
| `< 0.1.0` | No |

Security fixes target the latest published minor release. Because ADB Ready is
still below `1.0.0`, minor releases may include documented breaking changes.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability or include secrets,
pairing codes, device identifiers, private logs, or unpublished exploit details
in a public discussion.

Use [GitHub private vulnerability reporting](https://github.com/Adam014/adb-ready/security/advisories/new)
to share:

- the affected ADB Ready version and host environment;
- a minimal reproduction or proof of concept;
- the expected and observed behavior;
- the potential impact; and
- any known workaround.

Reports are handled privately until a fix and disclosure plan are ready. ADB
Ready does not operate a bug-bounty program at this stage.

## Scope

Security-sensitive areas include command execution, argument handling, target
selection, file permissions, redaction, session persistence, configuration,
archive contents, and release provenance. Vulnerabilities in Android
Platform-Tools or a third-party runtime should also be reported to the relevant
upstream project.

## Local agent and MCP trust model

`adb-ready mcp` is a local stdio server. It does not bind a network port, make
itself remotely discoverable, or upload device data. The configured AI client
starts the process and decides which returned data is sent to its model
provider.

The MCP surface is intentionally narrower than the CLI:

- it exposes schema-validated Android workflows, not a generic shell or raw ADB;
- one verified target is bound per connection and cannot be switched silently;
- APK paths must resolve to existing project-local files;
- UI hierarchy, logs, identifiers, and screenshots are treated as sensitive;
- mutating UI tools accept only typed actions; digest-scoped references are
  checked against fresh UI evidence, coordinates are display-bounded, and text
  uses a conservative shell-safe allowlist;
- capture is explicit and never implied by an inspection call; and
- data clearing and app uninstall are not available as MCP tools.

MCP annotations are hints for the client approval interface, not a security
boundary. ADB Ready enforces target selection, path containment, bounded output,
and destructive-action policy inside the server. Users should still review the
MCP configuration, pin the npm dependency, and keep mutating tools behind their
client's approval or sandbox policy.

ADB itself can access USB devices, emulators, or configured network/remote ADB
servers. That existing ADB authority remains the outer device-access boundary;
the MCP server does not expand it.

See the public [threat model](./docs/threat-model.md) for trust boundaries,
protected assets, implemented controls, and residual risks.
