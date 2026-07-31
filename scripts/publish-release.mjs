import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  compareSemver,
  extractPublicChangelog,
  parseDigest,
  parseSourceMap,
  renderAssetSpecs,
  serializeJson,
  validateDispatchPayload,
  validatePackageId,
  validateRegistryConfig,
  validateRepository,
  validateSha256,
  versionFromTag,
} from "./registry.mjs";

const API_VERSION = "2022-11-28";
const WORKSPACE = process.env.GITHUB_WORKSPACE || process.cwd();
const API_BASE_URL = process.env.GITHUB_API_URL || "https://api.github.com";
const UPLOAD_BASE_URL = process.env.GITHUB_UPLOAD_URL || "https://uploads.github.com";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is missing.`);
  }
  return value;
}

function apiRepositoryPath(repository) {
  validateRepository(repository);
  return repository.split("/").map(encodeURIComponent).join("/");
}

async function request(url, token, options = {}) {
  const {
    method = "GET",
    body,
    accept = "application/vnd.github+json",
    contentType,
    contentLength,
    allowNotFound = false,
    label = "GitHub API request",
  } = options;

  const headers = {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "User-Agent": "ai-gens-package-publisher",
    "X-GitHub-Api-Version": API_VERSION,
  };

  if (contentType) {
    headers["Content-Type"] = contentType;
  } else if (body !== undefined && typeof body === "string") {
    headers["Content-Type"] = "application/json";
  }
  if (contentLength !== undefined) {
    headers["Content-Length"] = String(contentLength);
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      redirect: "follow",
      ...(body && typeof body.pipe === "function" ? { duplex: "half" } : {}),
    });
  } catch {
    throw new Error(`${label} failed before receiving a response.`);
  }

  if (allowNotFound && response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}.`);
  }
  return response;
}

async function requestJson(url, token, options = {}) {
  const response = await request(url, token, options);
  if (response === null) {
    return null;
  }

  try {
    return await response.json();
  } catch {
    throw new Error(`${options.label || "GitHub API request"} returned invalid JSON.`);
  }
}

async function downloadAsset(asset, token, destination, label) {
  const response = await request(asset.url, token, {
    accept: "application/octet-stream",
    label,
  });
  if (!response.body) {
    throw new Error(`${label} returned an empty response.`);
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { mode: 0o600 }));
}

async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function sameFileContent(localFilename, remoteAsset, token, tempDirectory) {
  const remoteFilename = path.join(tempDirectory, `existing-${remoteAsset.id}`);
  await downloadAsset(remoteAsset, token, remoteFilename, `Existing public asset "${remoteAsset.name}"`);

  const [localHash, remoteHash] = await Promise.all([
    sha256File(localFilename),
    sha256File(remoteFilename),
  ]);
  return localHash === remoteHash;
}

async function uploadAsset(repository, releaseId, filename, assetName, token) {
  const fileStat = await stat(filename);
  const uploadUrl =
    `${UPLOAD_BASE_URL}/repos/${apiRepositoryPath(repository)}` +
    `/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`;

  return requestJson(uploadUrl, token, {
    method: "POST",
    body: createReadStream(filename),
    contentType: assetName.endsWith(".dgst") ? "text/plain; charset=utf-8" : "application/octet-stream",
    contentLength: fileStat.size,
    label: `Uploading public asset "${assetName}"`,
  });
}

async function readEventPayload() {
  const eventPath = requiredEnvironment("GITHUB_EVENT_PATH");
  const eventName = requiredEnvironment("GITHUB_EVENT_NAME");
  const event = JSON.parse(await readFile(eventPath, "utf8"));

  if (eventName === "repository_dispatch") {
    return validateDispatchPayload(event.client_payload);
  }

  if (eventName === "workflow_dispatch") {
    return validateDispatchPayload({
      schemaVersion: 1,
      package: event.inputs?.package,
      source: {
        releaseId: Number(event.inputs?.release_id),
        tag: event.inputs?.tag,
      },
    });
  }

  throw new Error(`Unsupported workflow event "${eventName}".`);
}

