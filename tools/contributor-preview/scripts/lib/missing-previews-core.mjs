import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fetchGitHubApiJson } from "./github-api.mjs";
import { detectRobotSourceType, stripRobotSourceExtension } from "./robot-source-type.mjs";
import {
  buildXacroExpandRequestPayload,
  buildXacroFilenameCandidates,
  isXacroPath,
  isUrdfXacroPath,
  isXacroSupportPath,
  normalizeExpandedUrdfPath,
  parseXacroExpandResponsePayload,
} from "./xacro-expand-contract.mjs";
import { SUPPORTED_MESH_EXTENSIONS, isSupportedMeshExtension } from "./mesh-formats.mjs";
import { toMeshReferenceKey } from "./mesh-reference-key.mjs";

let prettyUrdfResolverPromise = null;

export const slugify = (value) =>
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

export const toPreviewBase = (value) => {
  const normalized = value.replace(/\\/g, "/").replace(/\.urdf$/i, "");
  const name = path.posix.basename(normalized) || normalized;
  const slug = slugify(name) || "robot";
  return `${slug}--${hashString(normalized)}`;
};

export const normalizeMeshPathForMatch = (value) =>
  value.trim().replace(/\\/g, "/").replace(/^\/+/, "");

export const parseRepoParts = (repoUrl, repoKey) => {
  if (repoUrl) {
    const cleaned = repoUrl.replace(/^https?:\/\/github\.com\//, "");
    const [owner, repo] = cleaned.split("/");
    if (owner && repo) {
      return { owner, repo };
    }
  }
  if (repoKey && repoKey.includes("/")) {
    const [owner, repo] = repoKey.split("/");
    return { owner, repo };
  }
  return null;
};

export const createGitHubFetch = (token, options = {}) => {
  const responseCache = new Map();
  const inFlight = new Map();
  const MAX_ATTEMPTS = 3;
  const INITIAL_DELAY_MS = 1000;
  const ABUSE_DETECTION_RE = /abuse detection mechanism|secondary rate limit/i;
  const REQUEST_WINDOW_MS = 60_000;
  const maxRequestsPerMinute = Math.max(
    1,
    Number(
      options.maxRequestsPerMinute ||
        process.env.URDF_PREVIEW_GITHUB_MAX_REQUESTS_PER_MINUTE ||
        90
    ) || 90
  );
  const requestTimestamps = [];
  const failFastOnRateLimit =
    String(
      process.env.URDF_PREVIEW_GITHUB_FAIL_FAST_RATE_LIMIT ??
        (token ? "0" : "1")
    ).toLowerCase() === "1";
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pruneRequestTimestamps = () => {
    const cutoff = Date.now() - REQUEST_WINDOW_MS;
    while (requestTimestamps.length > 0 && requestTimestamps[0] <= cutoff) {
      requestTimestamps.shift();
    }
  };
  const acquireRateLimitSlot = async () => {
    while (true) {
      pruneRequestTimestamps();
      if (requestTimestamps.length < maxRequestsPerMinute) {
        requestTimestamps.push(Date.now());
        return;
      }
      const oldest = requestTimestamps[0];
      const waitMs = Math.max(25, REQUEST_WINDOW_MS - (Date.now() - oldest) + 5);
      stats.rateLimitedWaitCount += 1;
      stats.rateLimitedWaitMs += waitMs;
      await sleep(waitMs);
    }
  };
  const getHeader = (headers, name) => {
    if (!headers || typeof headers !== "object") return "";
    return String(headers[name.toLowerCase()] || headers[name] || "");
  };
  const parseRetryAfterMs = (headers) => {
    const value = Number(getHeader(headers, "retry-after"));
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.round(value * 1000);
  };
  const parseRateLimitResetMs = (headers) => {
    const reset = Number(getHeader(headers, "x-ratelimit-reset"));
    if (!Number.isFinite(reset) || reset <= 0) return 0;
    return Math.max((reset - nowSeconds()) * 1000 + 1000, 0);
  };

  const stats = {
    networkRequests: 0,
    cacheHits: 0,
    retries: 0,
    uniqueUrls: 0,
    maxRequestsPerMinute,
    rateLimitedWaitCount: 0,
    rateLimitedWaitMs: 0,
  };

  const fetchWithRetry = async (requestUrl) => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await acquireRateLimitSlot();
      stats.networkRequests += 1;
      try {
        return await fetchGitHubApiJson(requestUrl, {
          token,
          userAgent: "urdf-star-studio",
        });
      } catch (error) {
        const status = Number(error?.status || 0);
        const headers = error?.headers || {};
        const body = String(error?.body || error?.message || "");
        const isAbuse = status === 403 && ABUSE_DETECTION_RE.test(body);
        const isRateLimit =
          status === 429 || (status === 403 && getHeader(headers, "x-ratelimit-remaining") === "0");
        const isRetryableStatus = [500, 502, 503, 504].includes(status);
        const shouldRetry = isAbuse || isRateLimit || isRetryableStatus;

        if (isRateLimit && failFastOnRateLimit) {
          throw error;
        }

        if (!shouldRetry || attempt >= MAX_ATTEMPTS) {
          throw error;
        }

        let delayMs = INITIAL_DELAY_MS * Math.pow(2, attempt - 1);
        if (isRateLimit) {
          delayMs = Math.max(delayMs, parseRetryAfterMs(headers), parseRateLimitResetMs(headers));
        } else if (isAbuse) {
          delayMs = Math.max(delayMs, parseRetryAfterMs(headers));
        }
        const jitterMs = Math.floor(Math.random() * Math.max(200, Math.round(delayMs * 0.2)));
        const waitMs = delayMs + jitterMs;
        stats.retries += 1;
        console.warn(
          `[missing-previews] Retry GitHub API (${attempt}/${MAX_ATTEMPTS - 1}) after ${waitMs}ms: ${body || status}`
        );
        await sleep(waitMs);
      }
    }

    throw new Error(`GitHub API request failed after retries: ${requestUrl}`);
  };

  const fetcher = (requestUrl) => {
    if (responseCache.has(requestUrl)) {
      stats.cacheHits += 1;
      return Promise.resolve(responseCache.get(requestUrl));
    }
    if (inFlight.has(requestUrl)) {
      stats.cacheHits += 1;
      return inFlight.get(requestUrl);
    }

    const promise = fetchWithRetry(requestUrl)
      .then((result) => {
        if (!responseCache.has(requestUrl)) {
          stats.uniqueUrls += 1;
        }
        responseCache.set(requestUrl, result);
        return result;
      })
      .finally(() => {
        inFlight.delete(requestUrl);
      });

    inFlight.set(requestUrl, promise);
    return promise;
  };

  fetcher.getStats = () => ({ ...stats });
  fetcher.clearCache = () => {
    responseCache.clear();
    inFlight.clear();
  };
  return fetcher;
};

