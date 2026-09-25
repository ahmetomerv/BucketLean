# Endpoint reference

All examples use selected response fields; actual objects also contain stored timestamps, IDs, and other fields shown in the [architecture overview](../architecture.md). The route handlers in `server/api/` define the current contract.

## Health

### `GET /api/health`

Public endpoint. Returns `200` when the local SQLite check succeeds:

```json
{"status":"ok","database":"ok","r2Configured":true}
```

`r2Configured` checks whether at least one complete R2 bucket profile is configured. It does **not** contact R2 or prove that credentials work.

## Buckets

### `GET /api/buckets`

Returns the server-configured bucket profiles available to the signed-in user. Every profile has `id`, `endpoint`, and `bucket`; credentials are never returned. There is one shared app password, so every authenticated user can select every configured profile.

```json
{"buckets":[{"id":"photos","endpoint":"https://ACCOUNT_ID.r2.cloudflarestorage.com/","bucket":"photos"},{"id":"media","endpoint":"https://ACCOUNT_ID.r2.cloudflarestorage.com/","bucket":"media"}]}
```

Use the selected `id` as `bucketId` in scan/job requests and overview/object/job-list queries. With exactly one configured bucket, `bucketId` is optional. With multiple buckets, omitting it returns `400`; an unknown ID also returns `400`. The list is static server configuration and does not enumerate all buckets in an R2 account. Job detail, resume, and reconcile use the bucket saved on the job and need no `bucketId` parameter.

## Scans and discovered objects

### `POST /api/scan`

Queue a read-only R2 scan. The JSON body accepts:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `bucketId` | configured profile ID | sole profile, if only one | Select the R2 bucket and credentials. |
| `prefix` | string, at most 1,024 characters | `""` | Limit R2 listing to this literal key prefix. |

```json
{"bucketId":"photos","prefix":"photos/2026/"}
```

Returns `202` with `{ "scan": { ... }, "created": true }` for a new scan. If a scan in the selected bucket is already queued or running, returns `200` with that scan and `created: false`; it does not create a second one. An unresolved or paused optimization job in the selected bucket returns `409`. A completed scan has `status: "completed"`; a failed scan has `status: "failed"` and an `error`.

### `GET /api/overview`

Read the latest scan and aggregate counts. Accepted query parameters:

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `bucketId` | configured profile ID | sole profile, if only one | Select a bucket. |
| `prefix` | string | `""` | Limit counts to keys starting with this literal prefix. |
| `minBytes` | nonnegative safe integer | `0` | Minimum size used for `eligible`. |

Example: `GET /api/overview?bucketId=photos&prefix=photos%2F2026%2F&minBytes=1048576`

Returns `200`. `scan` is `null` before the first scan. `totals` includes `objects`, `jpegs`, `jpegBytes`, `optimized`, `eligible`, and `metadataUnknown`:

```json
{
  "scan": { "id": 7, "bucketId": "photos", "prefix": "photos/2026/", "status": "completed", "metadataErrorCount": 0 },
  "totals": { "objects": 40, "jpegs": 35, "jpegBytes": 100000000, "optimized": 5, "eligible": 25, "metadataUnknown": 1 }
}
```

`eligible` is a preview count of JPEGs at the selected size whose metadata check confirmed they are not already optimized. An `unknown` metadata result has `isOptimized: null` and is excluded from this count and from job creation. The worker also rechecks each source before replacement.

### `GET /api/objects`

List JPEG discovery rows from the latest scan, sorted by key. Query parameters:

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `bucketId` | configured profile ID | sole profile, if only one | Select a bucket. |
| `prefix` | string | `""` | Literal key prefix. |
| `minBytes` | nonnegative safe integer | `0` | Minimum stored object size. |
| `status` | `all`, `optimized`, `not_optimized`, or `unknown` | `all` | Filter by optimizer/metadata state. |
| `page` | positive safe integer | `1` | One-based page number. |

Returns `200` with `{ "items": [...], "total": 25, "page": 1, "pageSize": 100 }`. Each item includes its `scanId`, `key`, `etag`, `size`, `isJpeg`, `isOptimized`, `metadataStatus`, and `metadataError`. `total` is the count **after** filters. The endpoint lists JPEGs only. `status=all` includes JPEGs with unknown metadata; `status=not_optimized` includes only confirmed unoptimized JPEGs. Use `status=unknown` to inspect metadata failures, which cannot enter a job.

### `GET /api/objects/preview`

Return a small JPEG thumbnail for one listed object. The dashboard requests it only when **Show preview** is pressed. Pass the `bucketId`, `key`, and `scanId` from the selected `GET /api/objects` item:

```text
GET /api/objects/preview?bucketId=photos&key=photos%2F2026%2Fportrait.jpg&scanId=7
```

The route requires app authentication, confirms the JPEG belongs to the latest scan, and downloads it from R2 with the scanned ETag as a condition. It streams the original to a temporary file with a 128 MiB limit, creates a thumbnail no larger than 72 × 72 pixels, and deletes the temporary file. It never writes to R2 or returns the original image. A preview is a visual aid; the optimization job still checks the source again before replacement. Up to two previews run concurrently. A changed or stale scan returns `409`, a missing file returns `404`, an oversized file returns `413`, an invalid JPEG returns `422`, and a busy preview service returns `429`. Each requested preview costs one R2 object read.

## Jobs

