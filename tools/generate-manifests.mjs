#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve();
const ROBOTS_PATH = path.join(ROOT, "docs", "robots.json");
const MANIFEST_ROOT = path.join(ROOT, "docs", "manifests");

const parseArgs = () => {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = process.argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, true);
    }
  }
  return args;
};

const args = parseArgs();
const only = new Set(
  String(args.get("only") || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);
const force = Boolean(args.get("force"));
const dryRun = Boolean(args.get("dry-run"));

const slugify = (value) =>
  value
    .trim()
    .replace(/\.urdf$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

const hashString = (value) => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const toPreviewBase = (value) => {
  const normalized = value.replace(/\\/g, "/").replace(/\.urdf$/i, "");
  const name = normalized.split("/").pop() || normalized;
  const slug = slugify(name) || "robot";
  return `${slug}--${hashString(normalized)}`;
};

const ensureDir = async (dir) => {
  await fs.mkdir(dir, { recursive: true });
};

const main = async () => {
  const raw = await fs.readFile(ROBOTS_PATH, "utf8");
  const robotsJson = JSON.parse(raw);
  if (!Array.isArray(robotsJson)) {
    throw new Error("robots.json must be an array");
  }

  let written = 0;
  let skipped = 0;
  const generatedAt = new Date().toISOString();

  for (const entry of robotsJson) {
    const repoKey = (entry.repoKey || entry.repo || "").replace(/^https?:\/\/github\.com\//, "");
    const normalizedRepoKey = repoKey.toLowerCase();
    if (!normalizedRepoKey) continue;
    if (only.size && !only.has(normalizedRepoKey)) continue;

    const robots = Array.isArray(entry.robots) ? entry.robots : [];
    for (const robot of robots) {
      const file = typeof robot === "string" ? robot : robot?.file;
      if (!file) continue;
      const fileBase =
        typeof robot !== "string" && robot?.fileBase
          ? robot.fileBase
          : toPreviewBase(file);
      const manifestDir = path.join(MANIFEST_ROOT, normalizedRepoKey);
      const manifestPath = path.join(manifestDir, `${fileBase}.json`);

      try {
        if (!force) {
          await fs.access(manifestPath);
          skipped += 1;
          continue;
        }
      } catch {
        // file missing, proceed
      }

      const payload = {
        version: 1,
        generatedAt,
        repo: entry.repo || "",
        repoKey: normalizedRepoKey,
        path: entry.path || "",
        robotName: typeof robot === "string" ? "" : robot?.name || "",
        file,
        fileBase,
        sourceUpdatedAt: entry.updatedAt || "",
      };

      if (!dryRun) {
        await ensureDir(manifestDir);
        await fs.writeFile(manifestPath, JSON.stringify(payload, null, 2));
      }
      written += 1;
    }
  }

  console.log(`[manifests] written: ${written}, skipped: ${skipped}`);
  if (dryRun) {
    console.log("[manifests] Dry run; no files written.");
  }
};

main().catch((error) => {
  console.error("[manifests] Failed:", error);
  process.exitCode = 1;
});
