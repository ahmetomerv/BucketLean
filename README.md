# R2 JPEG Optimizer

A private, self-hosted Nuxt application for finding and recompressing JPEGs in one or more Cloudflare R2 buckets. It uses one sequential worker, SQLite for persistent jobs, Sharp/MozJPEG for compression, and ExifTool to verify photo metadata.

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

A verified backup is mandatory before replacement, even when opt-in cleanup is enabled. If a backup fails verification, the source is not replaced. An already optimized object or an image with insufficient savings is skipped. A source changed since the scan is recorded separately as `source_changed`; an invalid input JPEG is `invalid_jpeg`. One ordinary failed or uncertain item does not stop the others. Jobs resume unfinished items after a restart; an upload completed just before a crash is reconciled from its object metadata and the saved source and backup hashes. Every image download streams to a private temporary file with a 128 MiB byte cap, including when R2 omits `Content-Length`. Verification hashes the streamed file without loading a second full image into memory. Compression still loads a capped original into memory and Sharp may use additional native memory for decoded pixels.

### Failures, retries, and pauses

The [AWS SDK has its own request retries](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html). After it returns a final error, the application classifies it. Network timeouts, HTTP 429, and HTTP 5xx get at most **two application retries** after the first transient failure, with persisted 2-second and 4-second delays. The item stores `attemptCount`, `transientFailures`, `nextAttemptAt`, and `errorKind` in SQLite. A restart honors the saved deadline and retry count; it does not start the retry budget over. Before retrying any item that reached backup or replacement, the worker first checks the current source and backup hashes. When the budget is exhausted, an item with no possible write becomes `failed`; an item whose remote write cannot be established remains `needs_attention`.

Credential failures such as HTTP 401/403 and bucket-wide errors such as `NoSuchBucket` put the whole job in `paused`. No further items run. Correct the R2 credentials, permissions, bucket, or endpoint, then press **Resume job** or call `POST /api/jobs/<id>/resume`. The job continues from its persisted item state and rechecks any earlier write intent. Paused jobs block new scans and optimization jobs for their bucket. Other configured buckets can continue. Invalid JPEGs and exhausted ordinary failures are terminal item errors; their job ends as `completed_with_errors`. Changed sources are a separate safety outcome and are never overwritten using a stale ETag. If a source changes after a write intent, its item stays `needs_attention` so the source and backup can be inspected.

Job summaries count changed sources, invalid JPEGs, ordinary failures, and items needing attention separately. Savings totals are unknown while a replacement is unresolved or a source changed outside the job. A job with terminal item errors reports `completed_with_errors`.

### Optional backup cleanup

The **Delete each original backup after the optimized image is verified** checkbox is off by default. It is a per-job setting (`deleteBackupAfterOptimization: true` in `POST /api/jobs`). The worker still creates and verifies the original backup and restore manifest before replacing a source. It then verifies the optimized source, records `cleanup_pending` in SQLite, rechecks the source and backup, deletes the backup, verifies it is absent, deletes the manifest, verifies it is absent, and marks the item `completed`. This saves the retained backup storage but removes the per-image restore copy. The optimized object at the original key is never deleted by this option.

If cleanup fails or the process restarts, its saved state resumes without recompressing or replacing the source again. A transient failure uses the normal bounded retry policy; an unresolved mismatch becomes `needs_attention`. Skipped, invalid, or unverified replacements keep any backup they need for recovery. Cleanup cannot guarantee an atomic relationship between verifying an object and deleting it; use this option only when you accept losing the original rollback copy after success.

### Uncertain replacements and recovery

An upload timeout does not prove whether R2 accepted the write. If a backup, manifest, or replacement cannot be verified after the retry budget, or verification finds a mismatched object, the item becomes `needs_attention` and the job ends in `needs_attention` after the remaining items finish. The dashboard shows final bytes and savings as **Pending verification** while any item has an unknown replacement state. It blocks new scans and jobs until the uncertain job is resolved, so a new scan cannot hide a replacement that may already have happened. The job detail endpoint, `/api/jobs/<id>`, shows each item's error, error kind, retry fields, backup and manifest keys, hashes, `backupVerifiedAt`, `manifestVerifiedAt`, and `replacementAttemptedAt`.