async function loadRegistryConfig() {
  const filename = path.join(WORKSPACE, "config", "packages.json");
  return validateRegistryConfig(JSON.parse(await readFile(filename, "utf8")));
}

function collectSourceAssets(release, assetSpecs) {
  if (!Array.isArray(release.assets)) {
    throw new Error("Source Release assets are missing.");
  }

  const assetsByName = new Map();
  for (const asset of release.assets) {
    if (assetsByName.has(asset.name)) {
      throw new Error(`Source Release contains duplicate asset "${asset.name}".`);
    }
    assetsByName.set(asset.name, asset);
  }

  return assetSpecs.map((spec) => {
    const archive = assetsByName.get(spec.name);
    const digest = assetsByName.get(spec.digestName);
    if (!archive) {
      throw new Error(`Source Release is missing required asset "${spec.name}".`);
    }
    if (!digest) {
      throw new Error(`Source Release is missing required digest "${spec.digestName}".`);
    }
    return { spec, archive, digest };
  });
}

async function downloadAndVerifyAssets(sourceAssets, token, tempDirectory) {
  const verified = [];

  for (const sourceAsset of sourceAssets) {
    const archivePath = path.join(tempDirectory, sourceAsset.spec.name);
    const digestPath = path.join(tempDirectory, sourceAsset.spec.digestName);

    await downloadAsset(
      sourceAsset.archive,
      token,
      archivePath,
      `Private source asset "${sourceAsset.spec.name}"`,
    );
    await downloadAsset(
      sourceAsset.digest,
      token,
      digestPath,
      `Private source digest "${sourceAsset.spec.digestName}"`,
    );

    const archiveStat = await stat(archivePath);
    if (archiveStat.size !== sourceAsset.archive.size) {
      throw new Error(`Downloaded asset "${sourceAsset.spec.name}" has an unexpected size.`);
    }

    const expectedHash = parseDigest(
      await readFile(digestPath, "utf8"),
      sourceAsset.spec.name,
    );
    const actualHash = validateSha256(await sha256File(archivePath));
    if (actualHash !== expectedHash) {
      throw new Error(`SHA-256 verification failed for "${sourceAsset.spec.name}".`);
    }

    verified.push({
      ...sourceAsset.spec,
      archivePath,
      digestPath,
      size: archiveStat.size,
      sha256: actualHash,
    });
  }

  return verified;
}

async function getOrCreatePublicRelease({
  repository,
  packageId,
  version,
  changelog,
  prerelease,
  token,
}) {
  const publicTag = `${packageId}-v${version}`;
  const repositoryPath = apiRepositoryPath(repository);
  let release = await requestJson(
    `${API_BASE_URL}/repos/${repositoryPath}/releases/tags/${encodeURIComponent(publicTag)}`,
    token,
    {
      allowNotFound: true,
      label: "Looking up the public Release",
    },
  );

  if (release) {
    if (release.draft) {
      throw new Error(`Existing public Release "${publicTag}" is still a draft.`);
    }
    if (release.prerelease !== prerelease) {
      throw new Error(`Existing public Release "${publicTag}" has a different prerelease state.`);
    }
    if ((release.body || "").trim() !== changelog.trim()) {
      throw new Error(`Existing public Release "${publicTag}" has different release notes.`);
    }
    return release;
  }

  release = await requestJson(
    `${API_BASE_URL}/repos/${repositoryPath}/releases`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        tag_name: publicTag,
        name: `${packageId} v${version}`,
        body: changelog,
        draft: false,
        prerelease,
        generate_release_notes: false,
      }),
      label: "Creating the public Release",
    },
  );
  return release;
}

