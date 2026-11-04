# Release and maintenance

All current releases are development prereleases. The newest published prerelease is the only line receiving fixes; there is no LTS or response-time guarantee. Consumers should report issues against an exact tag and image digest. Security reports use [private reporting](https://github.com/pythc/anymail-connect/security/advisories/new), never a public reproduction containing credentials.

## Artifacts and verification

The tag-triggered [release workflow](../.github/workflows/release.yml) checks that the tag equals the package version and belongs to `main`, runs the CI workflow, and builds Linux amd64/arm64 images. It publishes a GitHub prerelease only after the build and provenance step succeed. It never publishes a `latest` tag or overwrites an existing GitHub release. Container tags can move; the **digest** is the immutable installation identity. Do not treat an unfinished workflow or an image without its completed release as a release.

Each release contains a source archive, `image.txt` and `SHA256SUMS`. Verify checksums after download:

```sh
sha256sum -c SHA256SUMS
# macOS: shasum -a 256 -c SHA256SUMS
```

Read the exact `ghcr.io/pythc/anymail-connect@sha256:...` reference in `image.txt`. Pull without a registry login for public consumption, then verify the GitHub provenance:

```sh
docker pull ghcr.io/pythc/anymail-connect@sha256:RELEASE_DIGEST
gh attestation verify oci://ghcr.io/pythc/anymail-connect@sha256:RELEASE_DIGEST --repo pythc/anymail-connect
```

BuildKit provenance and SBOM attestations are attached to the image index. Inspect with `docker buildx imagetools inspect IMAGE --format '{{json .Provenance}}'` and `--format '{{json .SBOM}}'`. These identify build inputs and packaged components; they do not prove absence of vulnerabilities, reproducibility or functional correctness. Dependencies retain their license files in the image. The project's Apache-2.0 license is shipped at `/app/LICENSE`.

## Upgrade and recovery

Read release notes and [operations](operations.md) before upgrading. Back up the application database, identity database/configuration and every active/previous vault key as one recoverable set. Preserve the current image digest and configuration. Stop or drain workers before an upgrade so that submission state is not concurrently interpreted by two versions. Test restore in an isolated environment, including credential decryption, before declaring a backup usable.

Replace API and worker with the same verified digest. Check schema compatibility, process health, OIDC login and a read-only mailbox operation. Process health alone does not establish provider readiness. Reconcile `submitting`/`unknown` operations; never generate new sends to "test" a replay.

Rollback depends on the schema and writes performed after upgrade. If the previous binary cannot safely interpret the current state, restore the matching backup and keys under a controlled recovery plan. A source-level claim of no new schema does not constitute a tested disaster recovery procedure. Prerelease 0.4.1-alpha.1 adds no database migration.

## Maintainer procedure

Use a new version for every release attempt that has produced artifacts; do not move a published tag. Update package/lockfile, plugin, HTTP and MCP versions together. Review the final diff, run CI and create the matching `vVERSION` tag only after its commit is pushed. Check the release workflow, anonymous image pull, architecture manifests, SBOM, attestation and source checksums before announcing availability. Publishing failures can leave an image without a release: mark the attempt incomplete and investigate rather than silently promoting it.

Public work is tracked in [Issues](https://github.com/pythc/anymail-connect/issues) and milestones. Questions and proposals belong in [Discussions](https://github.com/pythc/anymail-connect/discussions); bugs need a reproducible issue. Contributions use Apache-2.0 terms, and the maintainer reviews changes before accepting them. Maintainer decisions should cite the behavior and compatibility tradeoff; a feature request is not a commitment or a support SLA.

## MCP Registry boundary

No official Registry listing is claimed. The current server is a self-hosted Streamable HTTP service with PostgreSQL and OIDC dependencies. A localhost demo is not a public remote endpoint, and publishing an OCI image does not by itself define a correct Registry installation entry. A future listing needs a verified namespace and a validated package/transport installation path or an explicitly operated public endpoint. Do not publish placeholder URLs or add a tunnel just to obtain a listing.
