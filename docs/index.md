---
layout: home

hero:
  name: R2 JPEG Optimizer
  text: Safely shrink JPEGs in your Cloudflare R2 bucket
  tagline: Self-hosted scans, verified originals, durable jobs, and a documented HTTP API.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Use the API
      link: /api/

features:
  - title: Discover before writing
    details: Scan a bucket or prefix, inspect eligible JPEGs, and then create a job.
  - title: Keep a verified original
    details: Every replacement requires a checked backup and independently readable restore manifest.
  - title: Recover uncertain work
    details: SQLite persists retries and upload intent so the worker can reconcile state after a failure or restart.
---

The dashboard and API are served by the same application. This documentation site builds to static HTML and can be hosted separately; it does not contain or expose your R2 credentials.
