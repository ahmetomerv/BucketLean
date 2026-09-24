import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const scans = sqliteTable('scans', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  prefix: text('prefix').notNull(),
  status: text('status', { enum: ['queued', 'running', 'completed', 'failed'] }).notNull(),
  discoveredCount: integer('discovered_count').notNull().default(0),
  jpegCount: integer('jpeg_count').notNull().default(0),
  metadataErrorCount: integer('metadata_error_count').notNull().default(0),
  cursor: text('cursor'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
})

export const objects = sqliteTable('objects', {
  key: text('key').primaryKey(),
  scanId: integer('scan_id').notNull().references(() => scans.id),
  etag: text('etag'),
  size: integer('size').notNull(),
  lastModified: text('last_modified'),
  isJpeg: integer('is_jpeg', { mode: 'boolean' }).notNull(),
  isOptimized: integer('is_optimized', { mode: 'boolean' }),
  metadataStatus: text('metadata_status', { enum: ['known', 'unknown', 'not_applicable'] }).notNull(),
  metadataError: text('metadata_error'),
  optimizerVersion: text('optimizer_version'),
  optimizedSize: integer('optimized_size'),
  savedPercent: integer('saved_percent'),
  discoveredAt: text('discovered_at').notNull(),
})

export const optimizationJobs = sqliteTable('optimization_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  scanId: integer('scan_id').references(() => scans.id),
  prefix: text('prefix').notNull().default(''),
  minBytes: integer('min_bytes').notNull().default(0),
  status: text('status', { enum: ['queued', 'running', 'completed'] }).notNull(),
  preset: text('preset', { enum: ['archival', 'balanced', 'aggressive'] }).notNull(),
  minimumSavingPercent: integer('minimum_saving_percent').notNull().default(15),
  backupOriginals: integer('backup_originals', { mode: 'boolean' }).notNull().default(true),
  preserveMetadata: integer('preserve_metadata', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
})

export const optimizationItems = sqliteTable('optimization_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id').notNull().references(() => optimizationJobs.id),
  key: text('key').notNull(),
  etag: text('etag'),
  originalSize: integer('original_size').notNull(),
  optimizedSize: integer('optimized_size'),
  savedPercent: integer('saved_percent'),
  status: text('status', { enum: ['pending', 'downloading', 'processing', 'uploading', 'completed', 'skipped', 'failed'] }).notNull(),
  error: text('error'),
  backupKey: text('backup_key'),
  originalSha256: text('original_sha256'),
  optimizedSha256: text('optimized_sha256'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
})
