# AI Gens Package Registry

This repository is the public distribution registry for AI Gens projects.
Source repositories may remain private. Their release workflows notify this
repository, and this repository is the only writer of public package metadata
and public release assets.

## Publishing model

1. A private source repository publishes its internal GitHub Release.
2. The source workflow starts `publish-package.yml` through `workflow_dispatch`
   with only the package ID, Release ID, and tag.
3. This repository resolves the private source from a repository variable,
   validates the package, and reads the private Release through a read-only
   credential.
4. The workflow copies release assets to a namespaced public Release.
5. The workflow generates the version metadata, `latest.json`, and `index.json`.
6. The generated files are committed by `github-actions[bot]`.

The workflow inputs are only a reference to a Release. Release notes, download
URLs, checksums, and versions are derived and verified by this repository.

## Repository layout

```text
.
├── .github/
│   └── workflows/
│       └── publish-package.yml
├── config/
│   └── packages.json
├── index.json
├── packages/
│   └── <package-id>/
│       ├── latest.json
│       └── versions/
│           └── <version>.json
├── scripts/
│   ├── publish-release.mjs
│   └── registry.mjs
├── schemas/
│   ├── dispatch-payload.schema.json
│   ├── index.schema.json
│   ├── package-release.schema.json
│   └── registry-config.schema.json
├── tests/
│   └── registry.test.mjs
├── examples/
│   └── pt-buddy/
│       ├── dispatch-payload.json
│       ├── index.json
│       └── latest.json
└── docs/
    └── INTEGRATION.md
```

`packages/` and `index.json` are generated output. They must not be edited by
source repository workflows or by hand during a normal release.

## Public naming

- Package ID: lowercase letters, numbers, dots, underscores, and hyphens.
- Public Release tag: `<package-id>-v<version>`.
- Version metadata: `packages/<package-id>/versions/<version>.json`.
- Latest stable metadata: `packages/<package-id>/latest.json`.
- Asset name: `<package-id>-v<version>-<os>-<arch>.<extension>`.

For example:

```text
pt-buddy-v0.1.4
pt-buddy-v0.1.4-linux-amd64.zip
packages/pt-buddy/latest.json
packages/pt-buddy/versions/0.1.4.json
```

Package IDs are globally unique within this repository. The target workflow
serializes all registry writes, so source repositories never push to the shared
branch directly.

## Required configuration

The publication workflow reads one GitHub Actions Secret and one Repository
Variable:

- `SOURCE_REPOSITORY_TOKEN`: a fine-grained token with read-only Contents
  access to registered private source repositories.
- `PACKAGE_SOURCES_JSON`: a Repository Variable mapping public package IDs to
  private repository names, for example
  `{"pt-buddy":"private-owner/pt-buddy"}`.

The token must never be stored in a variable or committed. Repository names are
configuration rather than credentials, so the mapping remains easy to inspect
and update. The workflow does not run for pull requests, does not check out
private source code, and masks the resolved private repository name before
making API requests.

## Integration

See [docs/INTEGRATION.md](docs/INTEGRATION.md) for the release contract,
dispatch payload, permissions, validation, and retry behavior.

Examples are illustrative and are not part of the live registry.
