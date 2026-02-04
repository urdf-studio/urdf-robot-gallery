#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve();
const ROBOTS_JSON = path.join(ROOT, "docs", "robots.json");
const OUTPUT_ROOT = path.join(ROOT, "docs", "thumbnails");
const STUDIO_URL = (process.env.URDF_STUDIO_URL || "http://localhost:5173/").replace(/\/+$/, "/");
const VIEWPORT = 256;

const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(name);
  if (idx === -1) return "";
  return args[idx + 1] || "";
};

const repoFilter = getArg("--repo");
const limit = Number(getArg("--limit") || 0);
const force = args.includes("--force");

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

const readRobots = async () => {
  const raw = await fs.readFile(ROBOTS_JSON, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("robots.json must be an array");
  }
  return parsed;
};

const buildTasks = (repos) => {
  const tasks = [];
  for (const entry of repos) {
    const repoUrl = entry.repo;
    const repoKey = entry.repoKey || repoUrl?.replace(/^https?:\/\/github\.com\//, "").toLowerCase();
    if (!repoUrl || !repoKey) continue;
    if (repoFilter && repoKey !== repoFilter.toLowerCase()) continue;
    const robots = Array.isArray(entry.robots) ? entry.robots : [];
    for (const robot of robots) {
      const file = typeof robot === "string" ? robot : robot.file || robot.name || "";
      const name = typeof robot === "string" ? robot : robot.name || robot.file || "";
      const fileBase = typeof robot === "string" ? "" : robot.fileBase || "";
      if (!file && !name) continue;
      const baseTarget = file || name;
      const baseName = fileBase || toPreviewBase(baseTarget || name);
      if (!baseName) continue;
      tasks.push({
        repoUrl,
        repoKey,
        baseName,
        fileTarget: baseTarget,
      });
    }
  }
  return tasks;
};

const ensureDir = async (dir) => {
  await fs.mkdir(dir, { recursive: true });
};

const fileExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const run = async () => {
  const repos = await readRobots();
  const tasks = buildTasks(repos);
  const finalTasks = limit > 0 ? tasks.slice(0, limit) : tasks;

  if (finalTasks.length === 0) {
    console.log("No robots to render.");
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: VIEWPORT, height: VIEWPORT },
    deviceScaleFactor: 1,
  });

  let completed = 0;
  for (const task of finalTasks) {
    const outDir = path.join(OUTPUT_ROOT, task.repoKey);
    const outFile = path.join(outDir, `${task.baseName}.png`);
    if (!force && (await fileExists(outFile))) {
      console.log(`skip ${task.repoKey}/${task.baseName} (exists)`);
      continue;
    }

    const page = await context.newPage();
    const url = `${STUDIO_URL}?thumbnail=1&github=${encodeURIComponent(task.repoUrl)}&urdf=${encodeURIComponent(task.fileTarget)}`;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForFunction(() => window.__URDF_THUMB_READY__ === true, {
        timeout: 120000,
      });
      const error = await page.evaluate(() => window.__URDF_THUMB_ERROR__ || "");
      if (error) {
        throw new Error(error);
      }
      const canvas = await page.$("#urdf-thumb-canvas");
      if (!canvas) {
        throw new Error("Thumbnail canvas not found");
      }
      await ensureDir(outDir);
      await canvas.screenshot({ path: outFile, omitBackground: true });
      completed += 1;
      console.log(`done ${task.repoKey}/${task.baseName}`);
    } catch (error) {
      console.error(`fail ${task.repoKey}/${task.baseName}:`, error.message || error);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  console.log(`Rendered ${completed}/${finalTasks.length} thumbnails.`);
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
