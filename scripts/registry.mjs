const PACKAGE_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    assert(allowed.includes(key), `${label} contains unsupported property "${key}".`);
  }
}

export function validatePackageId(packageId) {
  assert(
    typeof packageId === "string" && PACKAGE_ID_PATTERN.test(packageId),
    "Package ID is invalid.",
  );
  return packageId;
}

export function validateRepository(repository) {
  assert(
    typeof repository === "string" && REPOSITORY_PATTERN.test(repository),
    "Registered source repository is invalid.",
  );
  return repository;
}

export function parseSemver(version) {
  assert(typeof version === "string", "Version must be a string.");
  const match = SEMVER_PATTERN.exec(version);
  assert(match, `Version "${version}" is not valid SemVer.`);

  return {
    raw: version,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrereleaseIdentifier(left, right) {
  const leftNumeric = /^[0-9]+$/.test(left);
  const rightNumeric = /^[0-9]+$/.test(right);

  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left.localeCompare(right);
}

export function compareSemver(leftVersion, rightVersion) {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);

  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) {
    return 0;
  }
  if (left.prerelease.length === 0) {
    return 1;
  }
  if (right.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) {
      return -1;
    }
    if (right.prerelease[index] === undefined) {
      return 1;
    }

    const result = comparePrereleaseIdentifier(
      left.prerelease[index],
      right.prerelease[index],
    );
    if (result !== 0) {
      return result;
    }
  }

  return 0;
}

export function versionFromTag(tag) {
  assert(typeof tag === "string" && tag.startsWith("v"), "Release tag must start with v.");
  const version = tag.slice(1);
  parseSemver(version);
  return version;
}

export function validateDispatchPayload(payload) {
  assert(payload && typeof payload === "object" && !Array.isArray(payload), "Dispatch payload is invalid.");
  assertExactKeys(payload, ["schemaVersion", "package", "source"], "Dispatch payload");
  assert(payload.schemaVersion === 1, "Unsupported dispatch schema version.");
  validatePackageId(payload.package);

  const source = payload.source;
  assert(source && typeof source === "object" && !Array.isArray(source), "Dispatch source is invalid.");
  assertExactKeys(source, ["releaseId", "tag"], "Dispatch source");
  assert(
    Number.isSafeInteger(source.releaseId) && source.releaseId > 0,
    "Release ID must be a positive integer.",
  );
  assert(
    typeof source.tag === "string" && source.tag.length > 0 && source.tag.length <= 255,
    "Release tag is invalid.",
  );

  return payload;
}

export function validateRegistryConfig(config) {
  assert(config && typeof config === "object" && !Array.isArray(config), "Registry configuration is invalid.");
  assertExactKeys(config, ["schemaVersion", "packages"], "Registry configuration");
  assert(config.schemaVersion === 1, "Unsupported registry configuration version.");
  assert(
    config.packages && typeof config.packages === "object" && !Array.isArray(config.packages),
    "Registry packages must be an object.",
  );

  for (const [packageId, packageConfig] of Object.entries(config.packages)) {
    validatePackageId(packageId);
    assert(
      packageConfig && typeof packageConfig === "object" && !Array.isArray(packageConfig),
      `Configuration for "${packageId}" is invalid.`,
    );
    assertExactKeys(
      packageConfig,
      ["publishPrereleases", "assets"],
      `Configuration for "${packageId}"`,
    );
    assert(
      typeof packageConfig.publishPrereleases === "boolean",
      `publishPrereleases for "${packageId}" must be a boolean.`,
    );
    assert(
      Array.isArray(packageConfig.assets) && packageConfig.assets.length > 0,
      `Package "${packageId}" must define at least one asset.`,
    );

    const templates = new Set();
    for (const asset of packageConfig.assets) {
      assert(asset && typeof asset === "object" && !Array.isArray(asset), "Asset configuration is invalid.");
      assertExactKeys(asset, ["template", "os", "arch", "target"], "Asset configuration");
      assert(
        typeof asset.template === "string" &&
          asset.template.includes("{version}") &&
          !asset.template.includes("/") &&
          !asset.template.includes("\\"),
        `Asset template for "${packageId}" is invalid.`,
      );
      assert(!templates.has(asset.template), `Duplicate asset template "${asset.template}".`);
      templates.add(asset.template);
      assert(typeof asset.os === "string" && PACKAGE_ID_PATTERN.test(asset.os), "Asset OS is invalid.");
      assert(typeof asset.arch === "string" && PACKAGE_ID_PATTERN.test(asset.arch), "Asset architecture is invalid.");
      if (asset.target !== undefined) {
        assert(typeof asset.target === "string" && asset.target.length > 0, "Asset target is invalid.");
      }
    }
  }

  return config;
}

export function parseSourceMap(serialized) {
  assert(typeof serialized === "string" && serialized.length > 0, "PACKAGE_SOURCES_JSON is missing.");

  let sourceMap;
  try {
    sourceMap = JSON.parse(serialized);
  } catch {
    throw new Error("PACKAGE_SOURCES_JSON is not valid JSON.");
  }

  assert(sourceMap && typeof sourceMap === "object" && !Array.isArray(sourceMap), "Package source map is invalid.");
  for (const [packageId, repository] of Object.entries(sourceMap)) {
    validatePackageId(packageId);
    validateRepository(repository);
  }
  return sourceMap;
}

export function extractPublicChangelog(body) {
  assert(typeof body === "string", "Source Release body is missing.");
  const marker = body.search(/^## What's Changed\s*$/im);
  const changelog = (marker >= 0 ? body.slice(0, marker) : body).trim();
  assert(changelog.length > 0, "Source Release does not contain a public changelog.");
  return changelog;
}

function basename(filename) {
  return filename.replaceAll("\\", "/").split("/").at(-1);
}

export function parseDigest(content, expectedFilename) {
  assert(typeof content === "string", "Digest file is invalid.");
  const normalized = content.trim();

  const sumStyle = /^([A-Fa-f0-9]{64})\s+\*?(.+)$/.exec(normalized);
  if (sumStyle) {
    assert(
      basename(sumStyle[2].trim()) === expectedFilename,
      `Digest file references "${sumStyle[2].trim()}" instead of "${expectedFilename}".`,
    );
    return sumStyle[1].toLowerCase();
  }

  const bsdStyle = /^SHA256\s+\((.+)\)\s+=\s+([A-Fa-f0-9]{64})$/i.exec(normalized);
  if (bsdStyle) {
    assert(
      basename(bsdStyle[1].trim()) === expectedFilename,
      `Digest file references "${bsdStyle[1].trim()}" instead of "${expectedFilename}".`,
    );
    return bsdStyle[2].toLowerCase();
  }

  throw new Error("Digest file does not use a supported SHA-256 format.");
}

export function renderAssetSpecs(packageConfig, version) {
  parseSemver(version);
  const names = new Set();

  return packageConfig.assets.map((asset) => {
    const name = asset.template.replaceAll("{version}", version);
    assert(!names.has(name), `Duplicate rendered asset name "${name}".`);
    names.add(name);
    return {
      ...asset,
      name,
      digestName: `${name}.dgst`,
    };
  });
}

export function validateSha256(value) {
  assert(typeof value === "string" && SHA256_PATTERN.test(value), "SHA-256 digest is invalid.");
  return value;
}

export function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
