# Targets and Wireless debugging

ADB Ready models USB devices, emulators, TCP transports, and TLS Wireless
debugging transports behind one deterministic selection contract.

## Inspect visible targets

```bash
adb-ready devices
adb-ready devices --json
adb-ready devices --select
```

Target information can include model, ADB state, transport kind, transport ID,
network endpoint, and stable identity evidence. Transient mDNS service names and
unspecified `0.0.0.0` endpoints are never accepted as final serials.

## Explicit selection

```bash
adb-ready devices --device R5CT123456A
adb-ready devices --device phone
adb-ready devices --transport-id 7
adb-ready devices --last
```

`--device` accepts an exact ADB serial or a configured alias. `--transport-id`
disambiguates duplicate transports. `--last` resolves the last verified target
identity; it does not silently choose an unrelated visible device.

All target-aware commands accept the same selectors.

## Pair Android 11 and newer

On the device:

1. open **Developer options → Wireless debugging**;
2. choose **Pair device with pairing code**; and
3. keep that screen open while pairing.

Use the pairing address and pairing port shown by Android:

```bash
adb-ready pair 192.168.1.42:41235
```

ADB Ready reads the six-digit code from a hidden prompt. It rejects pairing
codes on argv because shell history and process inspection can expose them.

For automation, pipe the code through standard input:

```bash
printf '%s\n' "$ANDROID_PAIRING_CODE" \
  | adb-ready pair 192.168.1.42:41235 --pairing-code-stdin --non-interactive
```

## Connect after pairing

Return to the main Wireless debugging screen and use its connection address and
port, which are normally different from the pairing endpoint:

```bash
adb-ready connect 192.168.1.42:37123
```

When no endpoint is supplied, ADB Ready uses ADB mDNS discovery only if exactly
one valid connect service is available:

```bash
adb-ready connect
```

Connection is successful only after ADB reports a stable serial in `device`
state. Use `--dry-run` to inspect the planned candidates without connecting.

## Remote ADB server

Point any target-aware command at an explicit server:

```bash
adb-ready devices --adb-host 127.0.0.1 --adb-port 5037
adb-ready dev --adb-host host.docker.internal --adb-port 5037
```

This is useful for WSL, containers, VMs, SSH-forwarded workstations, and device
labs. ADB Ready does not start, kill, or reconfigure that shared server
implicitly.

## Network limitations

Wireless discovery and connection can be blocked by guest Wi-Fi, client
isolation, corporate policy, VPN routes, host firewalls, containers, or virtual
machines. Pairing success does not prove that the later connection endpoint is
routable.

Start with:

```bash
adb-ready doctor --verbose
adb-ready devices
```

If discovery is unavailable but the device shows a reachable connection
endpoint, pass it explicitly. Do not assume port `5555`; modern Wireless
debugging ports are dynamic.
