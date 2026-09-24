# R2 JPEG Optimizer

A private, self-hosted Nuxt application for finding and recompressing JPEGs in one Cloudflare R2 bucket. It uses one sequential worker, SQLite for persistent jobs, Sharp/MozJPEG for compression, and ExifTool to verify photo metadata.

## How it works

1. Scan the whole bucket or a prefix. The scan lists objects and reads JPEG object metadata; it never writes to R2.
2. Filter by key prefix and minimum file size. Only JPEGs confirmed as not previously optimized enter a job. Objects with unknown metadata are excluded.
3. Start a job with Archival (90), Balanced (82), or Aggressive (72) JPEG quality. Balanced and a 15% minimum saving are the defaults.
4. For each item, the worker checks that its ETag and size still match the scan, downloads it, inspects it with ExifTool, recompresses it, validates the complete JPEG and dimensions, and compares required EXIF and ICC metadata when preservation is enabled.
5. If the saving reaches the threshold, the worker stores and verifies the original under `__optimizer/originals/<job-id>/`, then conditionally replaces the source object using its original ETag. It reads back the replacement and checks its hash before marking the item complete.

The backup is mandatory in this MVP, even though the job schema reserves a backup setting. If a backup fails verification, the source is not replaced. A changed source, an already optimized object, or an image with insufficient savings is skipped. One failed item does not stop the others. Jobs resume unfinished items after a restart; an upload completed just before a crash is reconciled from its object metadata and saved hash. Failed items stay failed for review. Objects larger than 128 MiB are skipped to bound worker memory.

The database is bound to one R2 endpoint and bucket. Startup refuses a different bucket or account endpoint, so old scan results cannot be used against another bucket. A SQLite worker lease chooses one process to run scans and jobs; it is renewed while that process is alive and can be claimed after expiry if the process crashes. A worker that loses the lease stops before further uploads, leaving unfinished work for the next owner. Conditional R2 replacement still protects the source if a lease expires during an in-flight request.

Optimized objects receive `image-optimizer-version`, `image-optimizer-quality`, `image-optimizer-date`, `image-optimizer-job-id`, `image-optimizer-item-id`, and `original-size` custom R2 metadata. They are excluded from future jobs. Keep the backups for a retention period that suits you; an [R2 object lifecycle rule](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) can expire the `__optimizer/originals/` prefix. The application does not automatically restore objects or delete backups.

## Local development

Requirements: Node.js 22 or newer (24 recommended), npm, and one R2 bucket.

```sh
cp .env.example .env
# Set the endpoint, bucket name, credentials, and APP_PASSWORD in .env.
npm install
npm run dev
```

Open `http://localhost:3000` and sign in with any username and your `APP_PASSWORD`. The password is required locally and in production. Use HTTPS in front of the deployed app; HTTP Basic authentication sends credentials with each request. R2 secrets remain server-side.

For an initial optimization test, scan a narrow prefix containing one or two JPEGs, check the candidate table, and start a Balanced job. **Optimization requires bucket-scoped Object Read & Write credentials.** A read-only token can still scan, but backup and replacement will fail. Existing scan results and jobs live in SQLite; keep the database file when restarting the app.

An empty database binds itself to the configured `R2_ENDPOINT` and `R2_BUCKET` on first use. If you upgrade an existing populated database created before bucket binding was added, the app stops with a clear error. Stop the app, back up its SQLite database, verify which bucket its data belongs to, and bind it once:

```sh
node --env-file=.env scripts/bind-legacy-db.mjs \
  --confirm-endpoint https://ACCOUNT_ID.r2.cloudflarestorage.com/ \
  --confirm-bucket YOUR_BUCKET
```

If `DATABASE_PATH` is not set in `.env`, the script uses `.data/optimizer.sqlite`. In a container, run `node /app/scripts/bind-legacy-db.mjs` with the same confirmation arguments; the configured environment and `/app/data/optimizer.sqlite` volume are already available. The script refuses a missing database, a mismatched confirmation, or a database already bound to another bucket. It never contacts R2.

| Variable | Purpose |
| --- | --- |
| `R2_ENDPOINT` | R2 S3 endpoint, such as `https://ACCOUNT_ID.r2.cloudflarestorage.com` |
| `R2_BUCKET` | The single configured bucket |
| `R2_ACCESS_KEY_ID` | Bucket-scoped access key |
| `R2_SECRET_ACCESS_KEY` | Bucket-scoped secret |
| `APP_PASSWORD` | Private app password, required for all app access |
| `DATABASE_PATH` | SQLite file path; defaults to `.data/optimizer.sqlite` locally |

Do not put credentials in `NUXT_PUBLIC_*` variables. The app writes temporary image files to the system temporary directory and removes them after validation. The job details endpoint, `/api/jobs/<id>`, includes each item's status, error, and backup key for recovery.

## Coolify deployment

1. Deploy the repository as a Dockerfile application on port `3000`.
2. Set the environment variables above using a bucket-scoped R2 Object Read & Write token. Use the complete account endpoint, including any jurisdiction suffix needed for the bucket.
3. Mount a **local** persistent volume at `/app/data`. The image sets `DATABASE_PATH=/app/data/optimizer.sqlite`. Run one app instance. SQLite [WAL requires all database users on the same host and does not work over a network filesystem](https://www.sqlite.org/wal.html); the lease is a guard against accidental extra processes, not a multi-host deployment setup.
4. Enable HTTPS and use `/api/health` as the health check. It checks SQLite availability and configuration presence, not a live R2 request.
5. Run a narrow scan, inspect its results, and start a small optimization job before processing a larger prefix.

The image includes Perl for the vendored ExifTool. Structured scan, job, and item events are written to standard output. The worker handles one image at a time and waits for the current image to finish during graceful shutdown.

## Development checks

```sh
npm test
npm run test:coverage
npm run check
```

The suite covers the dashboard actions, HTTP authentication and validation, scan persistence and recovery, candidate filtering, image and metadata validation, backup verification, replacement reconciliation, bucket binding, worker lease takeover, and database migration. Tests use temporary SQLite databases, local JPEG fixtures, and mocked R2 operations. They do not need R2 credentials or write to a real bucket. `npm run check` runs coverage, typechecking, a production build, and a built-server smoke check; GitHub Actions runs it on Node 22 and 24. The coverage gate catches large regressions, but a passing percentage alone does not prove every failure mode is covered.

A live backup and conditional replacement still need a small, explicitly started test job in your own R2 bucket. The automated tests do not exercise Cloudflare's S3 implementation, deployment configuration, or a browser against a running production server.
