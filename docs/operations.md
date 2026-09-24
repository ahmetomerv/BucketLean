# Operations and recovery

The server stores scan and job progress in SQLite, while R2 holds optimized sources, original backups, and restore manifests. Keep the SQLite database on a local persistent volume and retain an off-host snapshot. The application never deletes original backups automatically.

## Take a consistent SQLite snapshot

Run this from the repository with the app's environment available. Choose a new filename each time:

```sh
node --env-file=.env scripts/snapshot-db.mjs --output .data/snapshots/optimizer-YYYY-MM-DD.sqlite
```

The command uses SQLite's online backup API, refuses to overwrite an existing snapshot, verifies integrity, and prints the saved bucket identity and job/item counts. Copy the snapshot outside the app host. Do not rely on copying only the live `.sqlite` file while WAL is active.

## Backfill manifests for older backups

The first command is read-only: it downloads each recorded completed backup and checks its size and SHA-256 against SQLite. The second writes and verifies missing manifests in R2.

```sh
node --env-file=.env scripts/backfill-manifests.mjs
node --env-file=.env scripts/backfill-manifests.mjs --apply
```

The script refuses a database bound to a different bucket. If an older populated database has no bucket identity, verify its bucket with `--verify-unbound`, stop the app, and take a SQLite snapshot. Then bind that database before `--apply` using the endpoint and bucket you verified:

```sh
node --env-file=.env scripts/backfill-manifests.mjs --verify-unbound
node --env-file=.env scripts/bind-legacy-db.mjs \
  --confirm-endpoint https://ACCOUNT_ID.r2.cloudflarestorage.com/ \
  --confirm-bucket YOUR_BUCKET
```

The binding script compares those values with `R2_ENDPOINT` and `R2_BUCKET`, refuses a mismatch, and does not contact R2. The backfill reads SQLite but does not modify job rows.

## Prove that a backup restores

The restore drill reads a manifest and its backup from R2 without using SQLite. By default it chooses the first manifest; `--manifest-key KEY` selects a specific one.

```sh
node --env-file=.env scripts/restore-drill.mjs
node --env-file=.env scripts/restore-drill.mjs --apply
```

The dry run verifies the backup hash. `--apply` writes the original bytes and headers to a **new** key under `__optimizer/restore-drills/`, reads the copy back, and verifies that the source key was untouched. It leaves the drill copy for inspection. A whole-bucket scan can discover that copy as a JPEG, so remove it when no longer needed or use a narrow optimization prefix.

Do not enable a lifecycle expiration rule for `__optimizer/originals/` until you have a verified SQLite snapshot, readable manifests, and a successful restore drill for the bucket. Manifests live under a separate `__optimizer/manifests/` prefix.

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
DOCS_BASE=/r2-jpeg-optimizer/ npm run docs:build
```

Set the static host's published directory to `docs/.vitepress/dist` and serve directory indexes such as `api/index.html`. The docs site is public content; it contains examples and no runtime access to your bucket or app password. See the [VitePress deployment guide](https://vitepress.dev/guide/deploy) for host-specific settings. Publishing is a separate step; the repository does not automatically deploy the docs.