Use **Recheck remote state** on the dashboard, or `POST /api/jobs/<id>/reconcile`, after the R2 connection has recovered. The worker reads the source and backup, verifies both hashes, and checks the optimizer metadata. If the optimized source and its original backup match the saved intent, it completes the item without another source write. If the original still matches its recorded hash, ETag, and size, it may recreate a missing backup and retry the source write with the same conditional protection. A changed source, a mismatched backup, or an unavailable read stays `needs_attention`; inspect the two objects and the item error before rechecking again. Do not treat an uncertain item as a failed optimization or delete its backup until its remote state is established.

Each configured bucket has a stable profile ID. Scans, object keys, and jobs are scoped to that ID; the same object key can appear in multiple buckets without collision. The worker uses one SQLite lease for the service, so remote operations run sequentially across all buckets. A queued scan or job in another bucket can still proceed when one bucket has a paused or uncertain job. Conditional R2 writes remain scoped to the selected bucket.

The multi-bucket schema starts with a fresh SQLite database. Existing single-bucket databases are not migrated. Stop the app and remove the old database file before starting this version; retain an external snapshot first if you need its history. The app refuses a legacy schema so it cannot mistake old rows for another bucket.

Optimized objects receive `image-optimizer-version`, `image-optimizer-quality`, `image-optimizer-date`, `image-optimizer-job-id`, `image-optimizer-item-id`, and `original-size` custom R2 metadata. They are excluded from future jobs. The manifest prefix is separate from `__optimizer/originals/`, so a lifecycle rule targeting only originals will not erase the key mapping. **Do not enable a backup expiration rule until you have exported a SQLite snapshot, verified the manifests, and completed a restore drill in your bucket.** An [R2 object lifecycle rule](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) can later expire only the `__optimizer/originals/` prefix at a retention period you choose. The application does not automatically restore objects. By default it retains backups; the per-job opt-in cleanup removes a backup and its manifest only after verifying the optimized source.

### Backup recovery drill

