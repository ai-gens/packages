# AI Gens Packages Rust SDK

This blocking Rust client reads the public `ai-gens/packages` registry without
an API token. It searches the stable package index, reads latest or exact
release metadata, checks for updates, selects platform archives, and downloads
archives with size and SHA-256 verification.

## Add to a project

```toml
[dependencies]
ai-gens-packages-sdk = { git = "https://github.com/ai-gens/packages", package = "ai-gens-packages-sdk" }
```

For a local checkout, use `ai-gens-packages-sdk = { path = "../packages/sdk/rust" }`.
The library uses a synchronous HTTP client, so calling its methods blocks the
current thread.

## Search and check for updates

```rust
use ai_gens_packages_sdk::{RegistryClient, Result};

fn main() -> Result<()> {
    let registry = RegistryClient::new()?;
    for package in registry.search("buddy")? {
        println!("{} {}", package.id, package.version);
    }

    if let Some(update) = registry.check_update("pt-buddy", "0.1.2")? {
        println!("New version: {}", update.version);
        println!("Changes:\n{}", update.changelog.content);

        if let Some(asset) = update.asset_for_target("x86_64-unknown-linux-musl") {
            registry.download_asset(asset, &asset.name)?;
            println!("Verified download: {}", asset.name);
        }
    }
    Ok(())
}
```

`latest(id)` reads the newest stable release. `version(id, version)` reads an
exact published version, including a prerelease. `index()` returns the whole
stable index. `search("")` lists all indexed packages. Search matches package
IDs, not changelog text. `check_update` compares SemVer precedence and ignores
build metadata.

Asset `os` and `arch` values follow the registry's names (`linux`, `macos`,
`amd64`, `arm64`). Call `asset_for(os, arch)` to use them, or
`asset_for_target(triple)` for a published Rust target triple. The SDK does not
guess the running machine's target. The caller chooses the archive to install.

`download_asset` streams into a temporary file in the destination directory.
It verifies the size and SHA-256 before placing the file at the destination,
and returns an error if a file already exists there. It does not unpack or
install software. For a mirror or local test registry, use
`RegistryClient::with_base_url("https://example.com/registry/")`.

The registry is published as JSON schema version 1. Unsupported schema
versions and inconsistent package or version metadata return errors. HTTP
responses are fetched afresh on each call; applications that need a cache can
keep returned values for their own desired lifetime.
