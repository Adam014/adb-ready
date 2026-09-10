# Security Policy

## Supported versions

ADB Ready has not published its first supported public release yet. Once
`0.1.0` is available, security fixes will target the latest published minor
release. Preview versions may change without compatibility guarantees.

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
