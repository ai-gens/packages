# Package Integration

## Overview

A private source repository owns its build and internal GitHub Release. The
public `ai-gens/packages` repository owns publication and registry generation.
Source repositories must not clone or push to this repository.

This separation provides one serialized writer for shared files and prevents
concurrent source releases from conflicting on `index.json`.

## Registration

Before the first release, register:

- A globally unique package ID, such as `pt-buddy`.
- The private source repository allowed to publish that package.
- Whether prereleases should be published.
- The expected asset naming and supported platform values.
- A read-only credential available to the target workflow for the private
  source Release.

Public package and platform configuration is stored in `config/packages.json`.
The package-to-source mapping is stored separately in the
`PACKAGE_SOURCES_JSON` Repository Variable, so repository names remain easy to
update without changing generated package metadata.

## Source Release contract

The private source workflow must complete the Release before dispatching:

1. Create a non-draft GitHub Release with a SemVer tag such as `v0.1.4`.
2. Put the public changelog in the Release body.
3. Upload all distributable archives.
4. Upload or otherwise provide SHA-256 digests for every archive.
5. Send the repository dispatch only after all assets are available.

Recommended asset names:

```text
<package-id>-v<version>-<os>-<arch>.<extension>
<package-id>-v<version>-<os>-<arch>.<extension>.dgst
```

The target workflow derives the version from the source Release tag and rejects
a version that does not conform to SemVer.

## Dispatch event

Event type:

```text
package-release-published
```

The `client_payload` must conform to
[`dispatch-payload.schema.json`](../schemas/dispatch-payload.schema.json):

```json
{
  "schemaVersion": 1,
  "package": "pt-buddy",
  "source": {
    "releaseId": 123456789,
    "tag": "v0.1.4"
  }
}
```

Only the public package ID and private Release identifiers are sent. Do not send
the private repository name, release notes, asset URLs, checksums, or the output
version as trusted values.

An example source workflow step:

```yaml
- name: Notify public package registry
  env:
    GH_TOKEN: ${{ secrets.PACKAGES_DISPATCH_TOKEN }}
    PACKAGE_ID: pt-buddy
    RELEASE_TAG: v0.1.4
  run: |
    release_id="$(
      gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${RELEASE_TAG}" \
        --jq '.id'
    )"

    jq -n \
      --arg package "${PACKAGE_ID}" \
      --arg tag "${RELEASE_TAG}" \
      --argjson release_id "${release_id}" \
      '{
        event_type: "package-release-published",
        client_payload: {
          schemaVersion: 1,
          package: $package,
          source: {
            releaseId: $release_id,
            tag: $tag
          }
        }
      }' > package-dispatch.json

    gh api \
      --method POST \
      "repos/ai-gens/packages/dispatches" \
      --input package-dispatch.json
```

`PACKAGES_DISPATCH_TOKEN` must be scoped to the target repository and stored as
an Actions secret. The source repository's built-in `GITHUB_TOKEN` cannot
dispatch to another repository. A GitHub App installation token is preferred
for long-term use; a fine-grained token with target Contents write permission
can be used for initial integration.

## Target configuration

Configure this Actions repository secret in `ai-gens/packages`:

```text
SOURCE_REPOSITORY_TOKEN
```

`SOURCE_REPOSITORY_TOKEN` must have read-only Contents access to the registered
private source repositories. It is used only to read Release metadata and
download Release assets.

Configure `PACKAGE_SOURCES_JSON` as a Repository Variable. It keeps source
repository mappings out of the generated package configuration while remaining
easy to update:

```json
{
  "pt-buddy": "private-owner/pt-buddy"
}
```

Set the credential as a Secret and the mapping as a Variable through GitHub
Settings or the GitHub CLI:

```bash
gh secret set SOURCE_REPOSITORY_TOKEN --repo ai-gens/packages
gh variable set PACKAGE_SOURCES_JSON --repo ai-gens/packages
```

The workflow masks the resolved private repository name before API requests and
never prints tokens, mappings, private API URLs, or private Release bodies.

## Target processing

The target workflow performs these operations in order:

1. Validate `client_payload` against the dispatch contract.
2. Resolve the registered source repository from the repository variable.
3. Read the private Release by ID with a read-only source credential.
4. Verify the tag, draft state, prerelease policy, changelog, and assets.
5. Download every archive and verify its SHA-256 digest.
6. Create the public Release tag `<package-id>-v<version>`.
7. Upload the verified archives and digest files to the public Release.
8. Generate `packages/<package-id>/versions/<version>.json`.
9. Update `packages/<package-id>/latest.json` for a newer stable version.
10. Regenerate the sorted root `index.json`.
11. Run registry unit tests and validate all generated JSON.
12. Commit and push once using the target repository's `GITHUB_TOKEN`.

The public metadata must not contain the private repository name, private
Release URL, source commit SHA, credentials, or internal-only release notes.

The implemented workflow is
`.github/workflows/publish-package.yml`. It supports both
`repository_dispatch` and a manual `workflow_dispatch` retry with the package
ID, Release ID, and tag.

## Concurrency and idempotency

All publication runs use one repository-wide concurrency group:

```yaml
concurrency:
  group: package-registry-write
  cancel-in-progress: false
  queue: max
```

Publication is idempotent:

- Replaying an identical package version is a successful no-op.
- Existing version metadata is never silently replaced with different content.
- An older version never replaces `latest.json`.
- A conflicting package-to-source mapping fails before downloading assets.
- A failed run can be retried with `workflow_dispatch` using the same payload.

## Public output

Each successful publication creates:

```text
packages/<package-id>/latest.json
packages/<package-id>/versions/<version>.json
```

Both files use the same release document. `latest.json` is a copy of the newest
stable version, while version documents are immutable.

Public binary assets are hosted in this repository's GitHub Releases:

```text
https://github.com/ai-gens/packages/releases/tag/<package-id>-v<version>
```

Consumers discover packages through `index.json` and validate release documents
against `schemas/package-release.schema.json`.

## Commit identity

Generated registry commits use:

```text
Name:  github-actions[bot]
Email: 41898282+github-actions[bot]@users.noreply.github.com
```

Recommended commit message:

```text
chore(registry): publish <package-id> v<version>
```
