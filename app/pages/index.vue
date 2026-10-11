<script setup lang="ts">
import { ElMessageBox } from 'element-plus'
import ObjectPreview from '../components/ObjectPreview.vue'

type BucketInfo = { id: string, endpoint: string, bucket: string }

const { data: bucketResult } = await useFetch<{ buckets: BucketInfo[] }>('/api/buckets', { default: () => ({ buckets: [] }) })
const bucketId = ref(bucketResult.value.buckets[0]?.id ?? '')
const prefix = ref('')
const minMiB = ref(1)
const status = ref('all')
const page = ref(1)
const scanPrefix = ref('')
const busy = ref(false)
const pendingAction = ref<'' | 'scan'>('')
const actionError = ref('')
const preset = ref<'archival' | 'balanced' | 'aggressive'>('balanced')
const minimumSavingPercent = ref(15)
const preserveMetadata = ref(true)
const deleteBackupAfterOptimization = ref(false)
const selectedKeys = ref<string[]>([])
const tabs = ['optimize', 'jobs'] as const
type DashboardTab = typeof tabs[number]
const tab = ref<DashboardTab>('optimize')
const dashboardTabs = ref<{ $el: HTMLElement } | null>(null)
const minimumSizeValid = computed(() => Number.isInteger(minMiB.value) && minMiB.value >= 1 && minMiB.value <= 20)
const sizeOptions = Array.from({ length: 20 }, (_, index) => index + 1)
const statusOptions = [
  { value: 'all', label: 'All' },
  { value: 'not_optimized', label: 'Not optimized' },
  { value: 'optimized', label: 'Optimized' },
  { value: 'unknown', label: 'Unknown' },
]
const presetOptions = [
  { value: 'archival', label: 'Archival · quality 90' },
  { value: 'balanced', label: 'Balanced · quality 82' },
  { value: 'aggressive', label: 'Aggressive · quality 72' },
]
const backupDeletionHelp = 'The original is backed up before replacement. After the optimized image is verified at its original key, this option deletes that backup and its restore manifest. You will no longer have a restore copy.'

const filters = computed(() => ({ bucketId: bucketId.value, prefix: prefix.value, minBytes: minMiB.value * 1048576, status: status.value, page: page.value }))
const { data: overview, refresh: refreshOverview } = await useFetch('/api/overview', { query: filters, default: () => ({ scan: null, totals: { objects: 0, jpegs: 0, jpegBytes: 0, optimized: 0, eligible: 0, metadataUnknown: 0 } }) })
const { data: result, refresh: refreshObjects } = await useFetch('/api/objects', { query: filters, default: () => ({ items: [], total: 0, page: 1, pageSize: 10 }) })
const { data: jobsResult, refresh: refreshJobs } = await useFetch('/api/jobs', { query: computed(() => ({ bucketId: bucketId.value })), default: () => ({ jobs: [] }) })

watch([prefix, minMiB, status], () => { page.value = 1; selectedKeys.value = [] })
watch(bucketId, () => { prefix.value = ''; scanPrefix.value = ''; page.value = 1; selectedKeys.value = []; actionError.value = '' })
watch(() => overview.value.scan?.id, () => { selectedKeys.value = [] })
const scanForBucket = computed(() => overview.value.scan?.bucketId === bucketId.value ? overview.value.scan : null)
const scanning = computed(() => !!scanForBucket.value && ['queued', 'running'].includes(scanForBucket.value.status))
const bucketJobs = computed(() => jobsResult.value.jobs.filter(job => job.job.bucketId === bucketId.value))
const currentJob = computed(() => bucketJobs.value.find(job => ['needs_attention', 'paused'].includes(job.job.status)) ?? bucketJobs.value[0] ?? null)
const jobActive = computed(() => ['queued', 'running', 'paused', 'needs_attention'].includes(currentJob.value?.job.status ?? ''))
const canStartJob = computed(() => Boolean(bucketId.value && scanForBucket.value?.status === 'completed' && selectedKeys.value.length && minimumSizeValid.value) && !scanning.value && !jobActive.value && !busy.value)
const optimizeHint = computed(() => {
  if (currentJob.value?.job.status === 'paused') return 'This job is paused. Resume it from Jobs before starting another.'
  if (jobActive.value) return 'A job is already running for this bucket.'
  if (scanForBucket.value?.status !== 'completed') return 'Start a scan above, then select JPEGs in the results.'
  if (!selectedKeys.value.length) return 'Select eligible JPEGs in the results above.'
  return 'Object Read & Write access is required. The job starts only when you press the button.'
})
const maxPage = computed(() => Math.max(1, Math.ceil(result.value.total / result.value.pageSize)))
const selectableOnPage = computed(() => scanForBucket.value?.status === 'completed'
  ? result.value.items.filter(item => item.isJpeg && !item.isOptimized && item.metadataStatus === 'known' && item.scanId === scanForBucket.value?.id)
  : [])
