import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { ensureDir } from "./fs-utils.mjs";
import { buildPreviewHtml } from "./preview-html.mjs";
import { detectRobotSourceType } from "./robot-source-type.mjs";

export const LOCAL_THREE_PATH =
  "/home/albamwsl/studio/urdf-studio/node_modules/three/build/three.module.js";
export const LOCAL_THREE_EXAMPLES_PATH =
  "/home/albamwsl/studio/urdf-studio/node_modules/three/examples/jsm/";
export const LOCAL_THREE_ROOT = "/home/albamwsl/studio/urdf-studio/node_modules/three";
export const LOCAL_URDF_LOADER_ROOT = "/home/albamwsl/studio/urdf-studio/node_modules/urdf-loader";
export const LOCAL_URDF_LOADER_PATH =
  "/home/albamwsl/studio/urdf-studio/node_modules/urdf-loader/src/URDFLoader.js";

export const DEFAULT_THREE_URL = "https://unpkg.com/three@0.160.0/build/three.module.js";
export const DEFAULT_URDF_LOADER_URL = "https://unpkg.com/urdf-loader@0.12.2/src/URDFLoader.js";

export const DEFAULT_CONFIG = {
  width: 480,
  height: 480,
  fps: 20,
  frameCount: 30,
  pixelRatio: 2.5,
  quality: 92,
  background: "transparent",
  rotationSpeed: 180,
  formats: ["webp"],
  shadows: false,
  showGround: false,
  showGrid: false,
  framePadding: 1.4,
  minDistance: 0.08,
  maxDistance: 50,
  distanceMultiplier: 1.6,
  humanoidDistanceMultiplier: 1.2,
  framingTargetNdc: 0.9,
  framingHardMaxNdc: 0.985,
  framingRotationSamples: 72,
  framingDistanceSafety: 1.04,
  timeoutMs: 120000,
  strictAlpha: true,
};

export const FAST_PRESET = {
  width: 400,
  height: 400,
  fps: 15,
  frameCount: 24,
  pixelRatio: 2,
  quality: 88,
  shadows: false,
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const startLocalModuleServer = async () => {
  if (!fsSync.existsSync(LOCAL_THREE_ROOT) || !fsSync.existsSync(LOCAL_URDF_LOADER_ROOT)) {
    return null;
  }

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const pathname = decodeURIComponent(url.pathname);
      const sendNotFound = () => {
        res.statusCode = 404;
        res.end("Not found");
      };

      let baseDir = "";
      let relPath = "";
      if (pathname.startsWith("/three/")) {
        baseDir = LOCAL_THREE_ROOT;
        relPath = pathname.replace("/three/", "");
      } else if (pathname.startsWith("/urdf-loader/")) {
        baseDir = LOCAL_URDF_LOADER_ROOT;
        relPath = pathname.replace("/urdf-loader/", "");
      } else {
        sendNotFound();
        return;
      }

      const fsPath = path.resolve(baseDir, relPath);
      if (!fsPath.startsWith(path.resolve(baseDir))) {
        sendNotFound();
        return;
      }

      if (!fsSync.existsSync(fsPath) || fsSync.statSync(fsPath).isDirectory()) {
        sendNotFound();
        return;
      }

      const ext = path.extname(fsPath);
      if (ext === ".js") {
        res.setHeader("Content-Type", "text/javascript");
      } else if (ext === ".map") {
        res.setHeader("Content-Type", "application/json");
      }
      fsSync.createReadStream(fsPath).pipe(res);
    } catch (error) {
      res.statusCode = 500;
      res.end(error?.message || "Server error");
    }
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    return null;
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: () => server.close(),
  };
};

export const readPreviewConfig = async (configPath) => {
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return { ...DEFAULT_CONFIG, robots: parsed };
  }
  return { ...DEFAULT_CONFIG, ...parsed };
};

