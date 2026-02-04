#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";

const ROOT = path.resolve();
const ROBOTS_PATH = path.join(ROOT, "docs", "robots.json");
const META_PATH = path.join(ROOT, "docs", "robots.meta.json");

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
const token = args.get("token") || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const only = new Set(
  String(args.get("only") || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);
const limit = Number(args.get("limit") || 0);
const write = Boolean(args.get("write"));
const reportPath = args.get("report") || path.join(ROOT, "docs", "refresh-report.json");
const concurrency = Math.max(1, Number(args.get("concurrency") || 2));
const maxRetries = Math.max(0, Number(args.get("retries") || 3));
const retryDelayMs = Math.max(250, Number(args.get("retry-delay-ms") || 1000));

const normalizeRepoKey = (value) =>
  value
    ? value
        .replace(/^https?:\/\/github\.com\//, "")
        .split("/")
        .slice(0, 2)
        .join("/")
        .toLowerCase()
    : "";

const parseRepo = (repoUrl) => {
  if (!repoUrl) return null;
  const cleaned = repoUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/i, "");
  const [owner, repo] = cleaned.split("/");
  if (!owner || !repo) return null;
  return { owner, repo };
};

const pickBestPath = (paths, preferredPrefix, originalPath) => {
  if (!Array.isArray(paths) || paths.length === 0) return "";
  let candidates = paths;
  if (preferredPrefix) {
    const prefix = preferredPrefix.replace(/^\/+|\/+$/g, "");
    const scoped = paths.filter((p) => p.startsWith(`${prefix}/`));
    if (scoped.length) candidates = scoped;
  }
  if (originalPath && originalPath.includes("/")) {
    const normalized = originalPath.replace(/\\/g, "/").replace(/^\/+/, "");
    const sameDir = candidates.filter((p) => p.includes(path.posix.dirname(normalized)));
    if (sameDir.length) candidates = sameDir;
  }
  return [...candidates].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const githubFetchOnce = (url) =>
  new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "urdf-robot-gallery-refresh",
          ...(token ? { Authorization: `token ${token}` } : {}),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          const error = new Error(`GitHub API ${res.statusCode} for ${url}`);
          error.statusCode = res.statusCode;
          error.headers = res.headers;
          res.resume();
          reject(error);
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on("error", reject);
  });

const githubFetch = async (url) => {
  let attempt = 0;
  while (true) {
    try {
      return await githubFetchOnce(url);
    } catch (error) {
      attempt += 1;
      const status = error.statusCode || 0;
      const headers = error.headers || {};
      const remaining = Number(headers["x-ratelimit-remaining"] || "");
      const reset = Number(headers["x-ratelimit-reset"] || "");
      if (status === 403 && Number.isFinite(remaining) && remaining === 0 && reset) {
        const waitMs = Math.max(reset * 1000 - Date.now() + 1000, retryDelayMs);
        console.warn(`[refresh] rate limit hit, waiting ${Math.ceil(waitMs / 1000)}s`);
        await sleep(waitMs);
        continue;
      }
      const retryable = [429, 500, 502, 503, 504].includes(status);
      if (!retryable || attempt > maxRetries) {
        throw error;
      }
      const delay = retryDelayMs * Math.pow(2, attempt - 1);
      console.warn(`[refresh] retry ${attempt}/${maxRetries} after ${delay}ms (${status || "err"})`);
      await sleep(delay);
    }
  }
};