Use the [SQLite backup API](https://www.sqlite.org/backup.html) through the snapshot command rather than copying a live WAL database file. Choose a new output path for every snapshot and copy verified snapshots to storage outside the app host:

```sh
node --env-file=.env scripts/snapshot-db.mjs --output .data/snapshots/optimizer-YYYY-MM-DD.sqlite
```

The command refuses to overwrite a snapshot, verifies SQLite integrity, and reports all registered bucket profiles and row counts. For backups without manifests, select a bucket profile and backfill only its jobs. The dry run verifies backup size and SHA-256 before any write:

```sh
node --env-file=.env scripts/backfill-manifests.mjs --bucket-id photos
node --env-file=.env scripts/backfill-manifests.mjs --bucket-id photos --apply
```

With one configured bucket, `--bucket-id` is optional. The script checks the selected profile against SQLite, never overwrites an existing manifest, and reads each manifest back. It does not change SQLite job records.

The restore drill needs only the bucket credentials and the manifest stored in R2; it does not read SQLite. By default it selects the first manifest under `__optimizer/manifests/`. Pass `--manifest-key KEY` to select another. The dry run verifies the backup hash. With `--apply`, it restores to a unique key under `__optimizer/restore-drills/`, then verifies the restored hash and headers and checks that the original source key was untouched:

```sh
node --env-file=.env scripts/restore-drill.mjs --bucket-id photos
node --env-file=.env scripts/restore-drill.mjs --bucket-id photos --apply
```

The drill leaves its restored object in the bucket for inspection. Remove that drill object when you no longer need it. Keep the manifest and an off-host SQLite snapshot beyond any original-backup retention period.

## Local development

Requirements: Node.js 22 or newer (24 recommended), npm, and access to at least one R2 bucket.

```sh
cp .env.example .env
# Set the endpoint, bucket name, credentials, and APP_PASSWORD in .env.
npm install
npm run dev
```

Open `http://localhost:3000` and sign in with any username and your `APP_PASSWORD`. The password is required locally and in production. Use HTTPS in front of the deployed app; HTTP Basic authentication sends credentials with each request. R2 secrets remain server-side.

For an initial optimization test, scan a narrow prefix containing one or two JPEGs, check the candidate table, and start a Balanced job. **Optimization requires Object Read & Write access to the selected bucket**, through either an account-wide or bucket-scoped token. A read-only token can still scan, but backup and replacement will fail. Existing scan results and jobs live in SQLite; keep the database file when restarting the app.

For a single bucket, set the four `R2_*` values in `.env`; its profile ID is `default`. For multiple buckets, use `R2_BUCKETS_JSON` with one entry per bucket and select the bucket in the dashboard. Each entry needs `id`, `endpoint`, `bucket`, `accessKeyId`, and `secretAccessKey`. An account-wide token can be repeated for every bucket it covers; a bucket-scoped token belongs in the entry for its bucket. You can also retain the legacy `default` profile and add JSON entries, provided IDs and endpoint/bucket pairs are unique.

```dotenv
R2_BUCKETS_JSON='[{"id":"photos","endpoint":"https://ACCOUNT_ID.r2.cloudflarestorage.com","bucket":"photos","accessKeyId":"ACCOUNT_KEY","secretAccessKey":"ACCOUNT_SECRET"},{"id":"private","endpoint":"https://ACCOUNT_ID.r2.cloudflarestorage.com","bucket":"private","accessKeyId":"PRIVATE_KEY","secretAccessKey":"PRIVATE_SECRET"}]'
```

Profiles are configured on the server, not discovered from the R2 account. Grant Object Read & Write to every bucket you intend to optimize. If a token only covers one bucket, operations in another profile will pause on access failure; fix that profile's credentials and resume its job. The app does not return credentials through the API or save them in SQLite. Keep each profile ID tied to the same endpoint and bucket; changing an ID's target is refused. Restart the server after changing profile configuration. Removing a profile leaves its job history in SQLite but makes its jobs unavailable until the profile is restored.

The old single-bucket database is incompatible. With the app stopped, remove `.data/optimizer.sqlite` and its `-wal`/`-shm` sidecars, then start the app to create the new schema. In Docker, use `/app/data/optimizer.sqlite`. This discards the old scan and job history; R2 objects and backup manifests remain in their buckets.

| Variable | Purpose |
| --- | --- |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Single `default` bucket profile |
| `R2_BUCKETS_JSON` | Array of named bucket profiles; can be used by itself or alongside `default` |
| `APP_PASSWORD` | Private app password, required for all app access |
| `DATABASE_PATH` | SQLite file path; defaults to `.data/optimizer.sqlite` locally |

Do not put credentials in `NUXT_PUBLIC_*` variables. Provide writable system temporary storage for at least one 128 MiB download plus the image validation files. The worker removes temporary downloads after success or handled failure. The job details endpoint, `/api/jobs/<id>`, includes each item's status, error, and backup key for recovery.

## Coolify deployment

1. Deploy the repository as a Dockerfile application on port `3000`.
2. Set the environment variables above using R2 Object Read & Write tokens scoped to the configured buckets. Use the complete account endpoint, including any jurisdiction suffix needed for the bucket.
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

The suite covers the dashboard actions, HTTP authentication and validation, scan persistence and recovery, candidate filtering, image and metadata validation, backup and manifest verification, replacement reconciliation, durable retry deadlines and exhaustion, credential pause and resume, failure classification, multi-bucket isolation, worker lease takeover, and SQLite snapshots. Tests use temporary SQLite databases, local JPEG fixtures, and mocked R2 operations. They do not need R2 credentials or write to a real bucket. `npm run check` runs coverage, typechecking, an app build, production and development server smoke checks, plus the static docs build and dev-server smoke checks; GitHub Actions runs it on Node 22 and 24. The coverage gate catches large regressions, but a passing percentage alone does not prove every failure mode is covered.

### Performance baseline

On a local synthetic scan with 5,000 eligible keys, job creation made **0 R2 requests**. A single run before batching took 146 ms and added about 25 MiB of JavaScript heap; a single run after batching took 107 ms and added about 19 MiB. These are indicative process measurements, not a throughput guarantee. Reproduce the job-creation measurement with `PERF_BENCH=1 npx vitest run server/utils/jobs.test.ts -t 'measures large job creation'`.

A read-only test-bucket download of an existing 8,060,807-byte backup through the capped stream took 905 ms and increased process RSS by about 25 MiB. This issued one `GetObject` command and included SDK setup and request overhead. No object was written during that check.

The mocked successful optimization path with retained backups makes **14 R2 operations**: the source and backup reads and writes, header checks, and manifest write/readback (including reconciliation). The test asserts that count after the download change; SDK retries can add requests in a live run. The backup remains a conditional `PutObject` followed by hash and header verification. A server-side copy could avoid uploading backup bytes, but [R2 destination copy conditions are beta and are not atomic relative to source conditions](https://developers.cloudflare.com/r2/api/s3/extensions/). Test copy behavior separately before considering that change, and retain backup verification.

A live backup and conditional replacement still need a small, explicitly started test job in your own R2 bucket. The automated tests do not exercise Cloudflare's S3 implementation, deployment configuration, or a browser against a running production server. The recovery commands above provide a separate live manifest and restore check before you configure retention.
