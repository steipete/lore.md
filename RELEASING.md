# Releasing lore.md source

lore.md has published versioned GitHub source releases. Its `lore-md` package is
private development tooling; it is not published to npm. Production is a
Cloudflare Worker, and **this release workflow never deploys it**.

`.github/workflows/release.yml` calls the shared source archetype at `@v1`.
It checks `package.json` against the requested version, extracts the matching
real dated changelog section, and requires green push CI on the exact protected
main commit. A credential-free build installs the pinned pnpm dependencies,
runs `pnpm check`, and bundles with `wrangler deploy --dry-run`. Two independent
runners verify the source archives, exact notes, inventory and SHA-256 checksums.

Prepare a future version by updating `package.json`, finalizing its section in
`CHANGELOG.md`, and merging to main. Wait for push CI, then rehearse:

```sh
gh workflow run release.yml --ref main -f version=0.2.0 -F dry_run=true
```

Select the version being prepared when rehearsing a future release. Dry runs
validate the exact main commit even if that version was previously released;
they do not create tags, publish, or deploy. Only the main checkout is tested.

To publish after an explicit release decision, push an SSH-signed annotated
`vX.Y.Z` tag at that tested commit using the release signing key allowed by
`.github/release-allowed-signers`. A dispatch with `dry_run=false` can resume the
same signed tag. No tag is moved, and existing public artifacts must match the
verified bytes. Source tar/zip archives, `RELEASE-NOTES.md`, `ASSET-INVENTORY.json`
and `SHA256SUMS` are attached to GitHub Releases.

No npm trust, Apple, Homebrew, Sparkle, Cloudflare, or AI secrets are required.
Deployment remains a separate explicitly authorized operation described in the
README; there is no local GitHub-release publication path.
