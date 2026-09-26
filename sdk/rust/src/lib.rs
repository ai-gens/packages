//! Blocking Rust client for the public AI Gens package registry.
//!
//! The registry has no API server: the SDK reads its published JSON files and
//! downloads assets from the URLs recorded in release metadata.

use std::cmp::Ordering;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::Url;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// Default location of the public registry's metadata.
pub const DEFAULT_BASE_URL: &str = "https://raw.githubusercontent.com/ai-gens/packages/main/";

/// Errors returned by the registry client.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid registry data: {0}")]
    InvalidData(String),
    #[error("invalid package ID or version: {0}")]
    InvalidInput(String),
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("file operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("asset size mismatch: expected {expected} bytes, received {actual} bytes")]
    SizeMismatch { expected: u64, actual: u64 },
    #[error("asset SHA-256 mismatch: expected {expected}, received {actual}")]
    ChecksumMismatch { expected: String, actual: String },
}

pub type Result<T> = std::result::Result<T, Error>;

/// Entry in the registry's stable package index.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct PackageSummary {
    pub id: String,
    pub version: String,
    pub latest: String,
}

/// Public registry index. Only stable releases appear here.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryIndex {
    pub schema_version: u32,
    pub generated_at: String,
    pub packages: Vec<PackageSummary>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ReleaseLink {
    pub tag: String,
    pub url: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Changelog {
    pub format: String,
    pub content: String,
}

/// Downloadable archive for one platform.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub name: String,
    pub os: String,
    pub arch: String,
    pub target: Option<String>,
    pub size: u64,
    pub sha256: String,
    pub download_url: String,
}

/// Published metadata for one release.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageRelease {
    pub schema_version: u32,
    pub package: String,
    pub version: String,
    pub published_at: String,
    pub prerelease: bool,
    pub release: ReleaseLink,
    pub changelog: Changelog,
    pub assets: Vec<Asset>,
}

impl PackageRelease {
    /// Find an archive by the registry's OS and architecture names, such as
    /// `linux` and `amd64`. Use [`Self::asset_for_target`] when a Rust target
    /// triple is available.
    pub fn asset_for(&self, os: &str, arch: &str) -> Option<&Asset> {
        self.assets
            .iter()
            .find(|asset| asset.os == os && asset.arch == arch)
    }

    /// Find an archive by its optional Rust target triple.
    pub fn asset_for_target(&self, target: &str) -> Option<&Asset> {
        self.assets
            .iter()
            .find(|asset| asset.target.as_deref() == Some(target))
    }
}

/// Synchronous client. Clone it to share its HTTP connection pool.
#[derive(Clone, Debug)]
pub struct RegistryClient {
    http: Client,
    base_url: Url,
}

impl RegistryClient {
    /// Connect to the public `ai-gens/packages` registry.
    pub fn new() -> Result<Self> {
        Self::with_base_url(DEFAULT_BASE_URL)
    }

    /// Connect to a mirror or a local registry. The URL may include a path
    /// prefix; a trailing slash is added when absent.
    pub fn with_base_url(base_url: &str) -> Result<Self> {
        let mut base_url = Url::parse(base_url)
            .map_err(|error| Error::InvalidInput(format!("base URL: {error}")))?;
        validate_http_url(&base_url, "base URL")?;
        if base_url.query().is_some() || base_url.fragment().is_some() {
            return Err(Error::InvalidInput(
                "base URL must not contain a query or fragment".into(),
            ));
        }
        if !base_url.path().ends_with('/') {
            let path = format!("{}/", base_url.path());
            base_url.set_path(&path);
        }
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .build()?;
        Ok(Self { http, base_url })
    }