async function publishAssets({
  repository,
  publicRelease,
  verifiedAssets,
  token,
  tempDirectory,
}) {
  const existingAssets = new Map(
    (publicRelease.assets || []).map((asset) => [asset.name, asset]),
  );
  const expectedNames = new Set(
    verifiedAssets.flatMap((asset) => [asset.name, asset.digestName]),
  );

  for (const existing of existingAssets.values()) {
    if (
      existing.name.startsWith(`${publicRelease.tag_name}-`) &&
      !expectedNames.has(existing.name)
    ) {
      throw new Error(`Public Release contains unexpected asset "${existing.name}".`);
    }
  }

  const publishedArchives = [];
  for (const asset of verifiedAssets) {
    const files = [
      { name: asset.name, filename: asset.archivePath, archive: true },
      { name: asset.digestName, filename: asset.digestPath, archive: false },
    ];

    let publishedArchive;
    for (const file of files) {
      let published = existingAssets.get(file.name);
      if (published) {
        const localStat = await stat(file.filename);
        if (
          published.size !== localStat.size ||
          !(await sameFileContent(file.filename, published, token, tempDirectory))
        ) {
          throw new Error(`Existing public asset "${file.name}" differs from the source asset.`);
        }
      } else {
        published = await uploadAsset(
          repository,
          publicRelease.id,
          file.filename,
          file.name,
          token,
        );
        existingAssets.set(file.name, published);
      }

      if (file.archive) {
        publishedArchive = published;
      }
    }

    publishedArchives.push({
      name: asset.name,
      os: asset.os,
      arch: asset.arch,
      ...(asset.target ? { target: asset.target } : {}),
      size: asset.size,
      sha256: asset.sha256,
      downloadUrl: publishedArchive.browser_download_url,
    });
  }

  return publishedArchives;
}

async function fileExists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

async function writeImmutableJson(filename, value) {
  const serialized = serializeJson(value);
  if (await fileExists(filename)) {
    const existing = serializeJson(JSON.parse(await readFile(filename, "utf8")));
    if (existing !== serialized) {
      throw new Error(`Immutable metadata "${path.relative(WORKSPACE, filename)}" already differs.`);
    }
    return false;
  }

  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, serialized, "utf8");
  return true;
}

async function updateLatest(packageId, releaseDocument) {
  if (releaseDocument.prerelease) {
    return false;
  }

  const latestPath = path.join(WORKSPACE, "packages", packageId, "latest.json");
  if (await fileExists(latestPath)) {
    const existing = JSON.parse(await readFile(latestPath, "utf8"));
    validatePackageId(existing.package);
    if (existing.package !== packageId) {
      throw new Error(`Latest metadata path for "${packageId}" belongs to another package.`);
    }

    const comparison = compareSemver(releaseDocument.version, existing.version);
    if (comparison < 0) {
      return false;
    }
    if (comparison === 0) {
      const currentSerialized = serializeJson(existing);
      const nextSerialized = serializeJson(releaseDocument);
      if (currentSerialized !== nextSerialized) {
        throw new Error(`Latest metadata for "${packageId}" differs at the same version.`);
      }
      return false;
    }
  }

  await mkdir(path.dirname(latestPath), { recursive: true });
  await writeFile(latestPath, serializeJson(releaseDocument), "utf8");
  return true;
}

async function regenerateIndex() {
  const packagesDirectory = path.join(WORKSPACE, "packages");
  let entries = [];
  try {
    entries = await readdir(packagesDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    validatePackageId(entry.name);
    const latestPath = path.join(packagesDirectory, entry.name, "latest.json");
    if (!(await fileExists(latestPath))) {
      continue;
    }

    const latest = JSON.parse(await readFile(latestPath, "utf8"));
    if (latest.package !== entry.name) {
      throw new Error(`Latest metadata for "${entry.name}" has a mismatched package ID.`);
    }
    versionFromTag(`v${latest.version}`);
    if (Number.isNaN(Date.parse(latest.publishedAt))) {
      throw new Error(`Latest metadata for "${entry.name}" has an invalid publication date.`);
    }

    packages.push({
      id: entry.name,
      version: latest.version,
      latest: `packages/${entry.name}/latest.json`,
      publishedAt: latest.publishedAt,
    });
  }

  packages.sort((left, right) => left.id.localeCompare(right.id));
  const generatedAt =
    packages.length > 0
      ? new Date(
          Math.max(...packages.map((item) => Date.parse(item.publishedAt))),
        ).toISOString()
      : new Date(0).toISOString();

  const index = {
    schemaVersion: 1,
    generatedAt,
    packages: packages.map(({ id, version, latest }) => ({ id, version, latest })),
  };
  await writeFile(path.join(WORKSPACE, "index.json"), serializeJson(index), "utf8");
}

async function writeOutputs(packageId, version, publicTag) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    return;
  }
  await appendFile(
    outputFile,
    `package=${packageId}\nversion=${version}\npublic_tag=${publicTag}\n`,
    "utf8",
  );
}

