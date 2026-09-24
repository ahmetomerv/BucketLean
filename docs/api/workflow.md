# Automation workflow

These commands use the running app API, so they share its SQLite database, single worker lease, and backup safeguards. They are examples for a narrow test prefix. `curl --user operator` prompts for the application password on each call; set `APP_PASSWORD` on the **server**, not in a published script.

```sh
export OPTIMIZER_URL=http://localhost:3000
export OPTIMIZER_BUCKET_ID=photos

# List available profile IDs first.
curl --fail-with-body --user operator "$OPTIMIZER_URL/api/buckets"

# 1. Queue a read-only scan.
curl --fail-with-body --user operator \
  --header 'Content-Type: application/json' \
  --data "{\"bucketId\":\"$OPTIMIZER_BUCKET_ID\",\"prefix\":\"photos/test/\"}" \
  "$OPTIMIZER_URL/api/scan"

# 2. Repeat this GET until scan.status is completed; inspect metadataErrorCount.
curl --fail-with-body --user operator \
  --get --data-urlencode "bucketId=$OPTIMIZER_BUCKET_ID" --data-urlencode 'prefix=photos/test/' \
  "$OPTIMIZER_URL/api/overview"

# 3. Inspect confirmed unoptimized candidate keys. Request subsequent pages if total exceeds 100.
curl --fail-with-body --user operator \
  --get --data-urlencode "bucketId=$OPTIMIZER_BUCKET_ID" --data-urlencode 'prefix=photos/test/' \
  --data-urlencode 'minBytes=1048576' \
  --data-urlencode 'status=not_optimized' \
  "$OPTIMIZER_URL/api/objects"

# 4. Start a job only after reviewing the completed scan and candidates.
curl --fail-with-body --user operator \
  --header 'Content-Type: application/json' \
  --data "{\"bucketId\":\"$OPTIMIZER_BUCKET_ID\",\"prefix\":\"photos/test/\",\"minBytes\":1048576,\"preset\":\"balanced\",\"minimumSavingPercent\":15,\"preserveMetadata\":true,\"deleteBackupAfterOptimization\":false}" \
  "$OPTIMIZER_URL/api/jobs"

# 5. Use the returned job.id; repeat until it is terminal or needs intervention.
curl --fail-with-body --user operator "$OPTIMIZER_URL/api/jobs/42"
```

Do not make the job request immediately after the scan request: `202` only means it was queued. Check `scan.status` first. A job can end as `completed`, `completed_with_errors`, `paused`, or `needs_attention`; automation should report the last three for review. `sourceChanged` is a separate count, and final byte totals may be `null` when a source changed outside the job.

After a successful job, verify representative images in any application serving or indexing the same bucket. The optimizer does not refresh that application's stored file sizes, thumbnails, or caches. If they remain stale, use the application's refresh, reindex, or reprocess action after checking its behavior. A ChronoFrame dashboard **Reprocess** refreshed stale displayed sizes in one verified run.

If credentials or the bucket failed, correct the server configuration and call `POST /api/jobs/:id/resume`. If remote replacement state is uncertain, inspect the item's backup key, hashes, and error, then call `POST /api/jobs/:id/reconcile`. Avoid automatically repeating `POST /api/jobs` on a timeout: the first request may already have created a job. Use `GET /api/jobs?bucketId=photos` and the known job ID to check before retrying. The API has no idempotency-key feature yet.

After reviewing job `42`, use only the action that matches its current status:

```sh
# For a paused job, after correcting access or configuration:
curl --fail-with-body --user operator --request POST "$OPTIMIZER_URL/api/jobs/42/resume"

# For a needs_attention job, after inspecting its item and remote state:
curl --fail-with-body --user operator --request POST "$OPTIMIZER_URL/api/jobs/42/reconcile"
```

For every endpoint, see the [reference](./endpoints.md). For backup and database recovery outside the HTTP API, see [Operations and recovery](../operations.md).
