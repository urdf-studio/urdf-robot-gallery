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
      const seen = new Set();
      for (const robot of entry.robots) {
        const file = robot?.file || "";
        if (!file) continue;
        const key = file.toLowerCase();
        if (seen.has(key)) {
          errors.push(
            `Entry ${index} (${repoKey || entry.repo}): duplicate file "${file}".`
          );
        } else {
          seen.add(key);
        }
        if (robot?.fileBase) {
          const expectedBase = toPreviewBase(file);
          if (robot.fileBase !== expectedBase) {
            errors.push(
              `Entry ${index} (${repoKey || entry.repo}): fileBase "${robot.fileBase}" does not match "${expectedBase}" for file "${file}".`
            );
          }
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
