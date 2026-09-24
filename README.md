# R2 JPEG Optimizer

A private, self-hosted Nuxt application for finding and recompressing JPEGs in one Cloudflare R2 bucket. It uses one sequential worker, SQLite for persistent jobs, Sharp/MozJPEG for compression, and ExifTool to verify photo metadata.

For component and data-flow diagrams with examples, see the [architecture overview](docs/architecture.md).

## Documentation site

The [VitePress documentation](docs/index.md) includes the [HTTP API reference](docs/api/endpoints.md), an [automation workflow](docs/api/workflow.md), architecture, and recovery procedures. It builds separately from the private app into static files; it does not need R2 credentials:

```sh
npm ci
npm run docs:dev
npm run docs:check
```

`docs:dev` serves the documentation at `http://localhost:5173/` by default. It is separate from the Nuxt app at `http://localhost:3000/`. `docs:preview` serves the built static site at `http://localhost:4173/` by default.

Publish `docs/.vitepress/dist` with any static host. The default build uses `/` as its base; for a subpath, set a matching base during both build and verification, for example `DOCS_BASE=/r2-jpeg-optimizer/ npm run docs:check`. Use `npm run docs:preview` for a local preview. The site is not automatically deployed; [operations and recovery](docs/operations.md#build-and-publish-this-documentation) has the publishing details.

## How it works

1. Scan the whole bucket or a prefix. The scan lists objects and reads JPEG object metadata; it never writes to R2.
2. Filter by key prefix and minimum file size. Only JPEGs confirmed as not previously optimized enter a job. Objects with unknown metadata are excluded. Candidate keys are read and inserted into one SQLite transaction in batches of 100, so job creation does not hold the entire candidate list in memory.
3. Start a job with Archival (90), Balanced (82), or Aggressive (72) JPEG quality. Balanced and a 15% minimum saving are the defaults.
4. For each item, the worker checks that its ETag and size still match the scan, downloads it, inspects it with ExifTool, recompresses it, validates the complete JPEG and dimensions, and compares required EXIF and ICC metadata when preservation is enabled.
5. If the saving reaches the threshold, the worker records the original and optimized SHA-256 hashes, stores and verifies the original under `__optimizer/originals/<job-id>/`, and saves a `backup_verified_at` timestamp. It also writes and reads back a JSON restore manifest under `__optimizer/manifests/<job-id>/` before replacing the source. The manifest maps the backup to the original key, SHA-256 hash, size, ETag, and original object headers and custom metadata. It saves `replacement_attempted_at` before conditionally replacing the source using its original ETag. It then reads back the source and backup and checks their hashes before marking the item complete. The backup and manifest writes use `If-None-Match: *`; the source write uses `If-Match`. [R2 supports these S3 conditional operations](https://developers.cloudflare.com/r2/api/s3/api/).

The backup is mandatory in this MVP, even though the job schema reserves a backup setting. If a backup fails verification, the source is not replaced. An already optimized object or an image with insufficient savings is skipped. A source changed since the scan is recorded separately as `source_changed`; an invalid input JPEG is `invalid_jpeg`. One ordinary failed or uncertain item does not stop the others. Jobs resume unfinished items after a restart; an upload completed just before a crash is reconciled from its object metadata and the saved source and backup hashes. Every image download streams to a private temporary file with a 128 MiB byte cap, including when R2 omits `Content-Length`. Verification hashes the streamed file without loading a second full image into memory. Compression still loads a capped original into memory and Sharp may use additional native memory for decoded pixels.

### Failures, retries, and pauses

The [AWS SDK has its own request retries](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html). After it returns a final error, the application classifies it. Network timeouts, HTTP 429, and HTTP 5xx get at most **two application retries** after the first transient failure, with persisted 2-second and 4-second delays. The item stores `attemptCount`, `transientFailures`, `nextAttemptAt`, and `errorKind` in SQLite. A restart honors the saved deadline and retry count; it does not start the retry budget over. Before retrying any item that reached backup or replacement, the worker first checks the current source and backup hashes. When the budget is exhausted, an item with no possible write becomes `failed`; an item whose remote write cannot be established remains `needs_attention`.

Credential failures such as HTTP 401/403 and bucket-wide errors such as `NoSuchBucket` put the whole job in `paused`. No further items run. Correct the R2 credentials, permissions, bucket, or endpoint, then press **Resume job** or call `POST /api/jobs/<id>/resume`. The job continues from its persisted item state and rechecks any earlier write intent. Paused jobs block new scans and optimization jobs. Invalid JPEGs and exhausted ordinary failures are terminal item errors; their job ends as `completed_with_errors`. Changed sources are a separate safety outcome and are never overwritten using a stale ETag. If a source changes after a write intent, its item stays `needs_attention` so the source and backup can be inspected.

Job summaries count changed sources, invalid JPEGs, ordinary failures, and items needing attention separately. Savings totals are unknown while a replacement is unresolved or a source changed outside the job. Older completed jobs with failed items are migrated to `completed_with_errors` on startup without contacting R2.

### Uncertain replacements and recovery

An upload timeout does not prove whether R2 accepted the write. If a backup, manifest, or replacement cannot be verified after the retry budget, or verification finds a mismatched object, the item becomes `needs_attention` and the job ends in `needs_attention` after the remaining items finish. The dashboard shows final bytes and savings as **Pending verification** while any item has an unknown replacement state. It blocks new scans and jobs until the uncertain job is resolved, so a new scan cannot hide a replacement that may already have happened. The job detail endpoint, `/api/jobs/<id>`, shows each item's error, error kind, retry fields, backup and manifest keys, hashes, `backupVerifiedAt`, `manifestVerifiedAt`, and `replacementAttemptedAt`.

Use **Recheck remote state** on the dashboard, or `POST /api/jobs/<id>/reconcile`, after the R2 connection has recovered. The worker reads the source and backup, verifies both hashes, and checks the optimizer metadata. If the optimized source and its original backup match the saved intent, it completes the item without another source write. If the original still matches its recorded hash, ETag, and size, it may recreate a missing backup and retry the source write with the same conditional protection. A changed source, a mismatched backup, or an unavailable read stays `needs_attention`; inspect the two objects and the item error before rechecking again. Do not treat an uncertain item as a failed optimization or delete its backup until its remote state is established.

On first startup after this update, older `failed` items with a saved backup key and both hashes are moved to `needs_attention` for reconciliation, including their completed jobs. This one-time database migration does not contact R2 or change any objects. Back up the SQLite file before upgrading as usual.

The database is bound to one R2 endpoint and bucket. Startup refuses a different bucket or account endpoint, so old scan results cannot be used against another bucket. A SQLite worker lease chooses one process to run scans and jobs; it is renewed while that process is alive and can be claimed after expiry if the process crashes. A worker that loses the lease stops before further uploads, leaving unfinished work for the next owner. Conditional R2 replacement still protects the source if a lease expires during an in-flight request.

Optimized objects receive `image-optimizer-version`, `image-optimizer-quality`, `image-optimizer-date`, `image-optimizer-job-id`, `image-optimizer-item-id`, and `original-size` custom R2 metadata. They are excluded from future jobs. The manifest prefix is separate from `__optimizer/originals/`, so a lifecycle rule targeting only originals will not erase the key mapping. **Do not enable a backup expiration rule until you have exported a SQLite snapshot, verified the manifests, and completed a restore drill in your bucket.** An [R2 object lifecycle rule](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) can later expire only the `__optimizer/originals/` prefix at a retention period you choose. The application does not automatically restore objects or delete backups.

### Backup recovery drill

Use the [SQLite backup API](https://www.sqlite.org/backup.html) through the snapshot command rather than copying a live WAL database file. Choose a new output path for every snapshot and copy verified snapshots to storage outside the app host:

```sh
node --env-file=.env scripts/snapshot-db.mjs --output .data/snapshots/optimizer-YYYY-MM-DD.sqlite
```

The command refuses to overwrite a snapshot, verifies SQLite integrity, and reports the saved bucket identity and row counts. It also works on an older unbound database and reports `bucket: null`; confirm and bind that database before writing manifests. For backups created before manifests were added, backfill them in the configured bucket. The dry run downloads each recorded backup and checks its size and SHA-256 hash without writing to R2:

```sh
node --env-file=.env scripts/backfill-manifests.mjs
node --env-file=.env scripts/backfill-manifests.mjs --apply
```

For an older unbound database, use `--verify-unbound` for the read-only hash check, then use the [legacy binding command](#local-development) with the verified bucket and run `--apply`. The backfill refuses a bucket identity mismatch, writes manifests without overwriting existing ones, and reads each manifest back. It does not change SQLite job records.

The restore drill needs only the bucket credentials and the manifest stored in R2; it does not read SQLite. By default it selects the first manifest under `__optimizer/manifests/`. Pass `--manifest-key KEY` to select another. The dry run verifies the backup hash. With `--apply`, it restores to a unique key under `__optimizer/restore-drills/`, then verifies the restored hash and headers and checks that the original source key was untouched:

```sh
node --env-file=.env scripts/restore-drill.mjs
node --env-file=.env scripts/restore-drill.mjs --apply
```

The drill leaves its restored object in the bucket for inspection. Remove that drill object when you no longer need it. Keep the manifest and an off-host SQLite snapshot beyond any original-backup retention period.

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

Do not put credentials in `NUXT_PUBLIC_*` variables. Provide writable system temporary storage for at least one 128 MiB download plus the image validation files. The worker removes temporary downloads after success or handled failure. The job details endpoint, `/api/jobs/<id>`, includes each item's status, error, and backup key for recovery.

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

The suite covers the dashboard actions, HTTP authentication and validation, scan persistence and recovery, candidate filtering, image and metadata validation, backup and manifest verification, replacement reconciliation, durable retry deadlines and exhaustion, credential pause and resume, failure classification, bucket binding, worker lease takeover, SQLite snapshots, and database migration. Tests use temporary SQLite databases, local JPEG fixtures, and mocked R2 operations. They do not need R2 credentials or write to a real bucket. `npm run check` runs coverage, typechecking, a production build, and a built-server smoke check; GitHub Actions runs it on Node 22 and 24. The coverage gate catches large regressions, but a passing percentage alone does not prove every failure mode is covered.

### Performance baseline

On a local synthetic scan with 5,000 eligible keys, job creation made **0 R2 requests**. A single run before batching took 146 ms and added about 25 MiB of JavaScript heap; a single run after batching took 107 ms and added about 19 MiB. These are indicative process measurements, not a throughput guarantee. Reproduce the job-creation measurement with `PERF_BENCH=1 npx vitest run server/utils/jobs.test.ts -t 'measures large job creation'`.

A read-only test-bucket download of an existing 8,060,807-byte backup through the capped stream took 905 ms and increased process RSS by about 25 MiB. This issued one `GetObject` command and included SDK setup and request overhead. No object was written during that check.

The mocked successful optimization path makes **14 R2 operations**: the source and backup reads and writes, header checks, and manifest write/readback (including reconciliation). The test asserts that count after the download change; SDK retries can add requests in a live run. The backup remains a conditional `PutObject` followed by hash and header verification. A server-side copy could avoid uploading backup bytes, but [R2 destination copy conditions are beta and are not atomic relative to source conditions](https://developers.cloudflare.com/r2/api/s3/extensions/). Test copy behavior separately before considering that change, and retain backup verification.

A live backup and conditional replacement still need a small, explicitly started test job in your own R2 bucket. The automated tests do not exercise Cloudflare's S3 implementation, deployment configuration, or a browser against a running production server. The recovery commands above provide a separate live manifest and restore check before you configure retention.
