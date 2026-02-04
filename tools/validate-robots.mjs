#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import Ajv from "ajv";

const ROOT = path.resolve();
const ROBOTS_PATH = path.join(ROOT, "docs", "robots.json");
const SCHEMA_PATH = path.join(ROOT, "docs", "robots.schema.json");
const TAGS_PATH = path.join(ROOT, "docs", "tags.json");

const readJson = async (filePath) => {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
};

const normalizeRepoKey = (value) =>
  value
    ? value
        .replace(/^https?:\/\/github\.com\//, "")
        .split("/")
        .slice(0, 2)
        .join("/")
        .toLowerCase()
    : "";

const FILEBASE_REGEX = /^[a-z0-9][a-z0-9._-]*--[a-z0-9]+$/i;

const main = async () => {
  const [robots, schema, allowedTags] = await Promise.all([
    readJson(ROBOTS_PATH),
    readJson(SCHEMA_PATH),
    readJson(TAGS_PATH),
  ]);

  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  const validate = ajv.compile(schema);
  if (!validate(robots)) {
    console.error("[validate-robots] Schema validation failed.");
    for (const error of validate.errors || []) {
      console.error(`- ${error.instancePath || "(root)"} ${error.message || "invalid"}`);
    }
    process.exitCode = 1;
    return;
  }

  const allowedSet = new Set(allowedTags);

  const errors = [];

  robots.forEach((entry, index) => {
    const repoKey = entry.repoKey || "";
    const expected = normalizeRepoKey(entry.repo || repoKey);
    if (repoKey && expected && repoKey.toLowerCase() !== expected) {
      errors.push(
        `Entry ${index}: repoKey "${repoKey}" does not match repo "${entry.repo}". Expected "${expected}".`
      );
    }

    if (Array.isArray(entry.tags)) {
      const invalid = entry.tags.filter((tag) => !allowedSet.has(tag));
      if (invalid.length) {
        errors.push(
          `Entry ${index} (${repoKey || entry.repo}): invalid tag(s): ${invalid.join(", ")}.`
        );
      }
    }

    if (Array.isArray(entry.robots)) {
      const seenFiles = new Map();
      const seenFileBases = new Set();
      for (const robot of entry.robots) {
        const file = robot?.file || "";
        if (!file) continue;
        if (file.includes("/") || file.includes("\\")) {
          errors.push(
            `Entry ${index} (${repoKey || entry.repo}): file "${file}" must be a filename only (no path).`
          );
        }
        const key = file.toLowerCase();
        const info = seenFiles.get(key) || { count: 0, bases: new Set() };
        info.count += 1;

        const fileBase = robot?.fileBase || "";
        if (fileBase) {
          if (!FILEBASE_REGEX.test(fileBase)) {
            errors.push(
              `Entry ${index} (${repoKey || entry.repo}): fileBase "${fileBase}" is not in the expected slug--hash format.`
            );
          }
          const baseKey = fileBase.toLowerCase();
          if (seenFileBases.has(baseKey)) {
            errors.push(
              `Entry ${index} (${repoKey || entry.repo}): duplicate fileBase "${fileBase}".`
            );
          } else {
            seenFileBases.add(baseKey);
          }
          info.bases.add(baseKey);
        }

        seenFiles.set(key, info);
      }

      for (const [fileKey, info] of seenFiles.entries()) {
        if (info.count > 1 && info.bases.size < info.count) {
          errors.push(
            `Entry ${index} (${repoKey || entry.repo}): duplicate file "${fileKey}" requires unique fileBase values.`
          );
        }
      }
    }
  });

  if (errors.length) {
    console.error("[validate-robots] Validation errors:");
    for (const err of errors) {
      console.error(`- ${err}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("[validate-robots] OK");
};

main().catch((error) => {
  console.error("[validate-robots] Failed:", error);
  process.exitCode = 1;
});
