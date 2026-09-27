# Self-hosted physical Android target

This recipe runs one finite ADB Ready verification against one physical Android
target attached to a self-hosted GitHub Actions runner. It is intentionally a
manual workflow: never let untrusted pull-request code execute on a machine
that can control a real device.

## Runner contract

1. Register a dedicated self-hosted runner and add the custom
   `android-device` label.
2. Install a current Android SDK Platform-Tools release and make `adb`
   available to the runner account.
3. Enable USB debugging, connect the target, unlock it, and approve that
   runner's RSA key before unattended work begins.
4. Set the repository variable `ADB_READY_DEVICE_SERIAL` to the exact serial
   shown by `adb devices -l`.
5. Copy [`github-actions.yml`](./github-actions.yml) into your repository's
   `.github/workflows/` directory and adapt the project command, readiness, and
   verifier to your application.

The example uses a static GitHub concurrency group with cancellation disabled,
so jobs queue instead of interrupting a device already in use. ADB Ready then
acquires its host-local target lease before any mutation. Another ADB Ready
process on the same runner receives `TARGET_BUSY`; it cannot share the phone.
The operator-provided runner label and serial are the physical-device contract;
the verifier does not guess form factor from undocumented Android properties.

## Failure and recovery

- A missing serial or detached phone fails before a verifier starts.
- `unauthorized` asks the operator to unlock the device and approve the RSA
  prompt; ADB Ready does not bypass Android authorization.
- `offline` remains distinct from an absent device and is reported with an
  actionable target diagnostic.
- A normal exit, verifier failure, timeout, or cancellation releases only the
  current ADB Ready lease and resources created by that run.
- If the runner process disappears, a later process on the same host can
  recover its dead-owner lease. After a host crash, the bounded lease TTL makes
  stale ownership recoverable.

The recipe never calls `adb kill-server`, reconnects unrelated transports,
unlocks the phone, clears app data, or resets the device. Its verifier is
read-only and deliberately avoids screenshots because a personal device screen
can contain sensitive information. Project-specific test artifacts remain
local sensitive evidence and are uploaded for seven days by the example.

GitHub concurrency protects this one workflow. The ADB Ready lease protects
processes sharing one host. Neither is a distributed lock across multiple
runner machines; use one physical target per runner label until an explicit
shared coordination backend is configured.
