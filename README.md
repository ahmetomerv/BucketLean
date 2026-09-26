# BucketLean

![BucketLean logo](public/bucketlean-logo.svg)

**Self-hosted JPEG optimization for Cloudflare R2.**

BucketLean helps you find and shrink JPEGs across one or more R2 buckets. Scan first, choose the images to optimize, and follow each job in a private dashboard. You can also use its HTTP API for automation.

[Get started](docs/guide/getting-started.md) · [Documentation](docs/index.md) · [HTTP API](docs/api/index.md)

## Features

- **Read-only discovery:** Scan a bucket or prefix and review eligible JPEGs before starting a job.
- **Control over compression:** Choose the images, quality preset, and minimum saving.
- **Verified originals:** Every replacement requires a checked backup and restore manifest. Backups are retained by default.
- **Recoverable jobs:** Progress is saved in SQLite, with options to resume paused jobs and recheck uncertain writes.
- **Multiple buckets:** Configure and manage more than one R2 bucket from the same app.

## Quick start

Requires Node.js 22 or newer, npm, and an R2 bucket.

```sh
cp .env.example .env
# Set APP_PASSWORD and your R2 credentials in .env.
npm ci
npm run dev
```

Open `http://localhost:3000` and sign in with the configured password. Use a token with Object Read & Write access to optimize images; read-only access is enough to scan. See the [setup guide](docs/guide/getting-started.md) for single- and multi-bucket configuration and HTTPS deployment.

## Usage

1. Scan a small prefix and review the JPEGs found.
2. Select the images you want to optimize and start a job.
3. Check the results and verify the images in any app that uses the bucket.

Optimization replaces qualifying objects in R2 after verifying their original backups. Start with a few images before running a larger job. The [operations guide](docs/operations.md) covers snapshots, restore drills, and recovery.

## Documentation

- [Getting started and deployment](docs/guide/getting-started.md)
- [HTTP API and automation](docs/api/index.md)
- [Architecture](docs/architecture.md)
- [Operations and recovery](docs/operations.md)

To run the documentation site locally, use `npm run docs:dev`.

## Development

```sh
npm test
npm run check
```
