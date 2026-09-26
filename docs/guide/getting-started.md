# Getting started

BucketLean runs as a private Node server connected to one or more R2 buckets. Its [documentation site](../index.md) is a separate static build; hosting the docs does not run the app.

## Run the application locally

Requirements: Node.js 22 or newer, npm, and at least one R2 bucket. Use a token with Object Read & Write access to each bucket you intend to optimize; a read-only token is enough for scanning.

```sh
cp .env.example .env
npm ci
npm run dev
```

Set `APP_PASSWORD` and either the four single-bucket `R2_*` variables or `R2_BUCKETS_JSON` in `.env`. For JSON, provide one `id`, `endpoint`, `bucket`, `accessKeyId`, and `secretAccessKey` per bucket. Account-wide credentials can be repeated across entries; a bucket-scoped token can be used for its one entry. For example: `R2_BUCKETS_JSON='[{"id":"photos","endpoint":"https://ACCOUNT_ID.r2.cloudflarestorage.com","bucket":"photos","accessKeyId":"KEY","secretAccessKey":"SECRET"}]'`. The local database defaults to `.data/optimizer.sqlite`; set `DATABASE_PATH` to use another location. Open `http://localhost:3000` and sign in with any username and the configured app password. Keep the R2 credentials on the server and use HTTPS when deploying the app.

## Ways to use the running app

| Way | What it supports | Where to start |
| --- | --- | --- |
| Dashboard | Scan, review JPEGs, start a job, and resume or reconcile a blocked job. | Open the private app at `http://localhost:3000`. |
| HTTP API | Perform the same scan and job actions from `curl`, a script, or another client. Work remains asynchronous in the server worker. | Follow the [API workflow](../api/workflow.md) and [endpoint reference](../api/endpoints.md). |
| Recovery commands | Snapshot SQLite, backfill older backup manifests, and verify or drill a restore. These commands run on the app host with its environment and are separate from normal optimization jobs. | See [Operations and recovery](../operations.md). |

The static documentation site is a separate build and does not run scans or jobs. The project has no standalone optimization CLI, scheduled-job endpoint, or webhook; automation calls the running HTTP API.

## First safe run

1. Select a bucket, enter a narrow prefix with one or two known JPEGs, and click **Start scan**. Scanning only reads R2; it does not change objects.
2. On **Optimize**, set the key prefix and **Minimum original size (MiB)** (1–20; default 1), then review the eligible list. Select images with the checkboxes, by clicking an eligible row, or with **Select eligible on this page**. Selection count shows in the results heading, the **Optimize** tab, and **Start job**. Use **Show preview** for a read-only modal preview (downloaded on demand). Selections persist across pages (up to 5,000) and clear when you change bucket, scan, prefix, size, or status. Optimized or unknown-metadata objects cannot be selected.
3. Configure job settings under the results, then **Start job** and confirm the prompt (bucket, selected count, backup policy). Canceling creates no job. Defaults are Balanced quality 82 and 15% minimum saving. A verified original backup is always required before replacement; **Delete backup after successful optimization** is off by default and removes the backup and manifest only after the optimized source is verified.
4. The dashboard switches to **Jobs**. The worker processes one image at a time and verifies backup and manifest before replacing the source.
5. Check the images in any app that uses the bucket. Those apps may keep stale sizes or thumbnails because BucketLean writes directly to R2—refresh or reprocess there if needed (for example, ChronoFrame’s **Reprocess**).

The same workflow is available through the [HTTP API](../api/index.md). Creating a job starts processing asynchronously and may replace qualifying originals, so inspect the scan first.

## Deploy the application

The included `Dockerfile` runs the server on port `3000` and stores SQLite at `/app/data/optimizer.sqlite`. Mount `/app/data` on a **local persistent volume**, run **one** app instance, and put HTTPS in front of it. SQLite WAL is not supported on a network filesystem. Do not scale to multiple replicas. The `/api/health` endpoint checks SQLite and whether R2 settings are present; it does not contact R2.

### Docker Compose

Copy `.env.example` to `.env`, set `APP_PASSWORD` and your R2 credentials, then:

```sh
docker compose up -d --build
```

Compose publishes port `3000`, mounts a named volume at `/app/data`, and uses the image health check against `/api/health`. Keep a single replica.

### Coolify

1. Create a new resource from this repository (Dockerfile or Docker Compose).
2. Set the container/listen port to `3000`. Coolify’s HTTPS proxy should forward to that port.
3. Attach **local** persistent storage mounted at `/app/data`. Do not use network/NFS storage for the database.
4. Keep **replicas / instances at 1**. The in-process worker and SQLite WAL need a single writer.
5. Add secrets from `.env.example`: `APP_PASSWORD` and either the four single-bucket `R2_*` values or `R2_BUCKETS_JSON`. Leave `DATABASE_PATH` unset unless you intentionally change it; the image default is `/app/data/optimizer.sqlite`.
6. Set the health check path to `/api/health` (or rely on the Dockerfile `HEALTHCHECK`).
7. Give the container enough memory for large JPEGs (about 1–2 GiB is a practical starting point; downloads are capped at 128 MiB).

After deploy, open the public HTTPS URL and sign in with any username and `APP_PASSWORD`. Confirm `GET /api/health` returns `status: "ok"` before starting a scan.

For snapshots, backup manifests, and restore drills, see [Operations and recovery](../operations.md). For the components and object flow, see [Architecture](../architecture.md).
