# R2 JPEG Optimizer

A private, self-hosted Nuxt application for finding and recompressing JPEGs in one Cloudflare R2 bucket. It uses one sequential worker, SQLite for persistent jobs, Sharp/MozJPEG for compression, and ExifTool to verify photo metadata.

## How it works

1. Scan the whole bucket or a prefix. The scan lists objects and reads JPEG object metadata; it never writes to R2.
2. Filter by key prefix and minimum file size. Only JPEGs confirmed as not previously optimized enter a job. Objects with unknown metadata are excluded.
3. Start a job with Archival (90), Balanced (82), or Aggressive (72) JPEG quality. Balanced and a 15% minimum saving are the defaults.
4. For each item, the worker checks that its ETag and size still match the scan, downloads it, inspects it with ExifTool, recompresses it, validates the complete JPEG and dimensions, and compares required EXIF and ICC metadata when preservation is enabled.
5. If the saving reaches the threshold, the worker records the original and optimized SHA-256 hashes, stores and verifies the original under `__optimizer/originals/<job-id>/`, and saves a `backup_verified_at` timestamp. It saves `replacement_attempted_at` before conditionally replacing the source using its original ETag. It then reads back the source and backup and checks their hashes before marking the item complete. The backup write uses `If-None-Match: *`; the source write uses `If-Match`. [R2 supports these S3 conditional operations](https://developers.cloudflare.com/r2/api/s3/api/).

The backup is mandatory in this MVP, even though the job schema reserves a backup setting. If a backup fails verification, the source is not replaced. An already optimized object or an image with insufficient savings is skipped. A source changed since the scan is recorded separately as `source_changed`; an invalid input JPEG is `invalid_jpeg`. One ordinary failed or uncertain item does not stop the others. Jobs resume unfinished items after a restart; an upload completed just before a crash is reconciled from its object metadata and the saved source and backup hashes. Objects larger than 128 MiB are skipped to bound worker memory.

### Failures, retries, and pauses

The [AWS SDK has its own request retries](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html). After it returns a final error, the application classifies it. Network timeouts, HTTP 429, and HTTP 5xx get at most **two application retries** after the first transient failure, with persisted 2-second and 4-second delays. The item stores `attemptCount`, `transientFailures`, `nextAttemptAt`, and `errorKind` in SQLite. A restart honors the saved deadline and retry count; it does not start the retry budget over. Before retrying any item that reached backup or replacement, the worker first checks the current source and backup hashes. When the budget is exhausted, an item with no possible write becomes `failed`; an item whose remote write cannot be established remains `needs_attention`.

Credential failures such as HTTP 401/403 and bucket-wide errors such as `NoSuchBucket` put the whole job in `paused`. No further items run. Correct the R2 credentials, permissions, bucket, or endpoint, then press **Resume job** or call `POST /api/jobs/<id>/resume`. The job continues from its persisted item state and rechecks any earlier write intent. Paused jobs block new scans and optimization jobs. Invalid JPEGs and exhausted ordinary failures are terminal item errors; their job ends as `completed_with_errors`. Changed sources are a separate safety outcome and are never overwritten using a stale ETag. If a source changes after a write intent, its item stays `needs_attention` so the source and backup can be inspected.

Job summaries count changed sources, invalid JPEGs, ordinary failures, and items needing attention separately. Savings totals are unknown while a replacement is unresolved or a source changed outside the job. Older completed jobs with failed items are migrated to `completed_with_errors` on startup without contacting R2.

### Uncertain replacements and recovery

An upload timeout does not prove whether R2 accepted the write. If a backup or replacement cannot be verified after the retry budget, or verification finds a mismatched object, the item becomes `needs_attention` and the job ends in `needs_attention` after the remaining items finish. The dashboard shows final bytes and savings as **Pending verification** while any item has an unknown replacement state. It blocks new scans and jobs until the uncertain job is resolved, so a new scan cannot hide a replacement that may already have happened. The job detail endpoint, `/api/jobs/<id>`, shows each item's error, error kind, retry fields, backup key, hashes, `backupVerifiedAt`, and `replacementAttemptedAt`.

Use **Recheck remote state** on the dashboard, or `POST /api/jobs/<id>/reconcile`, after the R2 connection has recovered. The worker reads the source and backup, verifies both hashes, and checks the optimizer metadata. If the optimized source and its original backup match the saved intent, it completes the item without another source write. If the original still matches its recorded hash, ETag, and size, it may recreate a missing backup and retry the source write with the same conditional protection. A changed source, a mismatched backup, or an unavailable read stays `needs_attention`; inspect the two objects and the item error before rechecking again. Do not treat an uncertain item as a failed optimization or delete its backup until its remote state is established.

On first startup after this update, older `failed` items with a saved backup key and both hashes are moved to `needs_attention` for reconciliation, including their completed jobs. This one-time database migration does not contact R2 or change any objects. Back up the SQLite file before upgrading as usual.

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

The suite covers the dashboard actions, HTTP authentication and validation, scan persistence and recovery, candidate filtering, image and metadata validation, backup verification, replacement reconciliation, durable retry deadlines and exhaustion, credential pause and resume, failure classification, bucket binding, worker lease takeover, and database migration. Tests use temporary SQLite databases, local JPEG fixtures, and mocked R2 operations. They do not need R2 credentials or write to a real bucket. `npm run check` runs coverage, typechecking, a production build, and a built-server smoke check; GitHub Actions runs it on Node 22 and 24. The coverage gate catches large regressions, but a passing percentage alone does not prove every failure mode is covered.

A live backup and conditional replacement still need a small, explicitly started test job in your own R2 bucket. The automated tests do not exercise Cloudflare's S3 implementation, deployment configuration, or a browser against a running production server.
