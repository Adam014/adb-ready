# Stability and versioning

ADB Ready follows Semantic Versioning for the npm package and versions its
machine contracts independently. Version `1.0.0` starts the compatibility
policy below; pre-1.0 releases remain governed by their changelog.

## Stable in 1.x

Within the `1.x` package line, ADB Ready will not remove or rename a documented
CLI command, option, configuration field, exit-code category, result-envelope
field, event-envelope field, MCP tool, or MCP resource without a new major
version. Existing documented meanings will not be silently reassigned.

Backward-compatible additions may ship in a minor release. These include new
commands, options, event types, problem codes, optional object fields, enum
values, MCP tools, and target capabilities. Automation must ignore unknown
additive fields and handle unknown event or problem types conservatively.

Human terminal layout, animation, color, progress wording, and diagnostic prose
are presentation rather than an automation API. Do not parse them. Use JSON,
NDJSON, the packaged schemas, or MCP instead.

## Versioned contracts

The npm package contains three contract artifacts:

- `schema/config-v1.schema.json` — declarative project configuration;
- `schema/automation-v1.schema.json` — common JSON result and NDJSON event
  envelopes; and
- `schema/agent-tools-v1.json` — the exact MCP tool input/output surface for
  the installed package version.

`schemaVersion` identifies an envelope or configuration shape; it is not the
npm package version. Additive changes retain the same schema version. An
incompatible machine-shape change requires a new schema version and a new npm
major release. ADB Ready 1.x continues to accept configuration schema v1.

The generated agent contract records `packageVersion`. Clients should load the
artifact from the same installed package that starts the MCP server instead of
combining contracts from different releases.

## Exit behavior

The category exit codes documented in [Automation](./automation.md#exit-codes)
are stable in 1.x. A bounded `dev` or `run` child may preserve its own non-zero
exit code, so callers must not assume every non-zero value belongs to the ADB
Ready category table. Read the structured `problems` array for classification.

## Deprecation and migration

A deprecated capability remains functional throughout the current major line
unless retaining it would create a security or data-integrity risk. ADB Ready
will mark the replacement in CLI help, public documentation, and the changelog
before removal. Removal or an incompatible semantic change waits for the next
major release and receives a migration section.

Security fixes, upstream Android/ADB behavior, and hosted-provider changes can
make an operation unavailable without changing its public shape. Such cases
must fail explicitly with structured evidence; ADB Ready does not fabricate a
successful result to preserve compatibility.

## Support claims

API stability does not turn every upstream-capable environment into a tested
environment. [Compatibility](../COMPATIBILITY.md) distinguishes CI-tested,
hardware-observed, and upstream-capable tiers. A new host, runtime, transport,
or Android form factor is promoted only after its stated acceptance evidence
exists.
