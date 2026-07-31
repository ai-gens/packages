# AI Gens Package Registry

This repository is the public distribution registry for AI Gens projects.
Source repositories may remain private. Their release workflows notify this
repository, and this repository is the only writer of public package metadata
and public release assets.

## Publishing model

1. A private source repository publishes its internal GitHub Release.
2. The source workflow sends a `package-release-published` repository dispatch.
3. This repository validates the package and reads the private Release through
   a read-only credential.
4. The workflow copies release assets to a namespaced public Release.
5. The workflow generates the version metadata, `latest.json`, and `index.json`.
6. The generated files are committed by `github-actions[bot]`.

The dispatch payload is only a reference to a Release. Release notes, download
URLs, checksums, and versions are derived and verified by this repository.

## Repository layout

```text
.
├── index.json
├── packages/
│   └── <package-id>/
│       ├── latest.json
│       └── versions/
│           └── <version>.json
├── schemas/
│   ├── dispatch-payload.schema.json
│   ├── index.schema.json
│   └── package-release.schema.json
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

## Integration

See [docs/INTEGRATION.md](docs/INTEGRATION.md) for the release contract,
dispatch payload, permissions, validation, and retry behavior.

Examples are illustrative and are not part of the live registry.
