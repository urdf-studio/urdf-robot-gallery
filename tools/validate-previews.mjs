#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import Ajv from "ajv";

const ROOT = path.resolve();
const PREVIEWS_PATH = path.join(ROOT, "docs", "previews.json");
const SCHEMA_PATH = path.join(ROOT, "docs", "previews.schema.json");

const readJson = async (filePath) => {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
};

const normalizePath = (value) => value.replace(/^\/+/, "");

const main = async () => {
  const [previews, schema] = await Promise.all([readJson(PREVIEWS_PATH), readJson(SCHEMA_PATH)]);

  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  const validate = ajv.compile(schema);
  if (!validate(previews)) {
    console.error("[validate-previews] Schema validation failed.");
    for (const error of validate.errors || []) {
      console.error(`- ${error.instancePath || "(root)"} ${error.message || "invalid"}`);
    }
    process.exitCode = 1;
    return;
  }

  const entries = Array.isArray(previews.previews) ? previews.previews : [];
  const errors = [];
  const seenKeys = new Set();

  for (const entry of entries) {
    const repoKey = entry.repoKey || "";
    const fileBase = entry.fileBase || "";
    const key = `${repoKey}::${fileBase}`;
    if (seenKeys.has(key)) {
      errors.push(`Duplicate preview entry for ${key}.`);
    } else {
      seenKeys.add(key);
    }

    const checks = [
      ["webp", "previews", "webp"],
      ["webm", "previews", "webm"],
      ["mp4", "previews", "mp4"],
      ["png", "thumbnails", "png"],
    ];
    for (const [field, folder, ext] of checks) {
      const value = entry[field];
      if (!value) continue;
      const normalized = normalizePath(value);
      const expected = `${folder}/${repoKey}/${fileBase}.${ext}`;
      if (normalized !== expected) {
        errors.push(`Entry ${key}: ${field} should be "${expected}", got "${value}".`);
      }
    }
  }

  if (errors.length) {
    console.error("[validate-previews] Validation errors:");
    for (const err of errors) {
      console.error(`- ${err}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("[validate-previews] OK");
};

main().catch((error) => {
  console.error("[validate-previews] Failed:", error);
  process.exitCode = 1;
});
