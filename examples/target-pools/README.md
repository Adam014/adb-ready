# Explicit target-pool example

Replace the serial and AVD name with resources owned by this host, then copy
the configuration to the project root.

Validate and preview before allocating either target:

```bash
adb-ready config validate
adb-ready run --pool smoke --dry-run --json -- npm run test:e2e
```

Run the bounded verifier on both members:

```bash
adb-ready run --pool smoke -- npm run test:e2e
```

The AVD must already exist. The built-in lease backend coordinates only
processes sharing this host and user state directory. See
[Target pools and fan-out](../../docs/target-pools.md) before adapting this for
multiple CI runners or a remote ADB server.
