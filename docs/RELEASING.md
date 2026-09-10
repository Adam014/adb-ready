# Releasing ADB Ready

ADB Ready publishes from a GitHub release through npm trusted publishing. The
workflow does not use a long-lived npm write token.

## One-time setup

1. Keep the repository private until its complete reachable history, refs,
   releases, packages, and Actions artifacts pass the privacy audit.
2. On npm, configure a GitHub Actions trusted publisher for:
   - owner: `Adam014`
   - repository: `adb-ready`
   - workflow filename: `release.yml`
   - allowed action: direct `npm publish`
3. Before publishing with provenance, make the audited repository public. npm
   does not generate provenance for a public package built from a private
   repository.
4. Keep npm token-based publishing restricted after the trusted publisher is
   working.

## Prepare a release

1. Complete the real-device acceptance matrix for the advertised hosts and
   workflows.
2. Set the exact release version in `package.json`.
3. Change `private` to `false` only in the release commit.
4. Move the relevant entries from `Unreleased` into a dated
   `## [VERSION] - YYYY-MM-DD` section in `CHANGELOG.md` and update its links.
5. Replace all `@alpha` installation examples and private-preview language in
   `README.md`.
6. Run:

   ```bash
   bun install --frozen-lockfile
   bun run verify
   bun run release:check -- --publish vVERSION
   ```

7. Review `npm pack --dry-run --json --ignore-scripts` and confirm that no local
   context, credentials, fixtures, sources, or development scripts are present.
8. Commit the release as one reviewable commit and push it only after every
   check is green.

## Publish

Create a GitHub release for the exact `vVERSION` tag on the audited release
commit. Publishing the release triggers `.github/workflows/release.yml`, which:

1. checks out the immutable release tag;
2. installs the locked toolchain;
3. pins an npm CLI that supports trusted publishing;
4. runs the complete verification gate;
5. verifies the tag, stable version, license, public metadata, changelog, README,
   and package allowlist; and
6. publishes the public package through short-lived OIDC credentials.

Do not rerun a failed publish blindly. Inspect whether the version already
exists on npm first; published npm versions are immutable.

## Verify from a clean consumer

After npm and its CDN have converged, validate the public artifact outside the
repository:

```bash
npx adb-ready@VERSION --version
npx adb-ready@VERSION doctor --json
pnpm dlx adb-ready@VERSION --version
yarn dlx adb-ready@VERSION --version
bunx adb-ready@VERSION --version
deno run -A npm:adb-ready@VERSION --version
```

Confirm the npm page shows the expected README, MIT license, repository,
provenance, executable names, unpacked size, and file inventory. Then verify
the `latest` dist-tag points to the released version.
