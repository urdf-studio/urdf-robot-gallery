#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve();

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
const galleryRoot = path.resolve(args.get("gallery") || ROOT);
const write = Boolean(args.get("write"));
const reportPath = args.get("report") || path.join(galleryRoot, "docs", "cleanup-report.json");

const previewsRoot = path.join(galleryRoot, "docs", "previews");
const thumbsRoot = path.join(galleryRoot, "docs", "thumbnails");
const manifestPath = path.join(galleryRoot, "docs", "previews.json");

const walkFiles = async (dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath)));
    } else {
      files.push(fullPath);
    }
  }
  return files;
};

const safeRel = (root, filePath) =>
  path.relative(root, filePath).split(path.sep).join("/");

const main = async () => {
  let manifest;
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    manifest = JSON.parse(raw);
  } catch {
    manifest = { previews: [] };
  }
  const previewEntries = Array.isArray(manifest?.previews) ? manifest.previews : [];

  const referenced = new Set();
  for (const entry of previewEntries) {
    for (const key of ["webp", "webm", "mp4", "png"]) {
      const rel = entry?.[key];
      if (typeof rel === "string" && rel.trim()) {
        referenced.add(rel.replace(/^\/+/, ""));
      }
    }
  }

  const orphanFiles = [];
  const missingFiles = [];

  const checkRoot = async (root, prefix) => {
    try {
      const files = await walkFiles(root);
      for (const filePath of files) {
        const rel = `${prefix}/${safeRel(root, filePath)}`;
        if (!referenced.has(rel)) {
          orphanFiles.push(rel);
        }
      }
    } catch {
      // ignore missing dir
    }
  };

  await checkRoot(previewsRoot, "previews");
  await checkRoot(thumbsRoot, "thumbnails");

  for (const rel of referenced) {
    const fullPath = path.join(galleryRoot, "docs", rel);
    try {
      await fs.access(fullPath);
    } catch {
      missingFiles.push(rel);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    orphanFiles,
    missingFiles,
    referencedCount: referenced.size,
  };

  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`[cleanup-previews] Report written: ${reportPath}`);

  if (write && orphanFiles.length) {
    for (const rel of orphanFiles) {
      const fullPath = path.join(galleryRoot, "docs", rel);
      try {
        await fs.unlink(fullPath);
        console.log(`[cleanup-previews] Deleted ${rel}`);
      } catch (error) {
        console.warn(`[cleanup-previews] Failed to delete ${rel}: ${error.message}`);
      }
    }
  }
};

main().catch((error) => {
  console.error("[cleanup-previews] Failed:", error);
  process.exitCode = 1;
});
