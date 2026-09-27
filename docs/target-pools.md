# Target pools and fan-out

Use a target pool when the same bounded verification must run against an
explicit set of Android targets. Pool mode is opt-in. A normal `adb-ready run`
still selects exactly one target.

Every acquired member receives its own single-target session, target lease,
verifier result, cleanup, and evidence bundle. The pool result aggregates those
unchanged member envelopes in declaration order.

## Declare a local pool

```json
{
  "$schema": "./node_modules/adb-ready/schema/config-v1.schema.json",
  "version": 1,
  "targets": {
    "pools": {
      "smoke": {
        "maxConcurrency": 2,
        "failFast": false,
        "leaseWaitMs": 30000,
        "members": [
          { "id": "desk", "kind": "adb", "serial": "R3CT..." },
          { "id": "api36", "kind": "avd", "name": "Pixel_9_API_36" },
          {
            "id": "lab",
            "kind": "remote-adb",
            "host": "android-lab.internal",
            "port": 5037,
            "serial": "10.20.0.15:5555"
          }
        ]
      }
    }
  }
}
```

Run the same verifier on every member:

```bash
adb-ready run --pool smoke -- npm run test:e2e
```

Preview every member without inspecting ADB, starting an AVD, or running the
verifier:

```bash
adb-ready run --pool smoke --dry-run --json -- npm run test:e2e
```

The pool owns concurrency policy; it never infers an unbounded worker count.
Override it for one invocation only when the CI runner has known capacity:

```bash
adb-ready run --pool smoke --max-concurrency 1 --fail-fast \
  --lease-wait 45s -- npm run test:e2e
```

## Member kinds

| Kind | Required fields | Ownership |
| --- | --- | --- |
| `adb` | `id`, exact `serial` | Uses an already ADB-visible target. |
| `avd` | `id`, exact existing AVD `name` | Reuses or starts that AVD; stops only an emulator process started by this run. |
| `remote-adb` | `id`, `host`, exact `serial`; optional `port` | Uses the explicit ADB server without changing the global local server. |
| `firebase` | `id`, `model`, `version`; optional `locale`, `orientation` | Firebase owns the remote target and lifecycle. Use only with `test firebase`. |

Member IDs and resource identities must be unique inside a pool. Members are
required by default. Set `"required": false` only when that dimension is truly
informational; an optional failure remains visible but does not fail the
aggregate.

## Firebase dimensions

A Firebase-only pool submits one independently observable matrix per declared
dimension. This gives every dimension a stable member result and lets ADB Ready
bound submission concurrency.

```json
{
  "version": 1,
  "targets": {
    "pools": {
      "firebase-smoke": {
        "maxConcurrency": 2,
        "failFast": true,
        "members": [
          { "id": "pixel-api35", "kind": "firebase", "model": "akita", "version": "35" },
          { "id": "tablet-api34", "kind": "firebase", "model": "tangorpro", "version": "34" }
        ]
      }
    }
  }
}
```

```bash
adb-ready test firebase instrumentation \
  --pool firebase-smoke \
  --project my-project \
  --app app-debug.apk \
  --test-apk app-debug-androidTest.apk
```

Dimensions are checked against the live Firebase catalog before upload. With
`failFast`, ADB Ready stops submitting queued dimensions after a required
failure. It does not cancel matrices already running remotely. Use
`adb-ready test firebase cancel` for an intentional provider cancellation.

## Queueing and leases

ADB Ready serializes contending work with an owner-recorded, heartbeating lease.
`leaseWaitMs` bounds how long a pool member waits; cancellation exits the queue
without taking ownership. Expired leases and leases owned by a dead process on
the same host are recovered conservatively.

The built-in coordination backend is a per-user filesystem on one host. It is
not a distributed lock. CI jobs on different machines need runner-level
routing or another explicit external coordination system. ADB Ready never
infers cross-host ownership.

An explicit remote ADB server is also a trust boundary: its socket is not
encrypted by ADB Ready. Protect it with a trusted private network, VPN, SSH
tunnel, or equivalent transport; never expose port 5037 to an untrusted
network.

## Aggregate result

Human output shows the status of every member. JSON and NDJSON preserve every
nested result envelope, including its command ID, structured problems,
timestamps, and evidence path. The aggregate cannot report success when any
required member failed, disappeared, was cancelled, or never started.

Useful automation fields:

```text
data.pool
data.maxConcurrency
data.failFast
data.coordination
data.members[].id
data.members[].status
data.members[].exitCode
data.members[].result
data.summary
```

Pool configuration is declarative data. It cannot add executable hooks or
shell fragments, and every verifier continues to use direct argv execution.
