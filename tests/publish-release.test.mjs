import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const publisher = path.join(repositoryRoot, "scripts", "publish-release.mjs");

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
  });
  response.end(body);
}

test("publishes a private release into public metadata", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "package-publisher-test-"));
  context.after(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  await mkdir(path.join(workspace, "config"), { recursive: true });
  const registryConfig = JSON.parse(
    await readFile(path.join(repositoryRoot, "config", "packages.json"), "utf8"),
  );
  await writeFile(
    path.join(workspace, "config", "packages.json"),
    `${JSON.stringify(registryConfig, null, 2)}\n`,
  );

  const version = "0.1.4";
  const sourceAssetBodies = new Map();
  const sourceAssets = [];
  let sourceAssetId = 1000;

  for (const spec of registryConfig.packages["pt-buddy"].assets) {
    const name = spec.template.replaceAll("{version}", version);
    const archive = Buffer.from(`archive:${name}`);
    const digestName = `${name}.dgst`;
    const digest = Buffer.from(`${sha256(archive)}  ${name}\n`);

    sourceAssetBodies.set(sourceAssetId, archive);
    sourceAssets.push({ id: sourceAssetId, name, size: archive.length });
    sourceAssetId += 1;
    sourceAssetBodies.set(sourceAssetId, digest);
    sourceAssets.push({ id: sourceAssetId, name: digestName, size: digest.length });
    sourceAssetId += 1;
  }

  let publicRelease;
  const publicAssetBodies = new Map();
  let publicAssetId = 2000;
  let serverError;

  const server = http.createServer((request, response) => {
    const handle = async () => {
      const baseUrl = `http://${request.headers.host}`;
      const url = new URL(request.url, baseUrl);

      if (
        request.method === "GET" &&
        url.pathname === "/repos/private-owner/pt-buddy/releases/123456789"
      ) {
        sendJson(response, 200, {
          id: 123456789,
          tag_name: "v0.1.4",
          draft: false,
          prerelease: false,
          published_at: "2026-07-31T12:00:00Z",
          body: "## Changes\n\n- Public change.\n\n## What's Changed\n\n- Private commit.",
          assets: sourceAssets.map((asset) => ({
            ...asset,
            url: `${baseUrl}/source-assets/${asset.id}`,
          })),
        });
        return;
      }

      const sourceAssetMatch = /^\/source-assets\/([0-9]+)$/.exec(url.pathname);
      if (request.method === "GET" && sourceAssetMatch) {
        const body = sourceAssetBodies.get(Number(sourceAssetMatch[1]));
        response.writeHead(body ? 200 : 404, {
          "Content-Type": "application/octet-stream",
          "Content-Length": body?.length || 0,
        });
        response.end(body);
        return;
      }

      if (
        request.method === "GET" &&
        url.pathname ===
          "/repos/ai-gens/packages/releases/tags/pt-buddy-v0.1.4"
      ) {
        if (!publicRelease) {
          sendJson(response, 404, { message: "Not Found" });
          return;
        }
        sendJson(response, 200, publicRelease);
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/repos/ai-gens/packages/releases"
      ) {
        const input = JSON.parse((await readRequestBody(request)).toString("utf8"));
        publicRelease = {
          id: 987654321,
          tag_name: input.tag_name,
          draft: input.draft,
          prerelease: input.prerelease,
          body: input.body,
          html_url:
            "https://github.com/ai-gens/packages/releases/tag/pt-buddy-v0.1.4",
          assets: [],
        };
        sendJson(response, 201, publicRelease);
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/repos/ai-gens/packages/releases/987654321/assets"
      ) {
        const name = url.searchParams.get("name");
        const body = await readRequestBody(request);
        const asset = {
          id: publicAssetId,
          name,
          size: body.length,
          url: `${baseUrl}/public-assets/${publicAssetId}`,
          browser_download_url:
            `https://github.com/ai-gens/packages/releases/download/` +
            `pt-buddy-v0.1.4/${encodeURIComponent(name)}`,
        };
        publicAssetBodies.set(publicAssetId, body);
        publicAssetId += 1;
        publicRelease.assets.push(asset);
        sendJson(response, 201, asset);
        return;
      }

      const publicAssetMatch = /^\/public-assets\/([0-9]+)$/.exec(url.pathname);
      if (request.method === "GET" && publicAssetMatch) {
        const body = publicAssetBodies.get(Number(publicAssetMatch[1]));
        response.writeHead(body ? 200 : 404, {
          "Content-Type": "application/octet-stream",
          "Content-Length": body?.length || 0,
        });
        response.end(body);
        return;
      }

      sendJson(response, 404, { message: "Unhandled test endpoint" });
    };

    handle().catch((error) => {
      serverError = error;
      sendJson(response, 500, { message: "Test server failure" });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const eventPath = path.join(workspace, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      client_payload: {
        schemaVersion: 1,
        package: "pt-buddy",
        source: {
          releaseId: 123456789,
          tag: "v0.1.4",
        },
      },
    }),
  );

  const child = spawn(process.execPath, [publisher], {
    cwd: workspace,
    env: {
      ...process.env,
      GITHUB_API_URL: baseUrl,
      GITHUB_UPLOAD_URL: baseUrl,
      GITHUB_EVENT_NAME: "repository_dispatch",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "ai-gens/packages",
      GITHUB_WORKSPACE: workspace,
      PACKAGE_SOURCES_JSON: '{"pt-buddy":"private-owner/pt-buddy"}',
      SOURCE_REPOSITORY_TOKEN: "source-token",
      TARGET_REPOSITORY_TOKEN: "target-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(exitCode, 0, `${stdout}\n${stderr}`);
  assert.equal(serverError, undefined);

  const latest = JSON.parse(
    await readFile(path.join(workspace, "packages", "pt-buddy", "latest.json"), "utf8"),
  );
  assert.equal(latest.package, "pt-buddy");
  assert.equal(latest.version, "0.1.4");
  assert.equal(latest.assets.length, 4);
  assert.equal(latest.assets[0].target, "x86_64-unknown-linux-musl");
  assert.equal(latest.changelog.content, "## Changes\n\n- Public change.");

  const index = JSON.parse(await readFile(path.join(workspace, "index.json"), "utf8"));
  assert.deepEqual(index.packages, [
    {
      id: "pt-buddy",
      version: "0.1.4",
      latest: "packages/pt-buddy/latest.json",
    },
  ]);
  assert.equal(publicRelease.assets.length, 8);
});