### `POST /api/jobs`

Create a job from the selected bucket's latest **completed** scan. This operation starts a worker that can replace sources, after verifying backups and manifests.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `bucketId` | configured profile ID | sole profile, if only one | Select a bucket. |
| `prefix` | string, at most 1,024 characters | `""` | Literal source-key prefix within the completed scan. |
| `minBytes` | nonnegative safe integer | `1048576` | Minimum original size in bytes. The dashboard's **Minimum original size (MiB)** control accepts 1–50 MiB and sends this value in bytes; the API can also accept 0. |
| `preset` | `archival`, `balanced`, or `aggressive` | `balanced` | JPEG qualities 90, 82, or 72. |
| `minimumSavingPercent` | integer from 1 to 99 | `15` | Required saving before replacement. |
| `preserveMetadata` | boolean | `true` | Require selected EXIF/ICC data to survive optimization. |
| `backupOriginals` | boolean | `true` | Optional compatibility field. Omit it; backups are always required. Explicit `false` is rejected. |
| `deleteBackupAfterOptimization` | boolean | `false` | After verifying the optimized source, delete its original backup and restore manifest. Removes the per-image restore copy. |

```json
{
  "bucketId": "photos",
  "prefix": "photos/2026/",
  "minBytes": 1048576,
  "preset": "balanced",
  "minimumSavingPercent": 15,
  "preserveMetadata": true,
  "deleteBackupAfterOptimization": false
}
```

Returns `202` with a `job` object initially marked `queued` and a `count` of candidate items. A running scan or unresolved/active job in the selected bucket, no completed scan, no eligible items, or `backupOriginals: false` causes `409`. Candidate rows are persisted before the asynchronous worker starts.

### `GET /api/jobs`

Accepts `bucketId` as a query parameter and returns `200` with `{ "jobs": [...] }` for that bucket. It includes the ten newest jobs plus all paused or `needs_attention` jobs, even when older. Each entry is a job summary as described below. This is a dashboard-oriented list, not an endpoint for paginating full job history; save the ID returned by `POST /api/jobs`.

### `GET /api/jobs/:id`

Returns `200` with a job summary and one page of item details. `:id` is a positive integer. Optional `page` defaults to `1`; `pageSize` is `100`. An unknown ID returns `404`.

A summary contains `job`, counts (`total`, `completed`, `skipped`, `sourceChanged`, `invalidJpeg`, `failed`, `needsAttention`), `current`, `originalBytes`, `finalBytes`, `savedBytes`, `savedPercent`, and `nextRetryAt`. `current` is the active key/status or `null`; `nextRetryAt` is a Unix millisecond timestamp or `null`. `finalBytes`, `savedBytes`, and `savedPercent` can be `null` while a replacement or changed source has an unknown final size.

```json
{
  "job": { "id": 42, "bucketId": "photos", "status": "completed", "preset": "balanced", "minimumSavingPercent": 15 },
  "total": 1,
  "completed": 1,
  "skipped": 0,
  "sourceChanged": 0,
  "invalidJpeg": 0,
  "failed": 0,
  "needsAttention": 0,
  "current": null,
  "originalBytes": 10000000,
  "finalBytes": 8000000,
  "savedBytes": 2000000,
  "savedPercent": 20,
  "nextRetryAt": null,
  "items": [{ "id": 301, "jobId": 42, "key": "photos/2026/example.jpg", "status": "completed", "originalSize": 10000000, "optimizedSize": 8000000 }],
  "page": 1,
  "pageSize": 100
}
```

An item can expose `error`, `errorKind`, `attemptCount`, `transientFailures`, `nextAttemptAt`, `backupKey`, `manifestKey`, `originalSha256`, `optimizedSha256`, `backupVerifiedAt`, `manifestVerifiedAt`, `replacementAttemptedAt`, `cleanupPendingAt`, `backupDeletedAt`, and `manifestDeletedAt`. For opt-in cleanup, saved backup and manifest keys remain in the history even after those R2 objects are deleted. Treat keys, hashes, and errors as operational data; avoid posting job responses to public logs.

### `POST /api/jobs/:id/resume`

Returns `202` with `{ "jobId": 42 }` when a `paused` job is queued again. Correct the credential or bucket problem first. Returns `409` if the job is not paused or a scan is active; `404` if the ID does not exist.

### `POST /api/jobs/:id/reconcile`

Returns `202` with `{ "jobId": 42 }` when a `needs_attention` job is queued to inspect source and backup state again. This is for uncertain remote writes; it does not blindly overwrite a changed source. Returns `409` when the job is not in that state or conflicting work in that bucket is active; `404` if the ID does not exist.

## Status values

| Level | Values | Meaning |
| --- | --- | --- |
| Scan | `queued`, `running`, `completed`, `failed` | Scan progress. Only a completed scan supplies a new job. |
| Job | `queued`, `running`, `paused`, `completed`, `completed_with_errors`, `needs_attention` | `paused` needs access/configuration repair; `needs_attention` needs source/backup inspection. |
| Item | `pending`, `downloading`, `processing`, `uploading`, `cleanup_pending`, `retry_wait`, `completed`, `skipped`, `source_changed`, `invalid_jpeg`, `failed`, `needs_attention` | `cleanup_pending` verifies the optimized source and removes the opt-in backup and manifest; `retry_wait` resumes after its persisted deadline. |
