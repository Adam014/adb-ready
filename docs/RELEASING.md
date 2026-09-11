# Releasing ADB Ready

ADB Ready promotes one verified npm tarball through npm trusted publishing. A
draft GitHub release is made public only after npm accepts that exact artifact.
The workflow does not use a long-lived npm write token.

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

Release evidence has three tiers:

- **Every release:** the complete fixture, unit, integration, runtime, package,
  documentation, privacy, and release-artifact verification gate must pass.
- **Device-behavior changes:** rerun every affected workflow on a real target
  and record the exact host, target, Android version, and transport. A
  documentation, metadata, or machine-output-only patch does not manufacture
  new hardware evidence.
- **Support expansion:** before promoting a new host, architecture, transport,
  framework, or device class to a tested tier, complete and record its
  dedicated acceptance matrix.

Then prepare the release:

1. Confirm the relevant acceptance tier above is complete and that
   `COMPATIBILITY.md` still states the observed boundary accurately.
2. Set the exact release version in `package.json`.
3. Confirm the published package keeps `private: false`.
4. Move the relevant entries from `Unreleased` into a dated
   `## [VERSION] - YYYY-MM-DD` section in `CHANGELOG.md` and update its links.
5. Replace all prerelease installation examples and private-preview language in
   public documentation.
6. Run:

   ```bash
   bun install --frozen-lockfile
   bun run verify
   bun run release:check -- --publish vVERSION
   ```

7. Review `npm pack --dry-run --json --ignore-scripts` and confirm that no local
   context, credentials, fixtures, sources, or development scripts are present.
8. Commit the release as one reviewable commit and merge it through the normal
   protected-branch pull request.

## Rehearse in GitHub Actions

Run the `Release` workflow from the protected `main` branch in validation mode:

```bash
gh workflow run release.yml \
  --ref main \
  -f mode=validate \
  -f release_tag=vVERSION \
  -f ref=main
```

This uses the real GitHub-hosted release environment but has no npm identity
permission and contains no live publish command. It verifies the complete
suite, required package managers, release metadata, packed artifact, modern
Yarn consumer, and `npm publish --dry-run`.

Do not create or move the final tag until this rehearsal is green.

## Publish

1. Create a draft GitHub release for the exact `vVERSION` tag on the audited
   release commit.
2. Dispatch the audited workflow from protected `main` while selecting the
   immutable tag as the release target. Publish mode rejects every other branch,
   requires the checkout to resolve to that exact tag commit, and also permits a
   self-contained dispatch from the matching tag:

   ```bash
   gh workflow run release.yml \
     --ref main \
     -f mode=publish \
     -f release_tag=vVERSION \
     -f ref=vVERSION
   ```

The workflow:

1. verifies the immutable tag and confirms that its GitHub release is still a
   draft;
2. installs the locked and pinned verification toolchain without publish
   credentials;
3. runs the complete verification gate;
4. creates one tarball and installs that exact file through npm, pnpm, Yarn
   Classic, modern Yarn, and Bun;
5. records and rechecks its SHA-256 digest across the job boundary;
6. grants OIDC only to the isolated npm publish job;
7. publishes the verified tarball through short-lived trusted-publishing
   credentials; and
8. publishes the prepared GitHub release only after npm succeeds.

Do not rerun a failed publish blindly. Inspect whether the version already
exists on npm first; published npm versions are immutable. A failed validation
can be repeated safely. If npm succeeded but the final GitHub release step
failed, rerun only the failed job or publish the existing draft manually.

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

Deno 2 applies a 24-hour minimum dependency age by default. For an immediate
post-publish verification only, override that safety delay explicitly:

```bash
deno run -A --minimum-dependency-age 0 npm:adb-ready@VERSION --version
```

Normal consumers should keep Deno's default policy and omit the override.

Confirm the npm page shows the expected README, MIT license, repository,
provenance, executable names, unpacked size, and file inventory. Then verify
the `latest` dist-tag points to the released version.
