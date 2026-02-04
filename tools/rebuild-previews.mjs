#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve();

const parseArgs = () => {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === "--") {
      args.set("_", process.argv.slice(i + 1));
      break;
    }
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
const studioRoot = args.get("studio") ? path.resolve(args.get("studio")) : "";
const keysFile = path.resolve(args.get("keys-file") || path.join(galleryRoot, "docs", "backfill-preview-keys.txt"));
const dryRun = Boolean(args.get("dry-run"));
const extraArgs = args.get("_") || [];

const main = async () => {
  if (!studioRoot) {
    console.error("[rebuild-previews] --studio is required (path to urdf-star-studio).");
    process.exitCode = 1;
    return;
  }

  const raw = await fs.readFile(keysFile, "utf8");
  const keys = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (keys.length === 0) {
    console.log("[rebuild-previews] No preview keys found.");
    return;
  }

  const generatorPath = path.join(studioRoot, "scripts", "generate-missing-previews.mjs");
  const command = "node";
  const commandArgs = [
    generatorPath,
    "--gallery",
    galleryRoot,
    "--only",
    keys.join(","),
    ...extraArgs,
  ];

  if (dryRun) {
    console.log("[rebuild-previews] Dry run:");
    console.log(`${command} ${commandArgs.join(" ")}`);
    return;
  }

  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
  }
};

main().catch((error) => {
  console.error("[rebuild-previews] Failed:", error);
  process.exitCode = 1;
});