    /// Read and validate the current stable package index.
    pub fn index(&self) -> Result<RegistryIndex> {
        let index: RegistryIndex = self.get_json("index.json")?;
        if index.schema_version != 1 {
            return Err(Error::InvalidData(format!(
                "unsupported index schema version {}",
                index.schema_version
            )));
        }
        for entry in &index.packages {
            validate_package_id(&entry.id)
                .map_err(|error| Error::InvalidData(error.to_string()))?;
            validate_version(&entry.version)
                .map_err(|error| Error::InvalidData(error.to_string()))?;
            if entry.latest != format!("packages/{}/latest.json", entry.id) {
                return Err(Error::InvalidData(format!(
                    "invalid latest path for {}",
                    entry.id
                )));
            }
        }
        Ok(index)
    }

    /// Search stable packages by an ASCII case-insensitive ID substring.
    /// An empty query lists every indexed package.
    pub fn search(&self, query: &str) -> Result<Vec<PackageSummary>> {
        let query = query.to_ascii_lowercase();
        Ok(self
            .index()?
            .packages
            .into_iter()
            .filter(|entry| entry.id.contains(&query))
            .collect())
    }

    /// Read the newest stable release of a package.
    pub fn latest(&self, package_id: &str) -> Result<PackageRelease> {
        validate_package_id(package_id)?;
        let release = self.get_json(&format!("packages/{package_id}/latest.json"))?;
        validate_release(release, package_id, None, true)
    }

    /// Read an exact version, including a prerelease if one was published.
    pub fn version(&self, package_id: &str, version: &str) -> Result<PackageRelease> {
        validate_package_id(package_id)?;
        validate_version(version)?;
        let release = self.get_json(&format!("packages/{package_id}/versions/{version}.json"))?;
        validate_release(release, package_id, Some(version), false)
    }

    /// Return the newest stable release if it is newer than the installed
    /// SemVer version. Build metadata does not affect version precedence.
    pub fn check_update(
        &self,
        package_id: &str,
        installed_version: &str,
    ) -> Result<Option<PackageRelease>> {
        validate_version(installed_version)?;
        let latest = self.latest(package_id)?;
        if compare_versions(&latest.version, installed_version)? == Ordering::Greater {
            Ok(Some(latest))
        } else {
            Ok(None)
        }
    }

    /// Stream an archive to a new file, verify its advertised size and SHA-256,
    /// and move it into place only after verification. Existing files are never
    /// replaced. The caller decides whether and how to install the archive.
    pub fn download_asset(&self, asset: &Asset, destination: impl AsRef<Path>) -> Result<()> {
        validate_asset(asset)?;
        let url = Url::parse(&asset.download_url)
            .map_err(|error| Error::InvalidData(format!("asset URL: {error}")))?;
        validate_http_url(&url, "asset URL")
            .map_err(|error| Error::InvalidData(error.to_string()))?;
        let mut response = self.http.get(url).send()?.error_for_status()?;
        let destination = destination.as_ref();
        let parent = destination
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        let mut digest = Sha256::new();
        let mut size = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = response.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            size = size
                .checked_add(count as u64)
                .ok_or_else(|| Error::InvalidData("asset is too large".into()))?;
            if size > asset.size {
                return Err(Error::SizeMismatch {
                    expected: asset.size,
                    actual: size,
                });
            }
            digest.update(&buffer[..count]);
            temp.write_all(&buffer[..count])?;
        }
        if size != asset.size {
            return Err(Error::SizeMismatch {
                expected: asset.size,
                actual: size,
            });
        }
        let actual = format!("{:x}", digest.finalize());
        if actual != asset.sha256 {
            return Err(Error::ChecksumMismatch {
                expected: asset.sha256.clone(),
                actual,
            });
        }
        temp.persist_noclobber(destination)
            .map_err(|error| Error::Io(error.error))?;
        Ok(())
    }

    fn get_json<T: DeserializeOwned>(&self, relative_path: &str) -> Result<T> {
        let url = self
            .base_url
            .join(relative_path)
            .map_err(|error| Error::InvalidInput(format!("metadata path: {error}")))?;
        Ok(self
            .http
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(Duration::from_secs(30))
            .send()?
            .error_for_status()?
            .json()?)
    }
}

fn validate_http_url(url: &Url, label: &str) -> Result<()> {
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::InvalidInput(format!(
            "{label} must be an HTTP(S) URL without credentials"
        )));
    }
    Ok(())
}

