# HTTP API

The dashboard uses the same JSON API described here. The API is served by the running BucketLean app; the [VitePress documentation site](../index.md) is static and does not proxy requests or connect to R2.

## Base URL and authentication

Locally, the base URL is `http://localhost:3000`. Use your deployed HTTPS app URL outside localhost. Every route except `GET /api/health` requires HTTP Basic authentication. The server ignores the username; the password is `APP_PASSWORD`. For an interactive command, `curl --user operator` prompts for the password without placing it in the command text:

```sh
curl --user operator http://localhost:3000/api/buckets
```

This is one shared application password, not a set of scoped API tokens. Keep it out of source control and use HTTPS for remote calls. R2 credentials belong only in the server environment; clients never send them to this API.

## Typical workflow

1. `GET /api/buckets` to choose a configured profile, then `POST /api/scan` with its `bucketId` and a narrow prefix. A scan reads R2 only.
2. Poll `GET /api/overview?bucketId=...` until `scan.status` is `completed`; check `metadataErrorCount` as well.
3. Inspect `GET /api/objects?bucketId=...` with the same prefix and size filter.
4. `POST /api/jobs` with the same `bucketId` to start a job. This can replace qualifying JPEGs after backup and verification.
5. Poll `GET /api/jobs/:id` until the job is terminal or needs intervention. Use the resume or reconcile endpoint when appropriate.

See the [copyable workflow](./workflow.md) and [endpoint reference](./endpoints.md).

## Common conventions

| Convention | Behavior |
| --- | --- |
| Request body | JSON for `POST /api/scan` and `POST /api/jobs`; send `Content-Type: application/json`. Resume and reconcile need no body. |
| Bucket selection | `bucketId` is required for list/read and create requests when multiple profiles are configured; a sole profile is selected automatically. Job-ID routes use the stored bucket. |
| Prefix | A literal, case-sensitive R2 key prefix, at most 1,024 characters. `""` means the whole bucket or all keys in the completed scan. |
| Sizes | Bytes, not MiB. `1048576` is 1 MiB. |
| Pages | One-based `page` numbers; object and job-item lists contain at most 100 rows per page. |
| Asynchronous work | A `202` response means work was queued, not that a scan or optimization has completed. |
| Timestamps | Saved timestamps are ISO 8601 strings; `nextRetryAt` is a Unix timestamp in **milliseconds**. |

Invalid input returns `400`, missing authentication `401`, a missing job `404`, and a state conflict such as an active job or no eligible candidates `409`. A missing R2 connection on a write endpoint returns `503`. Unexpected server/database errors may return `500`. The API currently has no version prefix, API token scopes, webhook callbacks, or idempotency-key contract. Treat status and result fields as the durable source of truth rather than assuming a successful `POST` finished the work.
