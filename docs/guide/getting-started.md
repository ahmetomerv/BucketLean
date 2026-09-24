# Getting started

R2 JPEG Optimizer runs as a private Node server connected to one R2 bucket. Its [documentation site](../index.md) is a separate static build; hosting the docs does not run the optimizer.

## Run the application locally

Requirements: Node.js 22 or newer, npm, and an R2 bucket. Create a bucket-scoped token with Object Read & Write access if you intend to optimize; a read-only token is enough for scanning.

```sh
cp .env.example .env
npm ci
npm run dev
```

Set `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `APP_PASSWORD` in `.env`. The local database defaults to `.data/optimizer.sqlite`; set `DATABASE_PATH` to use another location. Open `http://localhost:3000` and sign in with any username and the configured app password. Keep the R2 credentials on the server and use HTTPS when deploying the app.

## First safe run

1. Scan a narrow prefix containing one or two known JPEGs. Scanning reads R2 but does not change objects.
2. Inspect the eligible count and object list. Files with unknown metadata or an existing `image-optimizer-version` marker are excluded.
3. Create a job for that same prefix. Balanced quality 82 and a minimum 15% saving are the defaults. The original backup is mandatory.
4. Watch the job result. The worker processes one image at a time and verifies its backup and manifest before conditionally replacing the source.

The same workflow is available through the [HTTP API](../api/index.md). Creating a job starts processing asynchronously and may replace qualifying originals, so inspect the scan first.

## Deploy the application

The included `Dockerfile` runs the server on port `3000` and stores SQLite at `/app/data/optimizer.sqlite`. Mount `/app/data` on a **local persistent volume**, run one app instance, and put HTTPS in front of it. SQLite WAL is not supported on a network filesystem. The `/api/health` endpoint checks SQLite and whether R2 settings are present; it does not contact R2.

For snapshots, backup manifests, and restore drills, see [Operations and recovery](../operations.md). For the components and object flow, see [Architecture](../architecture.md).
