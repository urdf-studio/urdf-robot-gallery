# URDF Robot Gallery Submissions

This repository collects robot showcase submissions for URDF Studio.

## How to submit

Use the submission form:
https://github.com/urdf-studio/urdf-robot-gallery/issues/new?template=robot-repo-submission.yml

Auto-ingest policy:
- Auto-ingest runs only when the submitter has write access to the repo or is a URDF Studio maintainer. Otherwise, submissions are reviewed manually.
- Repeated failed submissions (including missing URDFs) from the same author may be throttled and routed to manual review.
- If no URDF files are detected in the repo, the entry is not added.
- Issue titles are updated automatically to include the repo name for easier tracking.

## Tag taxonomy

Use the controlled tag list in `docs/tags.json`. Submissions with unknown tags are rejected.

## Validation

`docs/robots.json` is validated against `docs/robots.schema.json` in CI.
`docs/previews.json` is validated against `docs/previews.schema.json` in CI.

Robot entries store the full URDF path in the `file` field to avoid filename collisions.

Metadata is stored in `docs/robots.meta.json` (version + counts).

## Manifests

Optional per-robot manifests live in `docs/manifests/<repoKey>/<fileBase>.json`.
Generate stubs with:

```sh
node tools/generate-manifests.mjs
```

## Cleanup previews

Find orphaned preview/thumbnail files (not referenced by `docs/previews.json`) and missing files:

```sh
node tools/cleanup-previews.mjs
```

Delete orphaned files:

```sh
node tools/cleanup-previews.mjs --write
```

## Backfill existing entries

To rescan existing repos and convert filename-only entries to full paths:

```sh
node tools/backfill-urdf-paths.mjs --token $GITHUB_TOKEN
node tools/backfill-urdf-paths.mjs --token $GITHUB_TOKEN --write
```

## Refresh robots list

To rescan repos, remove entries with no URDFs, and add missing URDFs:

```sh
node tools/refresh-robots.mjs --token $GITHUB_TOKEN
node tools/refresh-robots.mjs --token $GITHUB_TOKEN --write
```

Or trigger the GitHub Action:

```sh
gh workflow run refresh-robots.yml -R urdf-studio/urdf-robot-gallery -f write=true
```

The script writes a report to `docs/backfill-report.json` with preview keys that should be
regenerated and also saves a comma-separated list in `docs/backfill-preview-keys.txt`.
Use those keys to regenerate previews:

```sh
# from /home/albamwsl/studio/urdf-robot-gallery
node tools/rebuild-previews.mjs \
  --studio /path/to/urdf-star-studio \
  --gallery /path/to/urdf-robot-gallery
```

## Maintainer manual ingest

For manual review, trigger the workflow with the issue number:

```sh
gh workflow run ingest-robot-repos.yml -R urdf-studio/urdf-robot-gallery -f issue_number=123
```

## Where the gallery is displayed

The public gallery is displayed on https://www.urdfstudio.com (not via GitHub Pages).