const main = async () => {
  const raw = await fs.readFile(ROBOTS_PATH, "utf8");
  const robotsJson = JSON.parse(raw);
  if (!Array.isArray(robotsJson)) {
    throw new Error("robots.json must be an array");
  }

  const report = {
    generatedAt: new Date().toISOString(),
    removedRepos: [],
    missingFiles: [],
    truncated: [],
    updatedRepos: [],
  };

  const entries = robotsJson.filter((entry) => {
    const repoKey = normalizeRepoKey(entry.repo || entry.repoKey);
    if (!repoKey) return false;
    if (only.size && !only.has(repoKey)) return false;
    return true;
  });
  const limitedEntries = limit > 0 ? entries.slice(0, limit) : entries;

  const processEntry = async (entry) => {
    const repoKey = normalizeRepoKey(entry.repo || entry.repoKey);
    if (!repoKey) return { keep: true };
    const repoInfo = parseRepo(entry.repo);
    if (!repoInfo) return { keep: true };

    let repoData;
    try {
      repoData = await githubFetch(`https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}`);
    } catch (error) {
      report.missingFiles.push({
        repoKey,
        reason: `repo fetch failed: ${error.message}`,
      });
      return { keep: true };
    }

    const branch = repoData.default_branch || "main";
    let treeData;
    try {
      treeData = await githubFetch(
        `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
      );
    } catch (error) {
      report.missingFiles.push({
        repoKey,
        reason: `tree fetch failed: ${error.message}`,
      });
      return { keep: true };
    }

    if (treeData.truncated) {
      report.truncated.push(repoKey);
      return { keep: true };
    }

    const treePaths = (treeData.tree || [])
      .filter((node) => node?.path && node?.type === "blob")
      .map((node) => node.path);

    const normalizedPath = entry.path ? entry.path.replace(/^\/+|\/+$/g, "") : "";
    const hasPrefix = normalizedPath
      ? treePaths.some((p) => p.startsWith(`${normalizedPath}/`))
      : false;
    const normalizedTreePaths = normalizedPath && !hasPrefix
      ? treePaths.map((p) => `${normalizedPath}/${p}`)
      : treePaths;

    const urdfPaths = normalizedTreePaths.filter((p) => p.toLowerCase().endsWith(".urdf"));
    if (urdfPaths.length === 0) {
      report.removedRepos.push(repoKey);
      return { keep: false };
    }

    const urdfByPath = new Map();
    const urdfByName = new Map();
    for (const p of urdfPaths) {
      urdfByPath.set(p.toLowerCase(), p);
      const name = path.posix.basename(p).toLowerCase();
      if (!urdfByName.has(name)) urdfByName.set(name, []);
      urdfByName.get(name).push(p);
    }

    const robots = Array.isArray(entry.robots) ? entry.robots : [];
    const matchedPaths = new Set();
    const updatedRobots = [];
    for (const robot of robots) {
      if (!robot) continue;
      const isString = typeof robot === "string";
      const rawFile = (isString ? robot : robot.file || "").replace(/\\/g, "/").replace(/^\/+/, "");
      if (!rawFile) continue;
      const direct = urdfByPath.get(rawFile.toLowerCase());
      const nameKey = path.posix.basename(rawFile).toLowerCase();
      const candidate = direct || pickBestPath(urdfByName.get(nameKey), normalizedPath, rawFile);
      if (!candidate) {
        report.missingFiles.push({
          repoKey,
          file: rawFile,
          reason: "not found in tree",
        });
        continue;
      }
      matchedPaths.add(candidate.toLowerCase());
      if (isString) {
        updatedRobots.push(candidate);
      } else {
        updatedRobots.push({
          ...robot,
          file: candidate,
        });
      }
    }

    const sortedExtra = urdfPaths
      .filter((p) => !matchedPaths.has(p.toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
    for (const extra of sortedExtra) {
      updatedRobots.push({
        name: path.posix.basename(extra).replace(/\.urdf$/i, ""),
        file: extra,
      });
    }

    entry.robots = updatedRobots;
    report.updatedRepos.push(repoKey);
    return { keep: true };
  };

  const queue = [...limitedEntries];
  const results = [];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const entry = queue.shift();
      if (!entry) break;
      results.push({ entry, ...(await processEntry(entry)) });
    }
  });
  await Promise.all(workers);

  const keepSet = new Set(results.filter((r) => r.keep).map((r) => r.entry));
  const refreshed = robotsJson.filter((entry) => keepSet.has(entry));

  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`[refresh] Report written: ${reportPath}`);

  if (write) {
    await fs.writeFile(ROBOTS_PATH, JSON.stringify(refreshed, null, 2));
    const meta = {
      version: 1,
      generatedAt: new Date().toISOString(),
      count: refreshed.length,
    };
    await fs.writeFile(META_PATH, JSON.stringify(meta, null, 2));
    console.log(`[refresh] Updated ${ROBOTS_PATH}`);
    console.log(`[refresh] Updated ${META_PATH}`);
  } else {
    console.log("[refresh] Dry run (use --write to apply changes).");
  }
};

main().catch((error) => {
  console.error("[refresh] Failed:", error);
  process.exitCode = 1;
});
