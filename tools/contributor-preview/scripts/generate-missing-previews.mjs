#!/usr/bin/env node
/**
 * Generate missing robot previews without cloning repos.
 *
 * This entry script handles CLI/orchestration only.
 * Discovery, indexing, git helpers, and config building are centralized in
 * scripts/lib/missing-previews-core.mjs.
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/cli.mjs";
import { readJsonFile, writeJsonFile } from "./lib/fs-utils.mjs";
import {
  createGitHubFetch,
  buildAssetIndex,
  detectMissingMap,
  collectRobotsToGenerate,
  chunkItems,
  clearCacheDir,
  runSyncManifest,
  hasGitChanges,
  commitAndPush,
  buildGeneratorConfig,
} from "./lib/missing-previews-core.mjs";

const args = parseArgs();
const galleryRoot = args.get("gallery");
const token = args.get("token") || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const DEFAULT_XACRO_API_BASE_URL = "http://127.0.0.1:8000";
const xacroApiBaseUrlArg =
  args.get("xacro-api-base") ||
  process.env.XACRO_API_BASE_URL ||
  process.env.URDF_STUDIO_API_BASE_URL ||
  DEFAULT_XACRO_API_BASE_URL;
const maxPerRepo = Number(args.get("max-per-repo") || 0);
const keepConfig = Boolean(args.get("keep-config"));
const onlyKeys = new Set(
  (args.get("only") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);
const onlyRepos = new Set(
  (args.get("only-repos") || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);
const concurrency = Math.max(1, Number(args.get("concurrency") || 2));
const commitEach = Boolean(args.get("commit-each"));
const pushEach = Boolean(args.get("push-each") || args.get("commit-each"));
const batchSize = Math.max(0, Number(args.get("batch-size") || 0));
const fastMode = Boolean(args.get("fast"));
const cacheDir = args.get("cache-dir") || "";
const cacheMb = Number(args.get("cache-mb") || 0);
const force = Boolean(args.get("force") || args.get("regenerate"));
const quality = Number(args.get("quality") || 0);
const pixelRatio = Number(args.get("pixel-ratio") || 0);
const size = Number(args.get("size") || 0);
const width = Number(args.get("width") || 0);
const height = Number(args.get("height") || 0);
const frameCount = Number(args.get("frame-count") || 0);
const fps = Number(args.get("fps") || 0);
const timeoutMs = Number(args.get("timeout-ms") || 0);
const githubRequestsPerMinute = Math.max(
  1,
  Number(
    args.get("github-rpm") ||
      process.env.URDF_PREVIEW_GITHUB_MAX_REQUESTS_PER_MINUTE ||
      90
  ) || 90
);

let noBackground = true;
if (args.get("with-background") || args.get("background")) {
  noBackground = false;
}
if (args.get("no-background") || args.get("transparent")) {
  noBackground = true;
}

const saveBackgroundPath = args.get("save-background") || "";
const cacheClean = Boolean(args.get("cache-clean") || args.get("no-cache"));
const formats = (args.get("formats") || "webp")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const allowMp4 = Boolean(args.get("allow-mp4"));
const highQuality = Boolean(args.get("hq") || args.get("high-quality"));
const allowOpaque = Boolean(args.get("allow-opaque"));
const strictAlphaArg = args.get("strict-alpha");
const strictAlpha =
  !allowOpaque &&
  (strictAlphaArg === undefined || !["0", "false", "no"].includes(String(strictAlphaArg).toLowerCase()));

if (formats.includes("mp4") && !allowMp4) {
  console.error(
    "[missing-previews] Refusing to generate mp4 without --allow-mp4. Use webm for transparency."
  );
  process.exit(1);
}

if (formats.includes("webm") && noBackground && strictAlpha) {
  console.log(
    "[missing-previews] Note: strict alpha may drop webm outputs that do not preserve alpha; webp remains available."
  );
}

if (!galleryRoot) {
  console.error("[missing-previews] --gallery is required");
  process.exit(1);
}

const robotsPath = path.join(galleryRoot, "docs/robots.json");
const previewsPath = path.join(galleryRoot, "docs/previews.json");
const previewsRoot = path.join(galleryRoot, "docs", "previews");
const thumbnailsRoot = path.join(galleryRoot, "docs", "thumbnails");
const PREVIEW_METADATA_FIELDS = [
  "sourceType",
  "meshCount",
  "linkCount",
  "jointCount",
  "armCount",
  "legCount",
  "wheelCount",
  "tags",
];

const buildGeneratorArgs = (tmpConfigPath, tmpManifestPath) => {
  const generatorArgs = [
    "--config",
    tmpConfigPath,
    "--manifest-out",
    tmpManifestPath,
    "--preview-dir",
    previewsRoot,
    "--thumb-dir",
    thumbnailsRoot,
    "--concurrency",
    String(concurrency),
  ];

  if (fastMode) generatorArgs.push("--fast");
  if (noBackground) generatorArgs.push("--no-background");
  if (saveBackgroundPath) generatorArgs.push("--save-background", saveBackgroundPath);
  if (cacheDir) generatorArgs.push("--cache-dir", cacheDir);
  if (cacheMb > 0) generatorArgs.push("--cache-mb", String(cacheMb));
  if (cacheClean) generatorArgs.push("--cache-clean");

  return generatorArgs;
};

const resolveGeneratorPath = () => {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve("scripts/generate-robot-previews.mjs"),
    path.resolve("tools/contributor-preview/scripts/generate-robot-previews.mjs"),
    path.join(scriptDir, "generate-robot-previews.mjs"),
  ];
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `[missing-previews] Could not locate generate-robot-previews.mjs. Tried: ${candidates.join(", ")}`
  );
};

const mergeBatchPreviewMetadata = async (batchManifestPath) => {
  const batchManifest = await readJsonFile(batchManifestPath, null);
  const batchEntries = Array.isArray(batchManifest?.previews) ? batchManifest.previews : [];
  if (batchEntries.length === 0) return;

  const manifest = await readJsonFile(previewsPath, { previews: [] });
  const entries = Array.isArray(manifest?.previews) ? manifest.previews : [];
  const byKey = new Map();
  for (const entry of entries) {
    const repoKey = entry?.repoKey || "";
    const fileBase = entry?.fileBase || "";
    if (!repoKey || !fileBase) continue;
    byKey.set(`${repoKey}::${fileBase}`, entry);
  }

  let merged = 0;
  let inserted = 0;
  for (const sourceEntry of batchEntries) {
    const repoKey = sourceEntry?.repoKey || "";
    const fileBase = sourceEntry?.fileBase || "";
    if (!repoKey || !fileBase) continue;

    const key = `${repoKey}::${fileBase}`;
    const targetEntry = byKey.get(key) || { repoKey, fileBase };
    const wasExisting = byKey.has(key);
    let changed = !wasExisting;

    for (const field of PREVIEW_METADATA_FIELDS) {
      const sourceValue = sourceEntry[field];
      if (sourceValue === undefined) continue;

      if (field === "tags") {
        if (!Array.isArray(sourceValue)) continue;
        const tags = Array.from(
          new Set(
            sourceValue
              .filter((tag) => typeof tag === "string" && tag.trim().length > 0)
              .map((tag) => tag.trim())
          )
        );
        if (tags.length === 0) continue;
        if (JSON.stringify(targetEntry.tags || []) !== JSON.stringify(tags)) {
          targetEntry.tags = tags;
          changed = true;
        }
        continue;
      }

      if (targetEntry[field] !== sourceValue) {
        targetEntry[field] = sourceValue;
        changed = true;
      }
    }

    if (!wasExisting) {
      entries.push(targetEntry);
      byKey.set(key, targetEntry);
      inserted += 1;
    }
    if (changed) {
      merged += 1;
    }
  }

  if (merged > 0) {
    manifest.generatedAt = new Date().toISOString();
    manifest.previews = entries;
    await writeJsonFile(previewsPath, manifest);
    console.log(
      `[missing-previews] Merged metadata for ${merged} previews from batch manifest (${inserted} inserted).`
    );
  }
};

const resolveXacroApiBaseUrl = async (baseUrl) => {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("[missing-previews] Xacro API base URL is required.");
  }

  try {
    const response = await fetch(`${normalized}/health`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return normalized;
  } catch (error) {
    throw new Error(
      `[missing-previews] Xacro API unavailable at ${normalized} (${error?.message || error})`
    );
  }
};

const main = async () => {
  const resolvedXacroApiBaseUrl = await resolveXacroApiBaseUrl(xacroApiBaseUrlArg);

  const robotsJson = await readJsonFile(robotsPath, []);
  if (!Array.isArray(robotsJson)) {
    throw new Error("robots.json must be an array");
  }

  await readJsonFile(previewsPath, { previews: [] });

  const assetsIndex = await buildAssetIndex({ previewsRoot, thumbnailsRoot });
  const missingMap = detectMissingMap({
    robotsJson,
    onlyKeys,
    onlyRepos,
    force,
    formats,
    assetsIndex,
  });

  if (missingMap.size === 0) {
    console.log("[missing-previews] No missing previews found.");
    const synced = runSyncManifest(galleryRoot);
    if (!synced) {
      process.exit(1);
    }
    return;
  }

  const githubFetch = createGitHubFetch(token, {
    maxRequestsPerMinute: githubRequestsPerMinute,
  });
  const robots = await collectRobotsToGenerate({
    missingMap,
    maxPerRepo,
    githubFetch,
    token,
    xacroApiBaseUrl: resolvedXacroApiBaseUrl,
  });
  if (typeof githubFetch.getStats === "function") {
    const stats = githubFetch.getStats();
    console.log(
      `[missing-previews] GitHub API usage: network=${stats.networkRequests}, unique=${stats.uniqueUrls}, ` +
        `cache-hits=${stats.cacheHits}, retries=${stats.retries}, rpm-cap=${stats.maxRequestsPerMinute}, ` +
        `rate-waits=${stats.rateLimitedWaitCount}, rate-wait-ms=${stats.rateLimitedWaitMs}`
    );
  }

  if (robots.length === 0) {
    console.log("[missing-previews] Nothing to generate after filtering.");
    return;
  }

  console.log(
    `[missing-previews] Alpha contract: ${noBackground && strictAlpha ? "strict transparent" : "non-strict"}`
  );

  const batches = chunkItems(robots, commitEach && !batchSize ? 1 : batchSize);
  const generatorPath = resolveGeneratorPath();

  for (const batch of batches) {
    const config = buildGeneratorConfig({
      robots: batch,
      formats,
      fastMode,
      noBackground,
      strictAlpha,
      highQuality,
      explicit: {
        quality,
        pixelRatio,
        size,
        width,
        height,
        frameCount,
        fps,
        timeoutMs,
      },
    });

    const tmpConfigPath = path.join(
      os.tmpdir(),
      `preview-missing-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    const tmpManifestPath = path.join(
      os.tmpdir(),
      `preview-missing-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    await fs.writeFile(tmpConfigPath, JSON.stringify(config, null, 2));

    const result = spawnSync("node", [generatorPath, ...buildGeneratorArgs(tmpConfigPath, tmpManifestPath)], {
      stdio: "inherit",
    });

    if (!keepConfig) {
      await fs.unlink(tmpConfigPath);
    }

    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }

    await mergeBatchPreviewMetadata(tmpManifestPath);
    await fs.rm(tmpManifestPath, { force: true });

    const synced = runSyncManifest(galleryRoot);
    if (!synced) {
      process.exit(1);
    }

    if (commitEach && hasGitChanges(galleryRoot)) {
      const label =
        batch.length === 1
          ? `${batch[0].repoKey || "repo"}:${batch[0].fileBase || batch[0].id || "robot"}`
          : `${batch.length} robots`;
      const message = `Add preview assets (${label})`;
      const committed = commitAndPush({
        galleryRoot,
        message,
        shouldPush: pushEach,
      });
      if (!committed) {
        process.exit(1);
      }
    }

    if (cacheClean && cacheDir) {
      await clearCacheDir(cacheDir);
      console.log(`[missing-previews] Cache cleared: ${cacheDir}`);
    }
  }
};

main().catch((error) => {
  console.error("[missing-previews] Fatal error:", error.message);
  process.exit(1);
});