export const hasFfmpeg = () => {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const readPngColorType = (filePath) => {
  const buffer = fsSync.readFileSync(filePath);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Invalid PNG signature");
  }

  const ihdrLength = buffer.readUInt32BE(8);
  const ihdrType = buffer.subarray(12, 16).toString("ascii");
  if (ihdrType !== "IHDR" || ihdrLength < 13) {
    throw new Error("Invalid PNG IHDR chunk");
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colorType: buffer.readUInt8(25),
  };
};

const pngHasAlphaChannel = (filePath) => {
  const { colorType } = readPngColorType(filePath);
  return colorType === 4 || colorType === 6;
};

const probeVideoPixFmt = (filePath) => {
  try {
    const output = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=pix_fmt -of default=nw=1:nk=1 "${filePath}"`,
      { stdio: ["ignore", "pipe", "ignore"] }
    )
      .toString()
      .trim();
    return output;
  } catch {
    return "";
  }
};

const toNonNegativeInteger = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  if (numeric < 0) return undefined;
  return Math.round(numeric);
};

const buildDetectedTags = ({
  sourceType = "",
  meshCount,
  linkCount,
  jointCount,
  armCount,
  legCount,
  wheelCount,
}) => {
  const tags = [];
  const appendCountTag = (label, value) => {
    if (value !== undefined) {
      tags.push(`${label}:${value}`);
    }
  };

  appendCountTag("meshes", meshCount);
  appendCountTag("links", linkCount);
  appendCountTag("joints", jointCount);
  appendCountTag("arms", armCount);
  appendCountTag("legs", legCount);
  appendCountTag("wheels", wheelCount);

  if (sourceType) {
    tags.push(`source:${sourceType}`);
  }

  return tags;
};

export const resolveOutputPaths = (robot, previewDir, thumbnailDir) => {
  const fileBase =
    robot.fileBase ||
    robot.id ||
    path.basename(new URL(robot.urdfUrl).pathname, path.extname(robot.urdfUrl));
  const repoKey = robot.repoKey || "";
  const previewBaseDir = repoKey ? path.join(previewDir, repoKey) : previewDir;
  const thumbnailBaseDir = repoKey ? path.join(thumbnailDir, repoKey) : thumbnailDir;
  return {
    fileBase,
    previewBaseDir,
    thumbnailBaseDir,
    previewPath: path.join(previewBaseDir, `${fileBase}.webp`),
    webmPath: path.join(previewBaseDir, `${fileBase}.webm`),
    mp4Path: path.join(previewBaseDir, `${fileBase}.mp4`),
    thumbnailPath: path.join(thumbnailBaseDir, `${fileBase}.png`),
  };
};

export const removeIfExists = (filePath) => {
  if (!filePath) return;
  try {
    if (fsSync.existsSync(filePath)) {
      fsSync.unlinkSync(filePath);
    }
  } catch {
    // ignore
  }
};

const MISSING_PACKAGE_RE = /URDFLoader\s*:\s*([^:\s]+)\s+not found in provided package list/i;
const NOISY_CONSOLE_PATTERNS = [
  /URDFLoader\s*:\s*.+not found in provided package list/i,
  /Failed to load robot:\s*JSHandle@error/i,
];

const shouldSuppressConsoleMessage = (message = "") =>
  NOISY_CONSOLE_PATTERNS.some((pattern) => pattern.test(String(message)));

const toPreviewLoadError = ({ robotErrorMessage = "", missingPackages = [] }) => {
  const normalizedError = String(robotErrorMessage || "").trim();
  const packageSuffix =
    missingPackages.length > 0 ? ` (missing packages: ${missingPackages.join(", ")})` : "";
  if (normalizedError) {
    return new Error(`${normalizedError}${packageSuffix}`);
  }
  return new Error(`timeout${packageSuffix}`);
};

const publishArtifactIfExists = async (sourcePath, targetPath) => {
  if (!sourcePath || !targetPath || !fsSync.existsSync(sourcePath)) {
    return false;
  }
  await fs.copyFile(sourcePath, targetPath);
  return true;
};

export const generateRobotPreview = async ({
  browser,
  robot,
  config,
  ffmpegAvailable,
  formats,
  keepFrames,
  previewDir,
  thumbnailDir,
  moduleUrls,
  backgroundSnapshotPath,
  backgroundSnapshotState,
}) => {
  if (!robot.urdfUrl) {
    console.warn(`[preview] Skipping robot without urdfUrl: ${robot.id || robot.name}`);
    return null;
  }

  const { previewBaseDir, thumbnailBaseDir, previewPath, webmPath, mp4Path, thumbnailPath, fileBase } =
    resolveOutputPaths(robot, previewDir, thumbnailDir);
  await ensureDir(previewBaseDir);
  await ensureDir(thumbnailBaseDir);

  const tempOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), "urdf-preview-output-"));
  const tempPreviewPath = path.join(tempOutputDir, `${fileBase}.webp`);
  const tempWebmPath = path.join(tempOutputDir, `${fileBase}.webm`);
  const tempMp4Path = path.join(tempOutputDir, `${fileBase}.mp4`);
  const tempThumbnailPath = path.join(tempOutputDir, `${fileBase}.png`);

  const page = await browser.newPage();
  if (typeof page.setCacheEnabled === "function") {
    await page.setCacheEnabled(true);
  }
  const operationTimeout = config.timeoutMs ?? DEFAULT_CONFIG.timeoutMs;
  page.setDefaultTimeout(operationTimeout);
  page.setDefaultNavigationTimeout(operationTimeout);
  await page.setViewport({
    width: config.width,
    height: config.height,
    deviceScaleFactor: config.pixelRatio,
  });

  const robotLabel = robot.name || robot.id || robot.urdfUrl;
  const seenConsoleMessages = new Map();
  const missingPackages = new Set();
  const logConsoleMessage = (message) => {
    const normalized = message.trim();
    const missingPackageMatch = normalized.match(MISSING_PACKAGE_RE);
    if (missingPackageMatch?.[1]) {
      missingPackages.add(missingPackageMatch[1]);
      return;
    }
    if (shouldSuppressConsoleMessage(normalized)) return;

    const key = normalized;
    const count = seenConsoleMessages.get(key) || 0;
    if (count < 3) {
      console.warn(`[preview][console:error] ${robotLabel}: ${normalized}`);
    } else if (count === 3) {
      console.warn(
        `[preview][console:error] ${robotLabel}: repeated message suppressed (${normalized})`
      );
    }
    seenConsoleMessages.set(key, count + 1);
  };
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) {
      logConsoleMessage(message.text());
    }
  });
  page.on("pageerror", (error) => {
    const detail = error?.stack || error?.message || String(error);
    console.warn(`[preview][pageerror] ${robotLabel}: ${detail}`);
  });
  page.on("requestfailed", (request) => {
    console.warn(
      `[preview][requestfailed] ${robotLabel}: ${request.failure()?.errorText} ${request.url()}`
    );
  });

  let framesDir = "";
  try {
    const html = buildPreviewHtml({ robot, config, moduleUrls });
    await page.setContent(html, { waitUntil: "load" });

    const earlyError = await page.evaluate(() => window.__URDF_PREVIEW_ERROR__);
    if (earlyError) {
      console.warn(
        `[preview][early-error] ${robotLabel}: ${earlyError.message} at ${earlyError.filename}:${earlyError.lineno}:${earlyError.colno}`
      );
    }

    if (backgroundSnapshotPath && !backgroundSnapshotState.saved) {
      try {
        await page.evaluate(() => window.setBackgroundView && window.setBackgroundView());
        const snapshot = await page.screenshot({ type: "png", omitBackground: false });
        await ensureDir(path.dirname(backgroundSnapshotPath));
        await fs.writeFile(backgroundSnapshotPath, snapshot);
        backgroundSnapshotState.saved = true;
        console.log(`[preview] Background snapshot saved: ${backgroundSnapshotPath}`);
      } catch (error) {
        console.warn(`[preview] Background snapshot failed: ${error.message}`);
      }
    }

    try {
      await page.waitForFunction("window.robotReady === true", {
        timeout: operationTimeout,
      });
    } catch {
      const errorMessage = await page.evaluate(() => window.robotError || "");
      throw toPreviewLoadError({
        robotErrorMessage: errorMessage,
        missingPackages: Array.from(missingPackages),
      });
    }

    const meshSettleTimeoutMs = Math.max(2500, Math.min(10000, Math.floor(operationTimeout * 0.35)));
    try {
      await page.waitForFunction(
        `window.robotReady === true &&
        (typeof window.__isMeshLoadSettled__ !== "function" || window.__isMeshLoadSettled__() === true)`,
        { timeout: meshSettleTimeoutMs }
      );
    } catch {
      const pendingMeshes = await page.evaluate(() =>
        typeof window.__getPendingMeshLoads__ === "function" ? window.__getPendingMeshLoads__() : 0
      );
      console.warn(
        `[preview] mesh loading did not fully settle for ${robotLabel} (pending=${pendingMeshes}); continuing capture.`
      );
    }

    const settleStart = Date.now();
    let lastCount = -1;
    let stableCount = 0;
    const settleTimeoutMs = 5000;
    const settleIntervalMs = 300;
    while (Date.now() - settleStart < settleTimeoutMs) {
      const snapshot = await page.evaluate(() => {
        const meshCount =
          typeof window.__getMeshCount__ === "function" ? window.__getMeshCount__() : 0;
        const pendingMeshLoads =
          typeof window.__getPendingMeshLoads__ === "function"
            ? window.__getPendingMeshLoads__()
            : 0;
        return { meshCount, pendingMeshLoads };
      });
      const meshCount = Number(snapshot?.meshCount || 0);
      const pendingMeshLoads = Number(snapshot?.pendingMeshLoads || 0);
      if (pendingMeshLoads === 0 && meshCount === lastCount) {
        stableCount += 1;
        if (stableCount >= 2) break;
      } else {
        stableCount = 0;
      }
      lastCount = meshCount;
      await sleep(settleIntervalMs);
    }
    await sleep(300);

    let robotStats = {};
    try {
      const fromPage = await page.evaluate(() => {
        if (typeof window.__getRobotStats__ === "function") {
          return window.__getRobotStats__();
        }
        return {};
      });
      if (fromPage && typeof fromPage === "object") {
        robotStats = fromPage;
      }
    } catch {
      // Keep metadata optional if stats extraction fails.
    }

    framesDir = await fs.mkdtemp(path.join(os.tmpdir(), "urdf-preview-"));
    const anglePerFrame = ((Math.PI * 2) * (config.rotationSpeed / 360)) / config.frameCount;
    const hardMaxFramingNdc =
      Number.isFinite(config.framingHardMaxNdc) && Number(config.framingHardMaxNdc) > 0
        ? Math.min(0.995, Math.max(0.85, Number(config.framingHardMaxNdc)))
        : 0.985;
    const hardMaxTolerance = 0.002;

    let bestCoverage = -1;
    let bestCoverageFramePath = "";
    let finalFramePath = "";
    let worstCoverage = 0;
    const thumbnailCandidateStart = Math.floor(config.frameCount * 0.25);
    for (let i = 0; i < config.frameCount; i += 1) {
      const angle = i * anglePerFrame;
      await page.evaluate(
        (value) =>
          new Promise((resolve) => {
            window.setRotation(value);
            requestAnimationFrame(() => resolve());
          }),
        angle
      );

      const screenshot = await page.screenshot({
        type: "png",
        omitBackground: config.background === "transparent" || config.background === "none",
      });

      const framePath = path.join(framesDir, `frame_${String(i).padStart(3, "0")}.png`);
      await fs.writeFile(framePath, screenshot);
      finalFramePath = framePath;

      const metrics = await page.evaluate(() => {
        if (typeof window.__getCurrentFramingMetrics__ === "function") {
          return window.__getCurrentFramingMetrics__();
        }
        if (typeof window.__getCurrentFramingCoverage__ === "function") {
          const value = window.__getCurrentFramingCoverage__();
          const coverage = Number.isFinite(value) ? Number(value) : 0;
          return { coverage, maxAbsX: coverage, maxAbsY: coverage };
        }
        return { coverage: 0, maxAbsX: 0, maxAbsY: 0 };
      });
      const coverage = Number(metrics?.coverage || 0);
      worstCoverage = Math.max(worstCoverage, coverage);
      const frameIsSafe = coverage <= hardMaxFramingNdc + hardMaxTolerance;
      if (i >= thumbnailCandidateStart && frameIsSafe && coverage > bestCoverage) {
        bestCoverage = coverage;
        bestCoverageFramePath = framePath;
      }
    }

    if (worstCoverage > hardMaxFramingNdc + hardMaxTolerance) {
      throw new Error(
        `Framing overflow detected (coverage=${worstCoverage.toFixed(4)} > ${hardMaxFramingNdc.toFixed(
          4
        )})`
      );
    }

    await fs.copyFile(
      bestCoverageFramePath || finalFramePath || path.join(framesDir, "frame_000.png"),
      tempThumbnailPath
    );

    const relPreviewDir = robot.repoKey ? `previews/${robot.repoKey}` : "previews";
    const relThumbDir = robot.repoKey ? `thumbnails/${robot.repoKey}` : "thumbnails";
    const manifestEntry = {
      repoKey: robot.repoKey || "",
      fileBase,
      png: `${relThumbDir}/${fileBase}.png`,
    };
    const sourceType = detectRobotSourceType(
      robot.sourceType || robot.sourceFile || robot.urdfPath || robot.urdfUrl
    );
    if (sourceType) {
      manifestEntry.sourceType = sourceType;
    }
    const meshCount = toNonNegativeInteger(robotStats.meshCount);
    if (meshCount !== undefined) {
      manifestEntry.meshCount = meshCount;
    }
    const linkCount = toNonNegativeInteger(robotStats.linkCount);
    if (linkCount !== undefined) {
      manifestEntry.linkCount = linkCount;
    }
    const jointCount = toNonNegativeInteger(robotStats.jointCount);
    if (jointCount !== undefined) {
      manifestEntry.jointCount = jointCount;
    }
    const armCount = toNonNegativeInteger(robotStats.armCount);
    if (armCount !== undefined) {
      manifestEntry.armCount = armCount;
    }
    const legCount = toNonNegativeInteger(robotStats.legCount);
    if (legCount !== undefined) {
      manifestEntry.legCount = legCount;
    }
    const wheelCount = toNonNegativeInteger(robotStats.wheelCount);
    if (wheelCount !== undefined) {
      manifestEntry.wheelCount = wheelCount;
    }
    const detectedTags = buildDetectedTags({
      sourceType,
      meshCount,
      linkCount,
      jointCount,
      armCount,
      legCount,
      wheelCount,
    });
    if (detectedTags.length > 0) {
      manifestEntry.tags = detectedTags;
    }
    const transparentBackground = config.background === "transparent" || config.background === "none";
    const strictAlpha = transparentBackground && config.strictAlpha !== false;

    if (ffmpegAvailable) {
      if (formats.includes("webp")) {
        try {
          execSync(
            `ffmpeg -y -framerate ${config.fps} -i "${framesDir}/frame_%03d.png" -c:v libwebp_anim -pix_fmt yuva420p -loop 0 -lossless 0 -compression_level 6 -quality ${config.quality ?? 80} -an -vsync 0 "${tempPreviewPath}"`,
            { stdio: "ignore" }
          );
          if (fsSync.existsSync(tempPreviewPath)) {
            manifestEntry.webp = `${relPreviewDir}/${fileBase}.webp`;
          }
        } catch (error) {
          console.warn(`[preview] webp failed for ${robot.name || robot.id}: ${error.message}`);
        }
      }

      if (formats.includes("webm")) {
        try {
          execSync(
            `ffmpeg -y -framerate ${config.fps} -i "${framesDir}/frame_%03d.png" -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 0 -crf 33 -speed 4 "${tempWebmPath}"`,
            { stdio: "ignore" }
          );
          if (fsSync.existsSync(tempWebmPath)) {
            manifestEntry.webm = `${relPreviewDir}/${fileBase}.webm`;
          }
        } catch (error) {
          console.warn(`[preview] webm failed for ${robot.name || robot.id}: ${error.message}`);
        }
      }

      if (formats.includes("mp4")) {
        try {
          execSync(
            `ffmpeg -y -framerate ${config.fps} -i "${framesDir}/frame_%03d.png" -c:v libx264 -pix_fmt yuv420p -crf 28 -preset veryfast -movflags +faststart -maxrate 900k -bufsize 1800k "${tempMp4Path}"`,
            { stdio: "ignore" }
          );
          if (fsSync.existsSync(tempMp4Path)) {
            manifestEntry.mp4 = `${relPreviewDir}/${fileBase}.mp4`;
          }
        } catch (error) {
          console.warn(`[preview] mp4 failed for ${robot.name || robot.id}: ${error.message}`);
        }
      }
    } else if (formats.some((format) => format !== "png")) {
      console.warn("[preview] ffmpeg not available; skipping animated preview generation");
    }

    if (strictAlpha) {
      if (!pngHasAlphaChannel(tempThumbnailPath)) {
        throw new Error(
          `Generated thumbnail is opaque (no alpha): ${tempThumbnailPath}. Run with --allow-opaque to bypass.`
        );
      }

      if (manifestEntry.webm && fsSync.existsSync(tempWebmPath)) {
        const pixFmt = probeVideoPixFmt(tempWebmPath);
        if (!pixFmt || !pixFmt.includes("a")) {
          removeIfExists(tempWebmPath);
          delete manifestEntry.webm;
          console.warn(
            `[preview] Removed non-alpha webm for ${robot.name || robot.id || fileBase} (pix_fmt=${pixFmt || "unknown"}).`
          );
        }
      }
    }

    const thumbnailPublished = await publishArtifactIfExists(tempThumbnailPath, thumbnailPath);
    if (!thumbnailPublished) {
      throw new Error(`Generated thumbnail was missing for ${robotLabel}`);
    }
    await publishArtifactIfExists(tempPreviewPath, previewPath);
    await publishArtifactIfExists(tempWebmPath, webmPath);
    await publishArtifactIfExists(tempMp4Path, mp4Path);

    if (!manifestEntry.webp && fsSync.existsSync(previewPath)) {
      manifestEntry.webp = `${relPreviewDir}/${fileBase}.webp`;
    }
    if (!manifestEntry.webm && fsSync.existsSync(webmPath)) {
      manifestEntry.webm = `${relPreviewDir}/${fileBase}.webm`;
    }
    if (!manifestEntry.mp4 && fsSync.existsSync(mp4Path)) {
      manifestEntry.mp4 = `${relPreviewDir}/${fileBase}.mp4`;
    }

    return manifestEntry;
  } finally {
    try {
      if (!page.isClosed()) {
        await page.close();
      }
    } catch {
      // ignore close errors
    }
    if (!keepFrames && framesDir) {
      await fs.rm(framesDir, { recursive: true, force: true });
    }
    await fs.rm(tempOutputDir, { recursive: true, force: true });
  }
};
