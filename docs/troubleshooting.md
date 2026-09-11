# Troubleshooting

Start with the structured diagnosis:

```bash
adb-ready doctor --verbose
adb-ready devices
```

After a development-session failure:

```bash
adb-ready problems
adb-ready context --since 5m --only problems,recovery,logs
```

## Problem index

| Code | Meaning | First action |
| --- | --- | --- |
| `ADB_NOT_FOUND` | No usable ADB executable was resolved | Install Platform-Tools or pass `--adb PATH` |
| `ADB_SERVER_UNAVAILABLE` | The selected local or remote server could not be queried | Check the configured host/port and run `adb start-server` explicitly if appropriate |
| `ADB_VERSION_MISMATCH` | Client and server report incompatible versions | Align Platform-Tools versions; review before restarting the shared server |
| `TARGET_UNAUTHORIZED` | Android has not authorized this host | Unlock the device and accept its RSA debugging prompt |
| `TARGET_NO_PERMISSIONS` | The host cannot access the USB device | Fix host USB permissions or rules, then reconnect |
| `TARGET_OFFLINE` | ADB knows the transport but it is not ready | Check cable/network state and retry `devices` |
| `MULTIPLE_TARGETS` | More than one ready target is eligible | Use `--select`, `--device`, or `--transport-id` |
| `DUPLICATE_TARGET_TRANSPORT` | One serial maps to multiple ADB transports | Select an exact transport ID |
| `WIRELESS_PAIRING_REQUIRED` | The host is not paired with the target | Run `adb-ready pair` using Android's pairing endpoint |
| `WIRELESS_ENDPOINT_NOT_FOUND` | No safe connect service is discoverable | Pass the current connection endpoint explicitly |
| `MULTIPLE_WIRELESS_ENDPOINTS` | Discovery returned ambiguous services | Pass one exact `HOST:PORT` |
| `PORT_MAPPING_CONFLICT` | Another mapping owns the requested listen port | Inspect `ports ... list`; remove or change it explicitly |
| `LOG_PACKAGE_NOT_RUNNING` | Package filtering could not resolve a live process | Launch the app or use another package/PID |
| `UI_NOT_IDLE` | Android UI Automator could not observe a quiet accessibility window | Pause continuous UI changes or navigate to a stable screen, then retry |
| `SESSION_RECOVERY_FAILED` | The bounded target/port recovery budget was exhausted | Inspect `problems`, network state, and saved recovery events |
| `SESSION_PERSISTENCE_FAILED` | The private session record could not be written | Check user-state directory permissions and capacity |
| `CHILD_PROCESS_FAILED` | The project command exited unsuccessfully | Inspect child output, targeted logs, and preserved exit code |

## ADB is installed but not found

Pass the executable explicitly to confirm the diagnosis:

```bash
adb-ready doctor --adb /absolute/path/to/adb
```

If that works, add the Platform-Tools directory to `PATH` or set `adb.path` in
the user/project configuration. ADB Ready does not download Platform-Tools.

## More than one device is connected

ADB Ready refuses to guess between equally eligible targets:

```bash
adb-ready devices --select
adb-ready dev --device R5CT123456A
adb-ready dev --transport-id 7
```

For a team-friendly selector, configure a local alias. Do not commit a personal
hardware serial to a public repository.

## Wireless pairing succeeds but connect fails

Pairing and connection have different dynamic ports. Return to Android's main
Wireless debugging screen and copy its current connection address rather than
reusing the pairing port.

Also check:

- both hosts are on a routable network;
- guest/client isolation is disabled;
- a VPN is not replacing the relevant route;
- the host firewall permits the connection; and
- a container or VM can reach the LAN and the configured ADB server.

Then retry with the explicit endpoint:

```bash
adb-ready connect HOST:CURRENT_CONNECTION_PORT
```

## A reverse port conflicts

Inspect the selected target before changing anything:

```bash
adb-ready ports reverse list --device SERIAL
```

ADB Ready will reuse an exact mapping, but it will not overwrite a different
host destination. Remove the old mapping only when you know which tool owns it,
or choose a different device port.

## A session will not recover

Recovery is intentionally bounded and identity-safe. It will not connect an
ambiguous device, replace an external port mapping, restart the shared ADB
server, or keep retrying indefinitely.

```bash
adb-ready problems
adb-ready sessions events --format ndjson
adb-ready context --only problems,recovery,target,ports
```

Resolve the user-action problem, then start a new session. Increase the recovery
budget only when the environment is known to need more time; do not use an
unbounded timeout.

## Report a reproducible issue

For ordinary bugs, open a GitHub issue with the ADB Ready version, host/runtime,
Platform-Tools version, exact command shape, and a minimal reproduction. Review
and attach a redacted `adb-ready context` only when it contains no private
application data.

Report security issues through the private process in
[SECURITY.md](../SECURITY.md), never a public issue.
