import assert from "node:assert/strict";
import test from "node:test";

import {
  compareSemver,
  extractPublicChangelog,
  parseDigest,
  parseSourceMap,
  renderAssetSpecs,
  validateDispatchPayload,
  validateRegistryConfig,
  versionFromTag,
} from "../scripts/registry.mjs";

test("validates the minimal dispatch payload", () => {
  const payload = {
    schemaVersion: 1,
    package: "pt-buddy",
    source: {
      releaseId: 123456789,
      tag: "v0.1.4",
    },
  };

  assert.equal(validateDispatchPayload(payload), payload);
});

test("rejects source repository names in the public dispatch contract", () => {
  assert.throws(
    () =>
      validateDispatchPayload({
        schemaVersion: 1,
        package: "pt-buddy",
        source: {
          repository: "private-owner/pt-buddy",
          releaseId: 123456789,
          tag: "v0.1.4",
        },
      }),
    /unsupported property/,
  );
});

test("compares stable and prerelease SemVer values", () => {
  assert.ok(compareSemver("0.1.4", "0.1.3") > 0);
  assert.ok(compareSemver("1.0.0", "1.0.0-rc.1") > 0);
  assert.ok(compareSemver("1.0.0-rc.2", "1.0.0-rc.1") > 0);
  assert.equal(compareSemver("1.0.0+build.2", "1.0.0+build.1"), 0);
  assert.equal(versionFromTag("v0.1.4"), "0.1.4");
});

test("extracts only the public changelog section", () => {
  const body = "## Changes\n\n- Public change.\n\n## What's Changed\n\n- Internal commit.";
  assert.equal(extractPublicChangelog(body), "## Changes\n\n- Public change.");
});

test("parses sha256sum digest files", () => {
  const hash = "0123456789abcdef".repeat(4);
  assert.equal(parseDigest(`${hash}  package.zip\n`, "package.zip"), hash);
  assert.throws(
    () => parseDigest(`${hash}  another.zip\n`, "package.zip"),
    /instead of/,
  );
});

test("validates private source mappings without exposing them in config", () => {
  assert.deepEqual(parseSourceMap('{"pt-buddy":"private-owner/pt-buddy"}'), {
    "pt-buddy": "private-owner/pt-buddy",
  });
});

test("renders all configured platform assets", () => {
  const config = validateRegistryConfig({
    schemaVersion: 1,
    packages: {
      "pt-buddy": {
        publishPrereleases: false,
        assets: [
          {
            template: "pt-buddy-v{version}-linux-amd64.zip",
            os: "linux",
            arch: "amd64",
            target: "x86_64-unknown-linux-musl",
          },
        ],
      },
    },
  });

  assert.deepEqual(renderAssetSpecs(config.packages["pt-buddy"], "0.1.4"), [
    {
      template: "pt-buddy-v{version}-linux-amd64.zip",
      os: "linux",
      arch: "amd64",
      target: "x86_64-unknown-linux-musl",
      name: "pt-buddy-v0.1.4-linux-amd64.zip",
      digestName: "pt-buddy-v0.1.4-linux-amd64.zip.dgst",
    },
  ]);
});