async function main() {
  const sourceToken = requiredEnvironment("SOURCE_REPOSITORY_TOKEN");
  const targetToken = requiredEnvironment("TARGET_REPOSITORY_TOKEN");
  const targetRepository = requiredEnvironment("GITHUB_REPOSITORY");
  validateRepository(targetRepository);

  const [payload, registryConfig] = await Promise.all([
    readEventPayload(),
    loadRegistryConfig(),
  ]);
  const packageConfig = registryConfig.packages[payload.package];
  if (!packageConfig) {
    throw new Error(`Package "${payload.package}" is not registered.`);
  }

  const sourceMap = parseSourceMap(requiredEnvironment("PACKAGE_SOURCES_JSON"));
  const sourceRepository = sourceMap[payload.package];
  if (!sourceRepository) {
    throw new Error(`Private source mapping for "${payload.package}" is missing.`);
  }
  process.stdout.write(`::add-mask::${sourceRepository}\n`);

  const sourceRelease = await requestJson(
    `${API_BASE_URL}/repos/${apiRepositoryPath(sourceRepository)}` +
      `/releases/${payload.source.releaseId}`,
    sourceToken,
    { label: "Reading the private source Release" },
  );

  if (sourceRelease.tag_name !== payload.source.tag) {
    throw new Error("Private source Release tag does not match the dispatch payload.");
  }
  if (sourceRelease.draft) {
    throw new Error("Private source Release must be published before dispatch.");
  }
  if (sourceRelease.prerelease && !packageConfig.publishPrereleases) {
    throw new Error(`Prereleases are disabled for package "${payload.package}".`);
  }
  if (
    typeof sourceRelease.published_at !== "string" ||
    Number.isNaN(Date.parse(sourceRelease.published_at))
  ) {
    throw new Error("Private source Release has an invalid publication date.");
  }

  const version = versionFromTag(sourceRelease.tag_name);
  const changelog = extractPublicChangelog(sourceRelease.body || "");
  const assetSpecs = renderAssetSpecs(packageConfig, version);
  const sourceAssets = collectSourceAssets(sourceRelease, assetSpecs);
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "package-publish-"));

  try {
    const verifiedAssets = await downloadAndVerifyAssets(
      sourceAssets,
      sourceToken,
      tempDirectory,
    );
    const publicRelease = await getOrCreatePublicRelease({
      repository: targetRepository,
      packageId: payload.package,
      version,
      changelog,
      prerelease: Boolean(sourceRelease.prerelease),
      token: targetToken,
    });
    const publishedAssets = await publishAssets({
      repository: targetRepository,
      publicRelease,
      verifiedAssets,
      token: targetToken,
      tempDirectory,
    });

    const releaseDocument = {
      schemaVersion: 1,
      package: payload.package,
      version,
      publishedAt: sourceRelease.published_at,
      prerelease: Boolean(sourceRelease.prerelease),
      release: {
        tag: publicRelease.tag_name,
        url: publicRelease.html_url,
      },
      changelog: {
        format: "markdown",
        content: changelog,
      },
      assets: publishedAssets,
    };

    const versionPath = path.join(
      WORKSPACE,
      "packages",
      payload.package,
      "versions",
      `${version}.json`,
    );
    await writeImmutableJson(versionPath, releaseDocument);
    await updateLatest(payload.package, releaseDocument);
    await regenerateIndex();
    await writeOutputs(payload.package, version, publicRelease.tag_name);

    process.stdout.write(`Published ${payload.package} v${version} metadata.\n`);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`::error::${error.message}\n`);
  process.exitCode = 1;
});