export const buildAssetIndex = async ({ previewsRoot, thumbnailsRoot }) => {
  const assets = new Map();
  const addAsset = (repoKey, fileBase, ext) => {
    if (!repoKey || !fileBase || !ext) return;
    const key = `${repoKey}::${fileBase}`;
    const entry = assets.get(key) || new Set();
    entry.add(ext);
    assets.set(key, entry);
  };

  const walk = async (root, validExts) => {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(root, entry.name);
          if (entry.isDirectory()) {
            await walk(fullPath, validExts);
            return;
          }
          if (!entry.isFile()) return;
          const ext = path.extname(entry.name).slice(1).toLowerCase();
          if (!validExts.has(ext)) return;
          const rel = path.relative(root, fullPath);
          const parts = rel.split(path.sep);
          if (parts.length < 3) return;
          const repoKey = `${parts[0]}/${parts[1]}`.toLowerCase();
          const fileBase = path.basename(entry.name, path.extname(entry.name));
          addAsset(repoKey, fileBase, ext);
        })
      );
    } catch {
      // ignore missing folders
    }
  };

  await walk(previewsRoot, new Set(["webp", "webm", "mp4"]));
  await walk(thumbnailsRoot, new Set(["png"]));
  return assets;
};

export const detectMissingMap = ({
  robotsJson,
  onlyKeys,
  onlyRepos,
  force,
  formats,
  assetsIndex,
}) => {
  const missingMap = new Map();
  const forceOnly = onlyKeys.size > 0;
  const repoOnly = onlyRepos.size > 0;

  const hasAllFormats = (repoKey, fileBase) => {
    if (!repoKey || !fileBase) return false;
    const key = `${repoKey}::${fileBase}`;
    const available = assetsIndex.get(key);
    if (!available) return false;
    return formats.every((format) => available.has(format));
  };

  for (const entry of robotsJson) {
    if (!entry?.repoKey || !entry?.repo) continue;
    if (!Array.isArray(entry.robots) || entry.robots.length === 0) continue;
    if (repoOnly && !onlyRepos.has(entry.repoKey.toLowerCase())) continue;

    const missingFiles = [];
    for (const robot of entry.robots) {
      const file = typeof robot === "string" ? robot : robot?.file;
      if (!file) continue;

      const fileBase = (typeof robot !== "string" && robot?.fileBase) || toPreviewBase(file);
      const key = `${entry.repoKey}::${fileBase}`;

      if (forceOnly) {
        if (onlyKeys.has(key)) {
          missingFiles.push({ file, fileBase });
        }
        continue;
      }

      if (force) {
        missingFiles.push({ file, fileBase });
        continue;
      }

      if (!hasAllFormats(entry.repoKey, fileBase)) {
        missingFiles.push({ file, fileBase });
      }
    }

    if (missingFiles.length > 0) {
      missingMap.set(entry.repoKey, { entry, missingFiles });
    }
  }

  return missingMap;
};

export const pickBestPath = (paths) => {
  if (!paths || paths.length === 0) return "";
  const withUrdf = paths.filter((p) => p.includes("/urdf/") || p.includes("/urdf_"));
  const candidates = withUrdf.length ? withUrdf : paths;
  return candidates.sort((a, b) => a.length - b.length)[0];
};

export const inferRobotSourceType = (value) => {
  return detectRobotSourceType(value);
};

const pathStem = (value) => stripRobotSourceExtension(path.posix.basename(String(value || ""))).toLowerCase();

const toDataUrdfUrl = (urdfText) =>
  `data:application/xml;base64,${Buffer.from(String(urdfText || ""), "utf8").toString("base64")}`;

const buildRawGitHubHeaders = (token = "") => {
  const headers = {
    "User-Agent": "urdf-star-studio",
    Accept: "application/vnd.github.v3.raw",
  };
  if (token) {
    headers.Authorization = `token ${token}`;
  }
  return headers;
};

const collectXacroSupportPaths = (treePaths, targetPath) => {
  const supportPaths = treePaths.filter((treePath) => isXacroSupportPath(treePath));
  const normalizedTarget = normalizeMeshPathForMatch(targetPath);
  const hasTarget = supportPaths.some(
    (treePath) => normalizeMeshPathForMatch(treePath) === normalizedTarget
  );
  if (hasTarget) return supportPaths;
  return targetPath ? [...supportPaths, targetPath] : supportPaths;
};

