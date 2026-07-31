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

The package-to-source mapping must be checked before any private Release is
read. If private repository names must not be public, keep that mapping in an
encrypted Actions secret instead of a committed configuration file.

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
    "repository": "private-owner/pt-buddy",
    "releaseId": 123456789,
    "tag": "v0.1.4"
  }
}
```

Only identifiers are sent. Do not send release notes, asset URLs, checksums, or
the output version as trusted values.

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
      --arg repository "${GITHUB_REPOSITORY}" \
      --arg tag "${RELEASE_TAG}" \
      --argjson release_id "${release_id}" \
      '{
        event_type: "package-release-published",
        client_payload: {
          schemaVersion: 1,
          package: $package,
          source: {
            repository: $repository,
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
an Actions secret. A GitHub App installation token is preferred for long-term
use; a fine-grained token can be used for initial integration.

## Target processing

The target workflow performs these operations in order:

1. Validate `client_payload` against the dispatch schema.
2. Verify that the package ID is registered to the source repository.
3. Read the private Release by ID with a read-only source credential.
4. Verify the tag, draft state, prerelease policy, changelog, and assets.
5. Download every archive and verify its SHA-256 digest.
6. Create the public Release tag `<package-id>-v<version>`.
7. Upload the verified archives and digest files to the public Release.
8. Generate `packages/<package-id>/versions/<version>.json`.
9. Update `packages/<package-id>/latest.json` for a newer stable version.
10. Regenerate the sorted root `index.json`.
11. Validate all generated JSON against the committed schemas.
12. Commit and push once using the target repository's `GITHUB_TOKEN`.

The public metadata must not contain the private repository name, private
Release URL, source commit SHA, credentials, or internal-only release notes.

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
