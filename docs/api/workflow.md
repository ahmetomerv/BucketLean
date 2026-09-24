# Automation workflow

These commands use the running app API, so they share its SQLite database, single worker lease, and backup safeguards. They are examples for a narrow test prefix. `curl --user operator` prompts for the application password on each call; set `APP_PASSWORD` on the **server**, not in a published script.

```sh
export OPTIMIZER_URL=http://localhost:3000

# 1. Queue a read-only scan.
curl --fail-with-body --user operator \
  --header 'Content-Type: application/json' \
  --data '{"prefix":"photos/test/"}' \
  "$OPTIMIZER_URL/api/scan"

# 2. Repeat this GET until scan.status is completed; inspect metadataErrorCount.
curl --fail-with-body --user operator \
  --get --data-urlencode 'prefix=photos/test/' \
  "$OPTIMIZER_URL/api/overview"

# 3. Inspect candidate keys. Request subsequent pages if total exceeds 100.
curl --fail-with-body --user operator \
  --get --data-urlencode 'prefix=photos/test/' \
  --data-urlencode 'minBytes=1048576' \
  --data-urlencode 'status=not_optimized' \
  "$OPTIMIZER_URL/api/objects"

# 4. Start a job only after reviewing the completed scan and candidates.
curl --fail-with-body --user operator \
  --header 'Content-Type: application/json' \
  --data '{"prefix":"photos/test/","minBytes":1048576,"preset":"balanced","minimumSavingPercent":15,"preserveMetadata":true,"backupOriginals":true}' \
  "$OPTIMIZER_URL/api/jobs"

# 5. Use the returned job.id; repeat until it is terminal or needs intervention.
curl --fail-with-body --user operator "$OPTIMIZER_URL/api/jobs/42"
```

Do not make the job request immediately after the scan request: `202` only means it was queued. Check `scan.status` first. A job can end as `completed`, `completed_with_errors`, `paused`, or `needs_attention`; automation should report the last three for review. `sourceChanged` is a separate count, and final byte totals may be `null` when a source changed outside the job.

If credentials or the bucket failed, correct the server configuration and call `POST /api/jobs/:id/resume`. If remote replacement state is uncertain, inspect the item's backup key, hashes, and error, then call `POST /api/jobs/:id/reconcile`. Avoid automatically repeating `POST /api/jobs` on a timeout: the first request may already have created a job. Use `GET /api/jobs` and the known job ID to check before retrying. The API has no idempotency-key feature yet.

For every endpoint, see the [reference](./endpoints.md). For backup and database recovery outside the HTTP API, see [Operations and recovery](../operations.md).
