# Operations and recovery

The server stores scan and job progress in SQLite, while R2 holds optimized sources, original backups, and restore manifests. Keep the SQLite database on a local persistent volume and retain an off-host snapshot. Backups are retained by default. A job with opt-in backup cleanup deletes each verified backup and its manifest after the optimized source is verified.

## Take a consistent SQLite snapshot

Run this from the repository with the app's environment available. Choose a new filename each time:

```sh
node --env-file=.env scripts/snapshot-db.mjs --output .data/snapshots/optimizer-YYYY-MM-DD.sqlite
```

The command uses SQLite's online backup API, refuses to overwrite an existing snapshot, verifies integrity, and prints all registered bucket profiles and job/item counts. Copy the snapshot outside the app host. Do not rely on copying only the live `.sqlite` file while WAL is active.

## Backfill manifests for older backups

Select the bucket profile whose backups you want to check. The first command reads only that profile's completed job backups that were retained and verifies sizes and SHA-256 hashes; the second writes and verifies missing manifests in that bucket.

```sh
node --env-file=.env scripts/backfill-manifests.mjs --bucket-id photos
node --env-file=.env scripts/backfill-manifests.mjs --bucket-id photos --apply
```

`--bucket-id` is optional when exactly one bucket is configured. The script compares the selected profile with SQLite and does not modify job rows. The legacy single-bucket database cannot be used with this schema; start with a fresh database as described in [Getting started](./guide/getting-started.md).

## Prove that a backup restores

The restore drill reads a manifest and its backup from the selected bucket without using SQLite. It requires a retained backup; jobs using opt-in cleanup remove their backup and manifest after successful verification. By default it chooses the first manifest; `--manifest-key KEY` selects a specific one.

```sh
node --env-file=.env scripts/restore-drill.mjs --bucket-id photos
node --env-file=.env scripts/restore-drill.mjs --bucket-id photos --apply
```

The dry run verifies the backup hash. `--apply` writes the original bytes and headers to a **new** key under `__optimizer/restore-drills/`, reads the copy back, and verifies that the source key was untouched. It leaves the drill copy for inspection. A whole-bucket scan can discover that copy as a JPEG, so remove it when no longer needed or use a narrow optimization prefix.

For backups retained by default, do not enable a lifecycle expiration rule for `__optimizer/originals/` until you have a verified SQLite snapshot, readable manifests, and a successful restore drill for the bucket. Manifests live under a separate `__optimizer/manifests/` prefix.

## Paused and uncertain jobs

A credential or bucket-wide failure pauses the job. Fix access or configuration, then use `POST /api/jobs/<id>/resume`. If a backup or replacement result cannot be established, the item becomes `needs_attention`; inspect its hashes and object keys in `GET /api/jobs/<id>`, then use `POST /api/jobs/<id>/reconcile` to recheck the source and backup. See [Job endpoints](./api/endpoints.md#jobs) for request details.

## Build and publish this documentation

The docs are a separate VitePress site and require no R2 credentials:

```sh
npm ci
npm run docs:dev
npm run docs:build
npm run docs:preview
npm run docs:check
```

`docs:dev` starts at `http://localhost:5173/` by default. `docs:preview` serves the built site at `http://localhost:4173/`. `docs:check` verifies the static pages and assets, then starts a temporary dev server to check Mermaid's browser dependencies.

`docs:build` writes static files to `docs/.vitepress/dist`. Publish the **contents** of that directory to a static host. For a root domain, build with the default `/` base. For a repository or other subpath, build with a matching base, for example:

```sh
DOCS_BASE=/BucketLean/ npm run docs:build
```

For other static hosts, publish `docs/.vitepress/dist` and serve directory indexes such as `api/index.html`. The docs site is public content; it contains examples and no runtime access to your bucket or app password. See the [VitePress deployment guide](https://vitepress.dev/guide/deploy) for host-specific settings.

### GitHub Pages for this repository

The [Pages workflow](https://github.com/ahmetomerv/BucketLean/blob/main/.github/workflows/pages.yml) builds with `DOCS_BASE=/BucketLean/`, verifies the generated pages, and deploys `docs/.vitepress/dist` on pushes to `main` or by manual dispatch. In the repository's **Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**. Then push the workflow to `main` or run **Deploy documentation** from the Actions tab. The site will be served at `https://ahmetomerv.github.io/BucketLean/` after the deployment succeeds.

Do not select **Deploy from a branch → main → /docs** for this VitePress site. That setting publishes the Markdown source in `/docs` and does not run `npm run docs:build`.
