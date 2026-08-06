# Publishing

Releases are driven by [changesets](https://github.com/changesets/changesets) and published to npm
with **Trusted Publishing**, so there is no long-lived npm token in this repository.

## Day-to-day

1. Make your change.
2. Run `npx changeset` and describe it. Pick `patch`, `minor` or `major`.
3. Commit the generated file in `.changeset/` alongside your change.

When that lands on `main`, the Release workflow opens (or updates) a `chore: release` pull request
that bumps the version and writes `CHANGELOG.md`. Merging that PR publishes to npm.

## One-time setup

Trusted Publishing has to be enabled on the npm side; the workflow cannot do it for you.

1. Publish `1.0.0` manually once, so the package exists:

   ```bash
   npm login
   npm run build
   npm publish --access public
   ```

2. On <https://www.npmjs.com/package/renderready/access>, under **Trusted Publisher**, add a GitHub
   Actions publisher:
   - Organization or user: `lukapozega`
   - Repository: `renderready`
   - Workflow filename: `release.yml`

3. Remove any `NPM_TOKEN` secret from the repository. It is no longer needed, and a leaked token is
   the thing this setup exists to avoid.

Every later release goes through the workflow. Publishing this way also attaches a provenance
attestation, so consumers can verify the tarball was built from this repository.

## Requirements the workflow depends on

- `id-token: write` permission, which is what mints the OIDC token.
- npm 11.5.1 or newer, which is why the workflow upgrades npm before publishing.
- The package must be public (`.changeset/config.json` sets `"access": "public"`).
