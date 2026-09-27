# Firebase Test Lab

Use this workflow when Firebase should own the remote Android targets. ADB
Ready validates exact dimensions against the live catalog, starts one bounded
instrumentation or Robo matrix through `gcloud`, normalizes its outcome, and
keeps local evidence. It does not create projects, manage billing, provision
credentials, or replace Firebase's test formats.

## Prerequisites

Install the current [Google Cloud CLI](https://cloud.google.com/sdk/docs/install),
authenticate it in the surrounding developer or CI environment, and enable
Firebase Test Lab for the selected Google Cloud project. Credentials remain in
Google's credential store; ADB Ready never writes access tokens into config,
output, or evidence.

Inspect the authenticated live catalog before choosing a matrix:

```bash
adb-ready test firebase devices --project my-project
adb-ready test firebase devices --project my-project --json
```

Catalog output joins each model to its supported Android versions and reports
form, form factor, capacity, and provider tags. A requested unavailable,
inaccessible, deprecated, reduced-stability, zero-capacity, or low-capacity
dimension fails before artifact upload. Deprecated, reduced-stability, and
low-capacity choices require their matching explicit `--allow-*` policy.

## Instrumentation

Preview the exact direct `gcloud` invocation first:

```bash
adb-ready test firebase instrumentation \
  --project my-project \
  --app app/build/outputs/apk/debug/app-debug.apk \
  --test-apk app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk \
  --test-device model=Pixel2.arm,version=35,locale=en,orientation=portrait \
  --dry-run --json
```

Remove `--dry-run` to create the matrix. Repeat `--test-device` for additional
explicit dimensions. Local paths and private `gs://bucket/object` artifact
references are supported; signed URLs are rejected so credentials cannot be
retained accidentally.

## Robo

Robo needs the app artifact but no instrumentation APK:

```bash
adb-ready test firebase robo \
  --project my-project \
  --app app-debug.apk \
  --test-device model=Pixel2.arm,version=35
```

`--test-timeout 10m` controls the provider-side timeout for each execution.
`--run-timeout 30m` bounds only ADB Ready's local observation.

## Results and evidence

For deterministic CI retention, use a bucket your job can read and write:

```bash
adb-ready test firebase instrumentation \
  --project my-project \
  --app app-debug.apk \
  --test-apk app-debug-androidTest.apk \
  --test-device model=Pixel2.arm,version=35 \
  --results-bucket gs://my-test-results \
  --results-dir ci/$GITHUB_RUN_ID
```

ADB Ready always retains redacted `gcloud` output and the structured result
under `.adb-ready/artifacts/firebase-<run-id>/`. With an explicit result bucket,
it also lists only that exact prefix and downloads a bounded allowlist of native
JUnit, HTML, JSON, log, screenshot, video, coverage, and protobuf artifacts:

- at most 100 provider files;
- at most 20 MiB per file;
- at most 50 MiB total;
- exact post-download size verification; and
- a local `provider-files.json` source manifest.

The structured result reports `complete`, `unavailable`, `remote-running`, or
`not-configured` evidence collection. Failure to copy requested provider
evidence is a warning alongside the original test outcome; it never rewrites a
test assertion into a false pass or a different provider outcome.

Without an explicit bucket, the Firebase console URL remains the provider
result reference and only local normalized evidence is copied.

## Outcomes and cancellation

ADB Ready preserves the documented `gcloud firebase test android run` result
classes instead of flattening them:

- `passed`;
- `flaky` — provider roll-up succeeded but at least one test was flaky;
- `assertion-failed`;
- `inconclusive`;
- `unsupported`;
- `cancelled`;
- `infrastructure-failed`;
- `auth-failed`; and
- local `observation-timed-out` or `observation-stopped`.

Stopping or timing out local observation intentionally leaves an identified
remote matrix running. Cancel exactly one matrix with a separate explicit
action:

```bash
adb-ready test firebase cancel MATRIX_ID --project my-project --dry-run
adb-ready test firebase cancel MATRIX_ID --project my-project
```

Cancellation obtains a short-lived access token from the authenticated
`gcloud` process in memory and calls the official Testing API. The token is not
stored or printed.

See Firebase's current [Android CLI guide](https://firebase.google.com/docs/test-lab/android/command-line),
[available-device guidance](https://firebase.google.com/docs/test-lab/android/available-testing-devices),
and [result documentation](https://firebase.google.com/docs/test-lab/android/analyzing-results)
for provider setup, billing, quotas, and native result semantics.