const fetchXacroSupportPayloadFiles = async ({ rawBase, supportPaths, token }) => {
  const files = [];
  const headers = buildRawGitHubHeaders(token);
  const BATCH_SIZE = 24;

  for (let index = 0; index < supportPaths.length; index += BATCH_SIZE) {
    const batch = supportPaths.slice(index, index + BATCH_SIZE);
    const payloadBatch = await Promise.all(
      batch.map(async (supportPath) => {
        const response = await fetch(`${rawBase}/${supportPath}`, { headers });
        if (!response.ok) {
          throw new Error(`Failed to fetch xacro support file ${supportPath}: HTTP ${response.status}`);
        }
        const bytes = await response.arrayBuffer();
        return {
          path: supportPath,
          content_base64: Buffer.from(bytes).toString("base64"),
        };
      })
    );
    files.push(...payloadBatch);
  }

  return files;
};

const expandXacroViaUrdfStudioApi = async ({
  xacroApiBaseUrl,
  targetPath,
  supportFiles,
}) => {
  const base = String(xacroApiBaseUrl || "").replace(/\/+$/, "");
  if (!base) {
    throw new Error("Missing xacro API base URL");
  }

  const response = await fetch(`${base}/xacro/expand`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildXacroExpandRequestPayload({ targetPath, files: supportFiles })),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload?.detail || payload?.message || "";
    } catch {
      // ignore parse failures
    }
    throw new Error(`xacro expansion failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }

  const payload = await response.json();
  return parseXacroExpandResponsePayload(payload);
};

const hasRenderableUrdfGeometry = (urdfText) =>
  /<(mesh|box|cylinder|sphere|capsule)\b/i.test(String(urdfText || ""));

const loadPrettyUrdfRepositoryMeshResolver = async () => {
  if (!prettyUrdfResolverPromise) {
    // Contributor workflow must run without external private repos.
    // Fall back to no-op mesh reference resolver when pretty-urdf is unavailable.
    prettyUrdfResolverPromise = Promise.resolve(() => ({
      matchByReference: new Map(),
      unresolved: [],
    }));
  }
  return prettyUrdfResolverPromise;
};

const collectTargetPathHints = (targetPath) => {
  const normalized = normalizeMeshPathForMatch(targetPath);
  if (!normalized) return [];
  const parts = normalized.split("/").filter(Boolean);
  const hints = new Set();
  const fileName = parts[parts.length - 1];
  if (fileName) hints.add(fileName.toLowerCase());
  for (let depth = 2; depth <= 4; depth += 1) {
    if (parts.length < depth) break;
    hints.add(parts.slice(parts.length - depth).join("/").toLowerCase());
  }
  return Array.from(hints);
};

const scoreXacroWrapperCandidate = ({
  candidatePath,
  targetPath,
  targetHints,
  missingStem,
}) => {
  const lower = candidatePath.toLowerCase();
  const targetLower = targetPath.toLowerCase();
  let score = 0;

  if (isUrdfXacroPath(lower)) score += 50;
  if (lower.includes("/robots/")) score += 20;
  if (lower.includes("/robot/")) score += 12;
  if (lower.includes("/urdf/")) score += 10;
  if (lower.includes("/common/")) score -= 40;
  if (lower.includes("macro")) score -= 28;
  if (lower.includes("/test/")) score -= 12;
  if (lower.startsWith("_") || lower.includes("/_")) score -= 20;

  const targetDir = path.posix.dirname(targetLower);
  if (targetDir && path.posix.dirname(lower) === targetDir) {
    score += 8;
  }

  if (missingStem) {
    if (lower.includes(`/${missingStem}.`)) score += 20;
    if (lower.includes(`${missingStem}_`)) score += 14;
    if (lower.includes(`/${missingStem}/`)) score += 10;
  }

  targetHints.forEach((hint, index) => {
    if (lower.includes(hint)) {
      score += Math.max(4, 14 - index * 3);
    }
  });

  score -= Math.min(lower.length / 400, 1.2);
  return score;
};

const buildXacroWrapperCandidates = ({ xacroPaths, targetPath, missingStem }) => {
  const targetHints = collectTargetPathHints(targetPath);
  return xacroPaths
    .filter((candidate) => candidate !== targetPath)
    .map((candidatePath) => ({
      candidatePath,
      score: scoreXacroWrapperCandidate({
        candidatePath,
        targetPath,
        targetHints,
        missingStem,
      }),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((entry) => entry.candidatePath);
};

const scorePathByStemSimilarity = (candidatePath, targetStem) => {
  const candidate = candidatePath.toLowerCase();
  const stem = targetStem.toLowerCase();
  let score = 0;
  if (candidate.includes(`/${stem}.urdf`)) score += 6;
  if (candidate.includes(`/${stem}_`)) score += 3;
  if (candidate.includes(`${stem}/`)) score += 2;
  if (candidate.includes("/urdf/")) score += 2;
  score -= Math.min(candidate.length / 500, 1);
  return score;
};

const pickClosestUrdfByStem = (paths, targetStem) => {
  if (!targetStem || !paths?.length) return "";
  return [...paths]
    .sort((a, b) => scorePathByStemSimilarity(b, targetStem) - scorePathByStemSimilarity(a, targetStem))[0] || "";
};

const runGitCapture = (args) =>
  spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const loadRepoTreeViaGitFallback = async (repoInfo) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "missing-previews-git-"));
  const repoUrl = `https://github.com/${repoInfo.owner}/${repoInfo.repo}.git`;

  try {
    const cloneResult = runGitCapture(["clone", "--depth", "1", "--filter=blob:none", repoUrl, tmpDir]);
    if (cloneResult.status !== 0) {
      throw new Error(cloneResult.stderr?.trim() || `git clone failed for ${repoUrl}`);
    }

    const branchResult = runGitCapture(["-C", tmpDir, "rev-parse", "--abbrev-ref", "HEAD"]);
    const branch =
      branchResult.status === 0 && branchResult.stdout?.trim() ? branchResult.stdout.trim() : "main";

    const lsFilesResult = runGitCapture(["-C", tmpDir, "ls-files"]);
    if (lsFilesResult.status !== 0) {
      throw new Error(lsFilesResult.stderr?.trim() || `git ls-files failed for ${repoUrl}`);
    }

    const treePaths = lsFilesResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return { branch, treePaths };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
};

export const buildPackagesMap = async ({
  treePaths,
  repoInfo,
  branch,
  token = "",
  packageXmlFetchLimit = 0,
}) => {
  const packagePaths = treePaths.filter((p) => p.endsWith("package.xml"));
  const packages = {};
  const rawRepoBase = `https://raw.githubusercontent.com/${repoInfo.owner}/${repoInfo.repo}/${branch}`;
  const addPackage = (name, url) => {
    if (!name || !url) return;
    if (!packages[name]) {
      packages[name] = url;
    }
  };

  if (packagePaths.length > 0) {
    packagePaths.forEach((pkgPath) => {
      const folder = path.posix.dirname(pkgPath);
      const name = folder.split("/").pop();
      if (name) {
        addPackage(name, `${rawRepoBase}/${folder}`);
      }
    });

    const xmlFetchLimit = Math.max(0, Number(packageXmlFetchLimit) || 0);
    if (xmlFetchLimit > 0) {
      const headers = buildRawGitHubHeaders(token);
      const packagePathsToFetch = packagePaths.slice(0, xmlFetchLimit);
      for (const pkgPath of packagePathsToFetch) {
        const folder = path.posix.dirname(pkgPath);
        try {
          const rawUrl = `${rawRepoBase}/${pkgPath}`;
          const response = await fetch(rawUrl, { headers });
          if (!response.ok) continue;
          const xml = await response.text();
          const match = xml.match(/<name>([^<]+)<\/name>/);
          const name = match?.[1]?.trim();
          if (name) {
            addPackage(name, `${rawRepoBase}/${folder}`);
          }
        } catch {
          // ignore
        }
      }
    }
  }

  const ROS_HINT_DIRS = new Set(["meshes", "urdf", "xacro", "launch", "config", "rviz"]);
  const SKIP_PACKAGE_NAMES = new Set(["src", "share", "resources", "assets", "robots", "urdf", "mesh", "meshes"]);
  const inferredFoldersByName = new Map();

  for (const treePath of treePaths) {
    const parts = treePath.split("/").filter(Boolean);
    if (parts.length < 2) continue;
    for (let index = 1; index < parts.length; index += 1) {
      if (!ROS_HINT_DIRS.has(parts[index].toLowerCase())) continue;
      const candidateName = parts[index - 1];
      if (!candidateName || SKIP_PACKAGE_NAMES.has(candidateName.toLowerCase())) continue;
      const folder = parts.slice(0, index).join("/");
      const current = inferredFoldersByName.get(candidateName);
      if (!current || folder.length < current.length) {
        inferredFoldersByName.set(candidateName, folder);
      }
    }

    const topLevel = parts[0];
    if (
      topLevel &&
      (topLevel.endsWith("_description") || topLevel.endsWith("_msgs") || topLevel.endsWith("_moveit_config"))
    ) {
      inferredFoldersByName.set(topLevel, topLevel);
    }
  }

  for (const [name, folder] of inferredFoldersByName.entries()) {
    addPackage(name, `${rawRepoBase}/${folder}`);
  }

  addPackage(repoInfo.repo, rawRepoBase);
  addPackage(repoInfo.repo.replace(/[_-]+/g, ""), rawRepoBase);
  if (repoInfo.owner) {
    addPackage(`${repoInfo.owner}/${repoInfo.repo}`, rawRepoBase);
  }

  return packages;
};

export const buildMeshIndexes = ({ treePaths, rawBase }) => {
  const meshIndex = {};
  const meshFileIndex = {};
  const meshFileCandidates = {};
  const meshStemCandidates = {};
  const addCandidate = (store, key, value) => {
    if (!key || !value) return;
    if (!store[key]) store[key] = [];
    if (!store[key].includes(value)) {
      store[key].push(value);
    }
  };

  for (const filePath of treePaths) {
    const lower = filePath.toLowerCase();
    if (!isSupportedMeshExtension(lower)) continue;

    const rawUrl = `${rawBase}/${filePath}`;
    const normalized = normalizeMeshPathForMatch(filePath).toLowerCase();
    meshIndex[normalized] = rawUrl;

    const filename = path.posix.basename(lower);
    if (!meshFileIndex[filename]) {
      meshFileIndex[filename] = rawUrl;
    }
    addCandidate(meshFileCandidates, filename, rawUrl);

    const stem = path.posix.basename(lower, path.posix.extname(lower));
    addCandidate(meshStemCandidates, stem, rawUrl);
  }

  return { meshIndex, meshFileIndex, meshFileCandidates, meshStemCandidates };
};

const meshRefToLookupPath = (meshRef) => {
  const raw = String(meshRef || "").trim().replace(/\\/g, "/");
  if (!raw) return "";
  if (raw.startsWith("package://")) {
    return raw.replace(/^package:\/\/[^/]+\/?/i, "").replace(/^\/+/, "");
  }
  if (raw.startsWith("file://")) {
    return raw.slice("file://".length).replace(/^\/+/, "");
  }
  return raw.replace(/^\/+/, "");
};

const extensionCandidatePaths = (normalizedPath) => {
  const clean = normalizeMeshPathForMatch(normalizedPath).toLowerCase();
  if (!clean) return [];
  const ext = path.posix.extname(clean);
  const stem = ext ? clean.slice(0, -ext.length) : clean;
  const out = [clean];
  for (const supportedExt of SUPPORTED_MESH_EXTENSIONS) {
    out.push(`${stem}${supportedExt}`);
  }
  return Array.from(new Set(out));
};

const rewriteUrdfMeshFilenamesWithResolvedUrls = ({
  urdfText,
  referenceUrlByKey,
}) => {
  if (!urdfText || !(referenceUrlByKey instanceof Map) || referenceUrlByKey.size === 0) {
    return { urdfText, rewriteCount: 0 };
  }

  let rewriteCount = 0;
  const rewritten = String(urdfText).replace(
    /(<mesh\b[^>]*\bfilename\s*=\s*)(["'])([^"']+)\2/gi,
    (full, prefix, quote, filename) => {
      const key = toMeshReferenceKey(filename);
      const resolvedUrl = key ? referenceUrlByKey.get(key) : "";
      if (!resolvedUrl || resolvedUrl === filename) return full;
      rewriteCount += 1;
      return `${prefix}${quote}${resolvedUrl}${quote}`;
    }
  );

  return { urdfText: rewritten, rewriteCount };
};

const buildResolvedMeshData = ({
  resolveRepositoryMeshReferences,
  repositoryFiles,
  urdfPath,
  urdfText,
  rawBase,
  meshIndex = {},
  meshFileIndex = {},
  meshFileCandidates = {},
  meshStemCandidates = {},
}) => {
  if (typeof resolveRepositoryMeshReferences !== "function") {
    return {
      meshReferenceIndex: {},
      rewrittenUrdfText: urdfText || "",
      rewrittenMeshCount: 0,
      unresolvedMeshCount: 0,
      fallbackResolvedCount: 0,
    };
  }
  if (!urdfPath || !urdfText) {
    return {
      meshReferenceIndex: {},
      rewrittenUrdfText: urdfText || "",
      rewrittenMeshCount: 0,
      unresolvedMeshCount: 0,
      fallbackResolvedCount: 0,
    };
  }

  try {
    const resolution = resolveRepositoryMeshReferences(urdfPath, urdfText, repositoryFiles);
    const matchByReference = resolution?.matchByReference;
    const referenceUrlByKey = new Map();
    const meshReferenceIndex = {};

    if (matchByReference instanceof Map) {
      for (const [meshRef, matchedFile] of matchByReference.entries()) {
        if (!matchedFile?.path) continue;
        const key = toMeshReferenceKey(meshRef);
        if (!key || referenceUrlByKey.has(key)) continue;
        const rawUrl = `${rawBase}/${matchedFile.path}`;
        referenceUrlByKey.set(key, rawUrl);
        meshReferenceIndex[key] = rawUrl;
      }
    }

    const unresolvedRefs = Array.isArray(resolution?.unresolved) ? resolution.unresolved : [];
    let fallbackResolvedCount = 0;
    for (const unresolvedRef of unresolvedRefs) {
      const key = toMeshReferenceKey(unresolvedRef);
      if (!key || referenceUrlByKey.has(key)) continue;

      const lookupPath = meshRefToLookupPath(unresolvedRef);
      const pathCandidates = extensionCandidatePaths(lookupPath);
      let fallbackUrl = "";
      for (const candidate of pathCandidates) {
        const direct = meshIndex[candidate];
        if (direct) {
          fallbackUrl = direct;
          break;
        }
      }

      if (!fallbackUrl) {
        const fileName = path.posix.basename(lookupPath).toLowerCase();
        const byFile = fileName
          ? meshFileCandidates[fileName] ||
            (meshFileIndex[fileName] ? [meshFileIndex[fileName]] : [])
          : [];
        if (byFile.length === 1) {
          fallbackUrl = byFile[0];
        }
      }

      if (!fallbackUrl) {
        const lower = path.posix.basename(lookupPath).toLowerCase();
        const ext = path.posix.extname(lower);
        const stem = ext ? lower.slice(0, -ext.length) : lower;
        const byStem = stem ? meshStemCandidates[stem] || [] : [];
        if (byStem.length === 1) {
          fallbackUrl = byStem[0];
        }
      }

      if (!fallbackUrl) continue;
      referenceUrlByKey.set(key, fallbackUrl);
      meshReferenceIndex[key] = fallbackUrl;
      fallbackResolvedCount += 1;
    }

    const rewritten = rewriteUrdfMeshFilenamesWithResolvedUrls({
      urdfText,
      referenceUrlByKey,
    });

    const unresolvedMeshCount = Math.max(0, unresolvedRefs.length - fallbackResolvedCount);
    return {
      meshReferenceIndex,
      rewrittenUrdfText: rewritten.urdfText,
      rewrittenMeshCount: rewritten.rewriteCount,
      unresolvedMeshCount,
      fallbackResolvedCount,
    };
  } catch (error) {
    console.warn(
      `[missing-previews] Failed to build mesh reference index for ${urdfPath}: ${
        error?.message || error
      }`
    );
    return {
      meshReferenceIndex: {},
      rewrittenUrdfText: urdfText || "",
      rewrittenMeshCount: 0,
      unresolvedMeshCount: 0,
      fallbackResolvedCount: 0,
    };
  }
};

export const collectRobotsToGenerate = async ({
  missingMap,
  maxPerRepo,
  githubFetch,
  token = "",
  xacroApiBaseUrl = "",
}) => {
  const robots = [];
  let skippedNoUrdf = 0;
  let skippedRepoFetch = 0;
  let skippedXacroExpand = 0;
  const packageXmlFetchLimit = Math.max(
    0,
    Number(process.env.URDF_PREVIEW_PACKAGE_XML_FETCH_LIMIT || 0)
  );

  for (const [repoKey, { entry, missingFiles }] of missingMap.entries()) {
    const repoInfo = parseRepoParts(entry.repo, repoKey);
    if (!repoInfo) continue;

    let branch = "main";
    let treePaths = [];

    try {
      const repoData = await githubFetch(`https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}`);
      branch = repoData.default_branch || "main";
      const treeData = await githubFetch(
        `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/git/trees/${branch}?recursive=1`
      );
      treePaths = (treeData.tree || [])
        .filter((node) => node?.path && node?.type === "blob")
        .map((node) => node.path);
    } catch (error) {
      console.warn(
        `[missing-previews] GitHub API failed for ${repoKey}; trying git fallback (${error?.message || error})`
      );
      try {
        const fallback = await loadRepoTreeViaGitFallback(repoInfo);
        branch = fallback.branch || branch;
        treePaths = fallback.treePaths;
        console.warn(
          `[missing-previews] Using git fallback for ${repoKey}: ${treePaths.length} files on ${branch}`
        );
      } catch (fallbackError) {
        skippedRepoFetch += missingFiles.length;
        console.warn(
          `[missing-previews] Skipping repo ${repoKey} due fetch error: ${fallbackError?.message || fallbackError}`
        );
        continue;
      }
    }

    const urdfPaths = treePaths.filter((p) => p.toLowerCase().endsWith(".urdf"));
    const xacroPaths = treePaths.filter((p) => isXacroPath(p));
    const urdfPathMap = new Map(urdfPaths.map((p) => [p.toLowerCase(), p]));
    const urdfByBase = new Map();
    const urdfByName = new Map();
    const urdfByStem = new Map();
    const xacroByName = new Map();
    const xacroByStem = new Map();

    for (const urdfPath of urdfPaths) {
      urdfByBase.set(toPreviewBase(urdfPath), urdfPath);
      const name = path.posix.basename(urdfPath).toLowerCase();
      if (!urdfByName.has(name)) {
        urdfByName.set(name, []);
      }
      urdfByName.get(name).push(urdfPath);

      const stem = pathStem(urdfPath);
      if (stem) {
        if (!urdfByStem.has(stem)) {
          urdfByStem.set(stem, []);
        }
        urdfByStem.get(stem).push(urdfPath);
      }
    }

    for (const xacroPath of xacroPaths) {
      const name = path.posix.basename(xacroPath).toLowerCase();
      if (!xacroByName.has(name)) {
        xacroByName.set(name, []);
      }
      xacroByName.get(name).push(xacroPath);

      const stem = pathStem(xacroPath);
      if (stem) {
        if (!xacroByStem.has(stem)) {
          xacroByStem.set(stem, []);
        }
        xacroByStem.get(stem).push(xacroPath);
      }
    }

    const rawBase = `https://raw.githubusercontent.com/${repoInfo.owner}/${repoInfo.repo}/${branch}`;
    const packages = await buildPackagesMap({
      treePaths,
      repoInfo,
      branch,
      token,
      packageXmlFetchLimit,
    });
    const { meshIndex, meshFileIndex, meshFileCandidates, meshStemCandidates } =
      buildMeshIndexes({ treePaths, rawBase });
    const resolveRepositoryMeshReferences = await loadPrettyUrdfRepositoryMeshResolver();
    const repositoryFiles = treePaths.map((treePath) => ({ path: treePath, type: "file" }));
    const urdfTextCache = new Map();
    const rawHeaders = buildRawGitHubHeaders(token);
    let xacroSupportFilesPromise = null;

    const getXacroSupportFiles = async (targetPath) => {
      if (!xacroSupportFilesPromise) {
        const supportPaths = collectXacroSupportPaths(treePaths, targetPath);
        xacroSupportFilesPromise = fetchXacroSupportPayloadFiles({
          rawBase,
          supportPaths,
          token,
        });
      }
      return xacroSupportFilesPromise;
    };

    const getUrdfTextForPath = async (targetPath) => {
      if (!targetPath) return "";
      if (urdfTextCache.has(targetPath)) {
        return urdfTextCache.get(targetPath);
      }
      const response = await fetch(`${rawBase}/${targetPath}`, { headers: rawHeaders });
      if (!response.ok) {
        throw new Error(`Failed to fetch URDF source ${targetPath}: HTTP ${response.status}`);
      }
      const urdfText = await response.text();
      urdfTextCache.set(targetPath, urdfText);
      return urdfText;
    };

    let count = 0;
    for (const missing of missingFiles) {
      if (maxPerRepo && count >= maxPerRepo) break;

      const rawFile = missing.file.replace(/^\/+/, "");
      const directMatch = urdfPathMap.get(rawFile.toLowerCase());
      const fileName = path.posix.basename(rawFile).toLowerCase().endsWith(".urdf")
        ? path.posix.basename(rawFile).toLowerCase()
        : `${path.posix.basename(rawFile).toLowerCase()}.urdf`;
      const candidates = urdfByName.get(fileName) || [];
      const baseMatch = missing.fileBase ? urdfByBase.get(missing.fileBase) : "";
      const missingStem = pathStem(rawFile);
      const stemCandidates = urdfByStem.get(missingStem) || [];
      const bestStemMatch = pickClosestUrdfByStem(stemCandidates, missingStem);
      const bestUrdfPath = baseMatch || directMatch || bestStemMatch || pickBestPath(candidates);

      const xacroNameCandidates = buildXacroFilenameCandidates(rawFile);
      const xacroCandidates = xacroNameCandidates.flatMap((candidate) => xacroByName.get(candidate) || []);
      const xacroStemCandidates = xacroByStem.get(missingStem) || [];
      const bestXacroStemMatch = pickClosestUrdfByStem(xacroStemCandidates, missingStem);
      const bestXacroPath = bestXacroStemMatch || pickBestPath(xacroCandidates);

      const bestPath = bestUrdfPath || bestXacroPath;

      if (!bestPath) {
        skippedNoUrdf += 1;
        console.warn(`[missing-previews] Missing URDF ${missing.file} in ${repoKey}`);
        continue;
      }

      const robotPackages = { ...packages };
      const urdfDir = path.posix.dirname(bestPath);
      const localAssetsDir = path.posix.join(urdfDir, "assets");
      if (treePaths.some((treePath) => treePath.startsWith(`${localAssetsDir}/`))) {
        robotPackages.assets = `${rawBase}/${localAssetsDir}`;
      }

      let urdfUrl = `${rawBase}/${bestPath}`;
      let resolvedUrdfPath = bestPath;
      let resolvedUrdfText = "";
      if (isXacroPath(bestPath)) {
        if (!xacroApiBaseUrl) {
          skippedXacroExpand += 1;
          console.warn(
            `[missing-previews] Skipping xacro ${bestPath} in ${repoKey} (set --xacro-api-base to enable expansion)`
          );
          continue;
        }
        try {
          const supportFiles = await getXacroSupportFiles(bestPath);
          const expansionCandidates = [
            bestPath,
            ...buildXacroWrapperCandidates({
              xacroPaths,
              targetPath: bestPath,
              missingStem,
            }),
          ];

          let expandedUrdf = "";
          let expandedFromPath = "";
          let firstError = null;

          for (const candidatePath of expansionCandidates) {
            try {
              const candidateUrdf = await expandXacroViaUrdfStudioApi({
                xacroApiBaseUrl,
                targetPath: candidatePath,
                supportFiles,
              });
              if (hasRenderableUrdfGeometry(candidateUrdf)) {
                expandedUrdf = candidateUrdf;
                expandedFromPath = candidatePath;
                break;
              }
            } catch (candidateError) {
              if (!firstError) {
                firstError = candidateError;
              }
            }
          }

          if (!expandedUrdf) {
            if (firstError) {
              throw firstError;
            }
            throw new Error(`xacro expanded with no renderable geometry: ${bestPath}`);
          }

          urdfUrl = toDataUrdfUrl(expandedUrdf);
          resolvedUrdfPath = normalizeExpandedUrdfPath(expandedFromPath || bestPath);
          resolvedUrdfText = expandedUrdf;
        } catch (error) {
          skippedXacroExpand += 1;
          console.warn(
            `[missing-previews] Failed xacro expansion ${bestPath} in ${repoKey}: ${error?.message || error}`
          );
          continue;
        }
      } else {
        try {
          resolvedUrdfText = await getUrdfTextForPath(bestPath);
        } catch (error) {
          console.warn(
            `[missing-previews] Failed to fetch URDF source ${bestPath} in ${repoKey}: ${
              error?.message || error
            }`
          );
        }
      }

      const resolvedMeshData = buildResolvedMeshData({
        resolveRepositoryMeshReferences,
        repositoryFiles,
        urdfPath: resolvedUrdfPath,
        urdfText: resolvedUrdfText,
        rawBase,
        meshIndex,
        meshFileIndex,
        meshFileCandidates,
        meshStemCandidates,
      });
      const meshReferenceIndex = resolvedMeshData.meshReferenceIndex;
      if (resolvedMeshData.rewrittenMeshCount > 0) {
        resolvedUrdfText = resolvedMeshData.rewrittenUrdfText;
        urdfUrl = toDataUrdfUrl(resolvedUrdfText);
      }
      if (resolvedMeshData.fallbackResolvedCount > 0) {
        console.log(
          `[missing-previews] Auto-resolved mesh refs for ${repoKey}/${missing.fileBase}: ${resolvedMeshData.fallbackResolvedCount}`
        );
      }
      if (resolvedMeshData.unresolvedMeshCount > 0) {
        console.warn(
          `[missing-previews] Unresolved mesh refs for ${repoKey}/${missing.fileBase}: ${resolvedMeshData.unresolvedMeshCount}`
        );
      }

      robots.push({
        id: `${repoKey}-${missing.fileBase}`,
        name: missing.fileBase,
        repoKey,
        fileBase: missing.fileBase,
        sourceFile: missing.file,
        sourceType: inferRobotSourceType(missing.file),
        urdfPath: resolvedUrdfPath,
        urdfUrl,
        assetBaseUrl: `${rawBase}/${path.posix.dirname(bestPath)}`,
        packages: robotPackages,
        meshIndex,
        meshFileIndex,
        meshReferenceIndex,
      });
      count += 1;
    }
  }

  robots.sort((a, b) => {
    const repoA = a.repoKey || "";
    const repoB = b.repoKey || "";
    if (repoA !== repoB) return repoA.localeCompare(repoB);

    const nameA = a.fileBase || a.id || "";
    const nameB = b.fileBase || b.id || "";
    return nameA.localeCompare(nameB);
  });

  console.log(
    `[missing-previews] Planned ${robots.length} robots (${skippedNoUrdf} unresolved URDF path, ${skippedXacroExpand} skipped xacro expansions, ${skippedRepoFetch} skipped from repo fetch errors).`
  );

  return robots;
};

export const chunkItems = (items, size) => {
  if (!size || size <= 0) return [items];
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
};

export const clearCacheDir = async (dir) => {
  if (!dir) return;
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
};

export const runSyncManifest = (galleryRoot) => {
  const libDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve("scripts/sync-previews-manifest.mjs"),
    path.resolve("tools/contributor-preview/scripts/sync-previews-manifest.mjs"),
    path.resolve(libDir, "..", "sync-previews-manifest.mjs"),
  ];
  const syncPath = candidates.find((candidate) => fsSync.existsSync(candidate));
  if (!syncPath) {
    console.error(
      `[missing-previews] Could not locate sync-previews-manifest.mjs. Tried: ${candidates.join(", ")}`
    );
    return false;
  }
  const result = spawnSync("node", [syncPath, "--gallery", galleryRoot], { stdio: "inherit" });
  return result.status === 0;
};

export const hasGitChanges = (galleryRoot) => {
  const result = spawnSync("git", ["-C", galleryRoot, "status", "--porcelain"], {
    encoding: "utf8",
  });
  return Boolean(result.stdout && result.stdout.trim().length);
};

const runGit = (galleryRoot, args, options = {}) =>
  spawnSync("git", ["-C", galleryRoot, ...args], { stdio: "inherit", ...options });

const pushWithRebase = (galleryRoot) => {
  let pushResult = runGit(galleryRoot, ["push"]);
  if (pushResult.status === 0) return true;

  console.warn("[missing-previews] Push failed. Rebasing onto origin/main and retrying...");
  const fetchResult = runGit(galleryRoot, ["fetch", "origin"]);
  if (fetchResult.status !== 0) return false;

  const rebaseResult = runGit(galleryRoot, ["rebase", "origin/main"]);
  if (rebaseResult.status !== 0) {
    console.error("[missing-previews] Rebase failed. Resolve conflicts and retry.");
    return false;
  }

  pushResult = runGit(galleryRoot, ["push"]);
  return pushResult.status === 0;
};

export const commitAndPush = ({ galleryRoot, message, shouldPush }) => {
  const addResult = spawnSync(
    "git",
    ["-C", galleryRoot, "add", "docs/previews", "docs/thumbnails", "docs/previews.json"],
    { stdio: "inherit" }
  );
  if (addResult.status !== 0) return false;

  const commitResult = spawnSync("git", ["-C", galleryRoot, "commit", "-m", message], {
    stdio: "inherit",
  });
  if (commitResult.status !== 0) return false;

  if (shouldPush) {
    return pushWithRebase(galleryRoot);
  }
  return true;
};

const MISSING_PREVIEW_BASE_CONFIG = {
  width: 480,
  height: 480,
  fps: 20,
  frameCount: 30,
  pixelRatio: 2.5,
  quality: 92,
  background: "transparent",
  rotationSpeed: 180,
  shadows: false,
  showGround: false,
  showGrid: false,
  framePadding: 1.1,
  minDistance: 0.08,
  maxDistance: 45,
  distanceMultiplier: 1.3,
  humanoidDistanceMultiplier: 1.15,
  framingTargetNdc: 0.9,
  framingHardMaxNdc: 0.985,
  framingRotationSamples: 72,
  framingDistanceSafety: 1.04,
  strictAlpha: true,
};

const MISSING_PREVIEW_FAST_OVERRIDES = {
  width: 400,
  height: 400,
  fps: 15,
  frameCount: 24,
  pixelRatio: 2,
  quality: 88,
  shadows: false,
  framePadding: 1.05,
  minDistance: 0.06,
  maxDistance: 40,
  distanceMultiplier: 1.2,
  humanoidDistanceMultiplier: 1.1,
  framingTargetNdc: 0.9,
  framingHardMaxNdc: 0.985,
  framingRotationSamples: 72,
  framingDistanceSafety: 1.04,
};

export const buildGeneratorConfig = ({
  robots,
  formats,
  fastMode,
  noBackground,
  strictAlpha,
  explicit,
  highQuality,
}) => {
  const fastOverrides = fastMode ? MISSING_PREVIEW_FAST_OVERRIDES : {};
  const backgroundOverrides = noBackground
    ? {
        background: "transparent",
        showGround: false,
        showGrid: false,
        shadows: false,
        strictAlpha,
      }
    : {
        strictAlpha: false,
      };

  const explicitOverrides = {};
  if (explicit.quality > 0) explicitOverrides.quality = explicit.quality;
  if (explicit.pixelRatio > 0) explicitOverrides.pixelRatio = explicit.pixelRatio;
  if (explicit.size > 0) {
    explicitOverrides.width = explicit.size;
    explicitOverrides.height = explicit.size;
  }
  if (explicit.width > 0) explicitOverrides.width = explicit.width;
  if (explicit.height > 0) explicitOverrides.height = explicit.height;
  if (explicit.frameCount > 0) explicitOverrides.frameCount = explicit.frameCount;
  if (explicit.fps > 0) explicitOverrides.fps = explicit.fps;
  if (explicit.timeoutMs > 0) explicitOverrides.timeoutMs = explicit.timeoutMs;

  if (highQuality) {
    if (!("quality" in explicitOverrides)) explicitOverrides.quality = 96;
    if (!("pixelRatio" in explicitOverrides)) explicitOverrides.pixelRatio = 3;
    if (!("width" in explicitOverrides)) explicitOverrides.width = 640;
    if (!("height" in explicitOverrides)) explicitOverrides.height = 640;
    if (!("frameCount" in explicitOverrides)) explicitOverrides.frameCount = 36;
    if (!("fps" in explicitOverrides)) explicitOverrides.fps = 24;
  }

  return {
    ...MISSING_PREVIEW_BASE_CONFIG,
    ...fastOverrides,
    ...backgroundOverrides,
    ...explicitOverrides,
    formats,
    robots,
  };
};