fn validate_package_id(id: &str) -> Result<()> {
    let mut parts = id.split(|char| matches!(char, '.' | '_' | '-'));
    if id.is_empty()
        || !parts.all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
    {
        return Err(Error::InvalidInput(format!("invalid package ID {id:?}")));
    }
    Ok(())
}

fn validate_release(
    release: PackageRelease,
    package_id: &str,
    version: Option<&str>,
    stable: bool,
) -> Result<PackageRelease> {
    if release.schema_version != 1
        || release.package != package_id
        || version.is_some_and(|expected| expected != release.version)
    {
        return Err(Error::InvalidData(
            "release schema, package ID, or version does not match request".into(),
        ));
    }
    validate_version(&release.version).map_err(|error| Error::InvalidData(error.to_string()))?;
    if stable && release.prerelease {
        return Err(Error::InvalidData(
            "latest release is marked as a prerelease".into(),
        ));
    }
    if release.assets.is_empty() {
        return Err(Error::InvalidData("release has no assets".into()));
    }
    for asset in &release.assets {
        validate_asset(asset)?;
    }
    Ok(release)
}

fn validate_asset(asset: &Asset) -> Result<()> {
    if asset.name.is_empty()
        || asset.size == 0
        || asset.sha256.len() != 64
        || !asset
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(Error::InvalidData(format!(
            "invalid asset metadata for {:?}",
            asset.name
        )));
    }
    Ok(())
}

/// Compare two registry SemVer strings using version precedence. Build
/// metadata is ignored, as required by SemVer.
pub fn compare_versions(left: &str, right: &str) -> Result<Ordering> {
    let left = parse_version(left)?;
    let right = parse_version(right)?;
    for (a, b) in left.core.iter().zip(right.core.iter()) {
        let ordering = compare_decimal(a, b);
        if ordering != Ordering::Equal {
            return Ok(ordering);
        }
    }
    match (left.pre.is_empty(), right.pre.is_empty()) {
        (true, false) => return Ok(Ordering::Greater),
        (false, true) => return Ok(Ordering::Less),
        _ => {}
    }
    for (a, b) in left.pre.iter().zip(right.pre.iter()) {
        let ordering = match (is_decimal(a), is_decimal(b)) {
            (true, true) => compare_decimal(a, b),
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (false, false) => a.cmp(b),
        };
        if ordering != Ordering::Equal {
            return Ok(ordering);
        }
    }
    Ok(left.pre.len().cmp(&right.pre.len()))
}

fn validate_version(version: &str) -> Result<()> {
    parse_version(version).map(|_| ())
}

struct ParsedVersion<'a> {
    core: [&'a str; 3],
    pre: Vec<&'a str>,
}

fn parse_version(version: &str) -> Result<ParsedVersion<'_>> {
    let invalid = || Error::InvalidInput(format!("invalid SemVer version {version:?}"));
    let (without_build, build) = version
        .split_once('+')
        .map_or((version, None), |(main, build)| (main, Some(build)));
    if build.is_some_and(|value| !valid_identifiers(value)) {
        return Err(invalid());
    }
    let (core, pre) = without_build
        .split_once('-')
        .map_or((without_build, None), |(core, pre)| (core, Some(pre)));
    let parts: Vec<_> = core.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| !is_decimal(part) || (part.len() > 1 && part.starts_with('0')))
        || pre.is_some_and(|value| !valid_identifiers(value))
    {
        return Err(invalid());
    }
    Ok(ParsedVersion {
        core: [parts[0], parts[1], parts[2]],
        pre: pre.map_or_else(Vec::new, |value| value.split('.').collect()),
    })
}

fn valid_identifiers(value: &str) -> bool {
    !value.is_empty()
        && value.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn is_decimal(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn compare_decimal(left: &str, right: &str) -> Ordering {
    let left = left.trim_start_matches('0');
    let right = right.trim_start_matches('0');
    left.len().cmp(&right.len()).then_with(|| left.cmp(right))
}