const allOnPageSelected = computed(() => selectableOnPage.value.length > 0 && selectableOnPage.value.every(item => selectedKeys.value.includes(item.key)))
function toggleSelected(key: string, checked: boolean) {
  if (checked && !selectedKeys.value.includes(key) && selectedKeys.value.length < 5000) selectedKeys.value = [...selectedKeys.value, key]
  if (!checked) selectedKeys.value = selectedKeys.value.filter(value => value !== key)
}
function canSelectRow(row: any) {
  return selectableOnPage.value.some(item => item.key === row.key) && !jobActive.value && !scanning.value
}
function selectionDisabled(row: any) {
  const eligible = selectableOnPage.value.some(item => item.key === row.key)
  return !eligible || jobActive.value || scanning.value || (selectedKeys.value.length >= 5000 && !selectedKeys.value.includes(row.key))
}
function toggleRowSelection(key: string) {
  if (!canSelectRow({ key })) return
  toggleSelected(key, !selectedKeys.value.includes(key))
}
function onObjectRowClick(row: any, _column: unknown, event: Event) {
  const target = event.target
  if (target instanceof Element && target.closest('input, button, a, textarea, select, label')) return
  toggleRowSelection(row.key)
}
function onResultsKeydown(event: KeyboardEvent) {
  if (!['Enter', ' ', 'Space', 'space'].includes(event.key)) return
  const target = event.target
  if (!(target instanceof Element)) return
  if (target.closest('input, button, a, textarea, select')) return
  const key = target.closest('tr')?.querySelector<HTMLElement>('[data-object-key]')?.dataset.objectKey
  if (!key) return
  event.preventDefault()
  toggleRowSelection(key)
}
function togglePageSelection() {
  if (allOnPageSelected.value) {
    const keys = new Set(selectableOnPage.value.map(item => item.key))
    selectedKeys.value = selectedKeys.value.filter(key => !keys.has(key))
  } else {
    const keys = new Set(selectedKeys.value)
    for (const item of selectableOnPage.value) {
      if (keys.size >= 5000) break
      keys.add(item.key)
    }
    selectedKeys.value = [...keys]
  }
}
const number = new Intl.NumberFormat()
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const unit = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** unit).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`
}
function formatDate(value: string | null) { return value ? new Date(value).toLocaleString() : '—' }
function processedCount(summary: any) {
  return summary.completed + summary.skipped + summary.sourceChanged + summary.invalidJpeg + summary.failed + summary.needsAttention
}
function progressPercent(summary: any) {
  if (!summary.total) return 0
  return Math.min(100, Math.round(100 * processedCount(summary) / summary.total))
}
function savedLabel(summary: any) {
  if (summary.savedBytes == null) return summary.needsAttention ? 'Pending verification' : 'Unknown after source change'
  return `${formatBytes(summary.savedBytes)} (${summary.savedPercent}%)`
}
function jobTagType(status: string) {
  if (status === 'completed') return 'primary'
  if (status === 'completed_with_errors' || status === 'needs_attention' || status === 'paused') return 'warning'
  return 'info'
}
function jobRowClass({ row }: { row: any }) {
  if (row.job.status === 'paused' || row.job.status === 'needs_attention') return 'job-row-attention'
  if (row.job.status === 'queued' || row.job.status === 'running') return 'job-row-active'
  return ''
}
function objectRowClass({ row }: { row: any }) {
  const classes = []
  if (canSelectRow(row)) classes.push('object-row-selectable')
  if (selectedKeys.value.includes(row.key)) classes.push('object-row-selected')
  return classes.join(' ')
}
function objectRowKey(row: any) {
  return `${bucketId.value}:${row.scanId}:${row.key}:${row.etag}`
}
function jobRowKey(row: any) {
  return String(row.job.id)
}
function isLiveJob(status: string) {
  return ['queued', 'running', 'paused', 'needs_attention'].includes(status)
}
const liveJobs = computed(() => bucketJobs.value.filter(summary => isLiveJob(summary.job.status)))
const jobsNeedAttention = computed(() => liveJobs.value.some(summary => summary.job.status === 'paused' || summary.job.status === 'needs_attention'))
const overviewCards = computed(() => [
  ['Discovered objects', number.format(overview.value.totals.objects)],
  ['JPEGs', number.format(overview.value.totals.jpegs)],
  ['JPEG storage', formatBytes(overview.value.totals.jpegBytes)],
  ['Already optimized', number.format(overview.value.totals.optimized)],
  ['Eligible', number.format(overview.value.totals.eligible)],
])
const tabList = computed(() => [
  { id: 'optimize' as const, label: 'Optimize', badge: selectedKeys.value.length ? number.format(selectedKeys.value.length) : '' },
  { id: 'jobs' as const, label: 'Jobs', badge: liveJobs.value.length ? number.format(liveJobs.value.length) : '' },
])
function onTabListKeydown(event: KeyboardEvent) {
  if (event.key !== 'Home' && event.key !== 'End') return
  event.preventDefault()
  const next = event.key === 'Home' ? tabs[0]! : tabs[tabs.length - 1]!
  tab.value = next
  document.getElementById(`tab-${next}`)?.focus()
}
let tablist: HTMLElement | null = null

async function startScan() {
  busy.value = true
  pendingAction.value = 'scan'
  actionError.value = ''
  try {
    await $fetch('/api/scan', { method: 'POST', body: { bucketId: bucketId.value, prefix: scanPrefix.value } })
    selectedKeys.value = []
    await Promise.all([refreshOverview(), refreshObjects()])
  } catch (error: unknown) {
    actionError.value = error && typeof error === 'object' && 'data' in error
      ? String((error as { data?: { statusMessage?: string } }).data?.statusMessage ?? 'Scan could not start')
      : 'Scan could not start'
  } finally {
    busy.value = false
    pendingAction.value = ''
  }
}

async function startJob() {
  const bucketName = bucketResult.value.buckets.find(bucket => bucket.id === bucketId.value)?.bucket ?? bucketId.value
  const backupPolicy = deleteBackupAfterOptimization.value
    ? 'Original backups will be deleted after each optimized image is verified.'
    : 'Original backups will be retained for restoration.'
  const selectionLabel = `${number.format(selectedKeys.value.length)} selected JPEG${selectedKeys.value.length === 1 ? '' : 's'}`
  try {
    await ElMessageBox.confirm(
      `Are you sure you want to start an optimization job for ${selectionLabel} in ${bucketName}?\n\nSelected originals may be replaced after verification. ${backupPolicy}`,
      'Start optimization job',
      { type: 'warning', confirmButtonText: 'Start job', cancelButtonText: 'Cancel' },
    )
  } catch {
    return
  }
  busy.value = true
  actionError.value = ''
  try {
    await $fetch('/api/jobs', { method: 'POST', body: {
      bucketId: bucketId.value, scanId: scanForBucket.value?.id, selectedKeys: selectedKeys.value,
      prefix: prefix.value, minBytes: filters.value.minBytes, preset: preset.value,
      minimumSavingPercent: minimumSavingPercent.value, preserveMetadata: preserveMetadata.value,
      deleteBackupAfterOptimization: deleteBackupAfterOptimization.value,
    } })
    selectedKeys.value = []
    tab.value = 'jobs'
    await refreshJobs()
  } catch (error: unknown) {
    actionError.value = error && typeof error === 'object' && 'data' in error
      ? String((error as { data?: { statusMessage?: string } }).data?.statusMessage ?? 'Job could not start')
      : 'Job could not start'
  } finally { busy.value = false }
}

async function recheckJob(jobId = currentJob.value?.job.id) {
  if (!jobId) return
  busy.value = true
  actionError.value = ''
  try {
    await $fetch(`/api/jobs/${jobId}/reconcile`, { method: 'POST' })
    await refreshJobs()
  } catch (error: unknown) {
    actionError.value = error && typeof error === 'object' && 'data' in error
      ? String((error as { data?: { statusMessage?: string } }).data?.statusMessage ?? 'Recheck could not start')
      : 'Recheck could not start'
  } finally { busy.value = false }
}

async function resumeJob(jobId = currentJob.value?.job.id) {
  if (!jobId) return
  busy.value = true
  actionError.value = ''
  try {
    await $fetch(`/api/jobs/${jobId}/resume`, { method: 'POST' })
    await refreshJobs()
  } catch (error: unknown) {
    actionError.value = error && typeof error === 'object' && 'data' in error
      ? String((error as { data?: { statusMessage?: string } }).data?.statusMessage ?? 'Resume could not start')
      : 'Resume could not start'
  } finally { busy.value = false }
}

let pollTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  tablist = dashboardTabs.value?.$el?.querySelector('[role="tablist"]') ?? null
  tablist?.setAttribute('aria-label', 'Dashboard')
  tablist?.addEventListener('keydown', onTabListKeydown)
  pollTimer = setInterval(() => {
    if (scanning.value || jobActive.value) void Promise.all([refreshOverview(), refreshObjects(), refreshJobs()])
  }, 2000)
})
onUnmounted(() => {
  tablist?.removeEventListener('keydown', onTabListKeydown)
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <main class="page">
    <header class="brand">
      <img src="/bucketlean-logo.svg" alt="" width="72" height="72">
      <div>
        <h1>BucketLean</h1>
        <p class="lede">Scan your Cloudflare R2 bucket, review candidates, and run a sequential JPEG optimization job.</p>
      </div>
    </header>

    <el-card class="scan-card" shadow="never">
      <el-alert v-if="actionError" :title="actionError" type="error" :closable="false" show-icon class="section-gap" />
      <el-form label-position="top" @submit.prevent>
        <div class="scan-row">
          <el-form-item class="scan-field" label="R2 bucket">
            <el-select v-model="bucketId" :disabled="busy || !bucketResult.buckets.length">
              <el-option v-for="bucket in bucketResult.buckets" :key="bucket.id" :label="`${bucket.bucket} · ${bucket.id}`" :value="bucket.id" />
            </el-select>
          </el-form-item>
          <el-form-item class="scan-field" label="Scan prefix">
            <el-input v-model="scanPrefix" :disabled="!bucketId || scanning || jobActive" placeholder="Leave empty for entire bucket" />
          </el-form-item>
        </div>
        <el-button class="scan-button" type="primary" :disabled="!bucketId || scanning || jobActive || busy" :loading="scanning || pendingAction === 'scan'" :aria-busy="scanning || pendingAction === 'scan'" @click="startScan">{{ scanning ? 'Scan in progress' : pendingAction === 'scan' ? 'Starting…' : 'Start scan' }}</el-button>
      </el-form>
      <el-alert v-if="!bucketResult.buckets.length" class="section-gap" title="Configure an R2 bucket on the server before scanning." type="warning" :closable="false" show-icon />
      <p v-else class="fine">Each bucket keeps its own scan results and jobs. The worker runs one operation at a time.</p>
      <p class="fine">Leave the prefix empty to scan the whole bucket. Scanning only reads R2.</p>
      <div v-if="scanForBucket" class="meta-row">
        <span>Status: <strong>{{ scanForBucket.status }}</strong></span>
        <span>Scope: <strong>{{ scanForBucket.prefix || 'Entire bucket' }}</strong></span>
        <span>Started: {{ formatDate(scanForBucket.startedAt) }}</span>
        <span v-if="scanning">Discovered: {{ number.format(scanForBucket.discoveredCount) }}</span>
        <el-text v-if="scanForBucket.metadataErrorCount" type="warning">{{ number.format(scanForBucket.metadataErrorCount) }} metadata checks failed</el-text>
      </div>
      <p v-else-if="bucketId" class="fine">No scan yet for this bucket.</p>
      <el-alert v-if="scanForBucket?.error" class="section-gap" :title="String(scanForBucket.error)" type="error" :closable="false" show-icon />
    </el-card>

    <el-tabs ref="dashboardTabs" v-model="tab" type="border-card" stretch>
      <el-tab-pane name="optimize">
        <template #label>
          <span class="tab-label">Optimize <el-tag v-if="tabList[0]?.badge" size="small" round effect="dark">{{ tabList[0]?.badge }}</el-tag></span>
        </template>
        <div class="stat-grid">
          <el-card v-for="card in overviewCards" :key="card[0]" shadow="never">
            <p class="stat-label">{{ card[0] }}</p>
            <p class="stat-value">{{ card[1] }}</p>
          </el-card>
        </div>

        <div class="section-gap">
          <h2 class="section-title">Scan results</h2>
          <div class="meta-row">
            <span>Matching JPEGs: <strong>{{ number.format(result.total) }}</strong></span>
            <span>Selected: <strong>{{ number.format(selectedKeys.length) }}</strong></span>
          </div>
          <p class="fine">Selections persist across pages. Changing the bucket, scan, prefix, size, or status clears them. Maximum 5,000 selections. Unknown metadata is left out of eligibility.</p>
          <el-form class="section-gap" label-position="top" @submit.prevent>
            <div class="filter-grid">
              <el-form-item label="Key prefix">
                <el-input v-model="prefix" placeholder="Optional, within the scan" />
              </el-form-item>
              <el-form-item label="Minimum original size (MiB)">
                <el-select v-model="minMiB">
                  <el-option v-for="size in sizeOptions" :key="size" :label="`${size} MiB`" :value="size" />
                </el-select>
              </el-form-item>
              <el-form-item label="Status">
                <el-select v-model="status">
                  <el-option v-for="option in statusOptions" :key="option.value" :label="option.label" :value="option.value" />
                </el-select>
              </el-form-item>
            </div>
          </el-form>
          <p class="fine">Default is 1 MiB. Eligible count and scan results use this size, from 1 to 20 MiB.</p>
          <div class="button-row section-gap">
            <el-button :disabled="!selectableOnPage.length || scanning || jobActive" @click="togglePageSelection">{{ allOnPageSelected ? 'Deselect this page' : 'Select eligible on this page' }}</el-button>
            <el-button :disabled="!selectedKeys.length" @click="selectedKeys = []">Clear selection</el-button>
          </div>
        </div>

        <div class="section-gap" @keydown="onResultsKeydown">
          <el-table :data="result.items as any[]" :row-key="objectRowKey" :row-class-name="objectRowClass" @row-click="onObjectRowClick">
            <el-table-column label="Select" width="88">
              <template #default="{ row }">
                <el-checkbox :model-value="selectedKeys.includes(row.key)" :disabled="selectionDisabled(row)" :aria-label="`Select ${row.key}`" @click.stop @keydown.stop @change="toggleSelected(row.key, Boolean($event))" />
              </template>
            </el-table-column>
            <el-table-column label="Object key" min-width="240">
              <template #default="{ row }">
                <span class="object-key" :data-object-key="row.key" :tabindex="canSelectRow(row) ? 0 : -1">{{ row.key }}</span>
              </template>
            </el-table-column>
            <el-table-column label="Original size" min-width="130">
              <template #default="{ row }">{{ formatBytes(row.size) }}</template>
            </el-table-column>
            <el-table-column label="Last modified" min-width="170">
              <template #default="{ row }">{{ formatDate(row.lastModified) }}</template>
            </el-table-column>
            <el-table-column label="Status" min-width="140">
              <template #default="{ row }">
                <el-tag v-if="row.metadataStatus === 'unknown'" type="warning" effect="plain">Unknown</el-tag>
                <el-tag v-else-if="row.isOptimized" effect="plain">Optimized</el-tag>
                <span v-else>Not optimized</span>
              </template>
            </el-table-column>
            <el-table-column label="Saving" min-width="130">
              <template #default="{ row }">{{ row.savedPercent == null ? 'Not measured' : `${row.savedPercent}%` }}</template>
            </el-table-column>
            <el-table-column label="Preview" width="140">
              <template #default="{ row }">
                <div @click.stop @keydown.stop>
                  <ObjectPreview :bucket-id="bucketId" :object="row as any" />
                </div>
              </template>
            </el-table-column>
            <template #empty>{{ scanForBucket ? 'No JPEGs match these filters.' : 'Start a scan to discover JPEGs.' }}</template>
          </el-table>
        </div>
        <div class="pager">
          <span class="muted">Page {{ page }} of {{ maxPage }}</span>
          <div class="button-row">
            <el-button :disabled="page <= 1" @click="page--">Previous</el-button>
            <el-button :disabled="page >= maxPage" @click="page++">Next</el-button>
          </div>
        </div>
        <p class="fine">Objects above 128 MiB are skipped. Review failed items in <code>/api/jobs/{id}</code>; verified originals remain under the backup prefix for recovery.</p>

        <div class="section-gap">
          <h2 class="section-title">Job settings</h2>
          <p class="lede">These settings apply to the JPEGs selected above. Each original is backed up before replacement.</p>
          <el-form class="section-gap" label-position="top" @submit.prevent>
            <div class="settings-grid">
              <el-form-item label="JPEG preset">
                <el-select v-model="preset" :disabled="jobActive">
                  <el-option v-for="option in presetOptions" :key="option.value" :label="option.label" :value="option.value" />
                </el-select>
              </el-form-item>
              <el-form-item label="Minimum saving (%)">
                <el-input-number v-model="minimumSavingPercent" :disabled="jobActive" :min="1" :max="99" :step="1" controls-position="right" />
              </el-form-item>
            </div>
          </el-form>
          <div class="option-row section-gap">
            <el-checkbox v-model="preserveMetadata" :disabled="jobActive">Preserve photo metadata</el-checkbox>
            <div class="option-with-help">
              <el-checkbox v-model="deleteBackupAfterOptimization" :disabled="jobActive">Delete backup after successful optimization</el-checkbox>
              <el-tooltip :content="backupDeletionHelp" placement="top" :trigger="['hover', 'focus']">
                <el-button circle size="small" aria-label="About backup deletion">i</el-button>
              </el-tooltip>
            </div>
          </div>
          <div class="action-row section-gap">
            <div>
              <p class="muted">{{ optimizeHint }}</p>
              <el-button v-if="jobActive" link type="primary" @click="tab = 'jobs'">View jobs</el-button>
            </div>
            <el-button type="primary" :disabled="!canStartJob" @click="startJob">{{ currentJob?.job.status === 'paused' ? 'Job paused' : jobActive ? 'Job in progress' : `Start job for ${number.format(selectedKeys.length)} selected JPEGs` }}</el-button>
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane name="jobs">
        <template #label>
          <span class="tab-label">Jobs <el-tag v-if="tabList[1]?.badge" size="small" round effect="dark" :type="jobsNeedAttention ? 'warning' : 'primary'">{{ tabList[1]?.badge }}</el-tag></span>
        </template>
        <h2 class="section-title">Jobs</h2>
        <p class="fine">{{ bucketJobs.length ? 'Recent jobs for this bucket.' : 'No jobs for this bucket yet.' }}</p>
        <el-table v-if="bucketJobs.length" class="section-gap" :data="bucketJobs as any[]" :row-key="jobRowKey" :row-class-name="jobRowClass">
          <el-table-column label="Job" min-width="240">
            <template #default="{ row }">
              <p class="job-title">Job #{{ row.job.id }}</p>
              <p class="mono">{{ row.job.prefix || 'Entire bucket' }}</p>
              <p class="fine"><code>/api/jobs/{{ row.job.id }}</code></p>
              <div v-if="isLiveJob(row.job.status)" class="job-detail">
                <p v-if="row.current" class="fine">Now {{ row.current.status }}: <span class="mono">{{ row.current.key }}</span></p>
                <p v-if="row.nextRetryAt" class="fine">Next retry: {{ formatDate(new Date(row.nextRetryAt).toISOString()) }}</p>
                <el-progress :percentage="progressPercent(row)" :show-text="false" />
                <el-alert v-if="row.job.status === 'needs_attention'" class="section-gap" type="warning" :closable="false" show-icon>
                  <p>R2 did not confirm the source or backup state of {{ number.format(row.needsAttention) }} item(s). Review the item errors in <code>/api/jobs/{{ row.job.id }}</code>, then recheck the source and backup before retrying.</p>
                  <el-button class="section-gap" type="warning" :disabled="busy" @click="recheckJob(row.job.id)">{{ busy ? 'Rechecking…' : 'Recheck remote state' }}</el-button>
                </el-alert>
                <el-alert v-if="row.job.status === 'paused'" class="section-gap" type="warning" :closable="false" show-icon>
                  <p>Job paused after a bucket or credential error: {{ row.job.pauseReason }}. Fix the R2 configuration or access, then resume.</p>
                  <el-button class="section-gap" type="warning" :disabled="busy" @click="resumeJob(row.job.id)">{{ busy ? 'Resuming…' : 'Resume job' }}</el-button>
                </el-alert>
                <p class="fine">Backups: <code>__optimizer/originals/{{ row.job.id }}/</code></p>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="Status" min-width="160">
            <template #default="{ row }">
              <el-tag :type="jobTagType(row.job.status)" effect="plain">{{ row.job.status.replaceAll('_', ' ') }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="Created" min-width="180">
            <template #default="{ row }">
              <p>{{ formatDate(row.job.createdAt) }}</p>
              <p v-if="row.job.finishedAt" class="fine">Finished {{ formatDate(row.job.finishedAt) }}</p>
            </template>
          </el-table-column>
          <el-table-column label="Preset" min-width="160">
            <template #default="{ row }">
              <span>{{ row.job.preset ?? '—' }}</span>
              <span v-if="row.job.minimumSavingPercent != null" class="fine">{{ row.job.minimumSavingPercent }}% minimum saving</span>
            </template>
          </el-table-column>
          <el-table-column label="Processed" min-width="280">
            <template #default="{ row }">{{ number.format(processedCount(row)) }} / {{ number.format(row.total) }} · {{ number.format(row.completed) }} optimized · {{ number.format(row.skipped) }} skipped · {{ number.format(row.sourceChanged) }} source changed · {{ number.format(row.invalidJpeg) }} invalid JPEG · {{ number.format(row.failed) }} failed · {{ number.format(row.needsAttention) }} need attention</template>
          </el-table-column>
          <el-table-column label="Saved" min-width="180">
            <template #default="{ row }">
              <p>{{ savedLabel(row) }}</p>
              <p v-if="row.finalBytes != null" class="fine">Original {{ formatBytes(row.originalBytes) }} · Final {{ formatBytes(row.finalBytes) }}</p>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>
  </main>
</template>
