<script setup lang="ts">
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
const minimumSizeValid = computed(() => Number.isInteger(minMiB.value) && minMiB.value >= 1 && minMiB.value <= 20)

const filters = computed(() => ({ bucketId: bucketId.value, prefix: prefix.value, minBytes: minMiB.value * 1048576, status: status.value, page: page.value }))
const { data: overview, refresh: refreshOverview } = await useFetch('/api/overview', { query: filters, default: () => ({ scan: null, totals: { objects: 0, jpegs: 0, jpegBytes: 0, optimized: 0, eligible: 0, metadataUnknown: 0 } }) })
const { data: result, refresh: refreshObjects } = await useFetch('/api/objects', { query: filters, default: () => ({ items: [], total: 0, page: 1, pageSize: 10 }) })
const { data: jobsResult, refresh: refreshJobs } = await useFetch('/api/jobs', { query: computed(() => ({ bucketId: bucketId.value })), default: () => ({ jobs: [] }) })

watch([prefix, minMiB, status], () => { page.value = 1; selectedKeys.value = [] })
watch(bucketId, () => { prefix.value = ''; scanPrefix.value = ''; page.value = 1; selectedKeys.value = []; actionError.value = '' })
watch(() => overview.value.scan?.id, () => { selectedKeys.value = [] })
const scanForBucket = computed(() => overview.value.scan?.bucketId === bucketId.value ? overview.value.scan : null)
const scanning = computed(() => !!scanForBucket.value && ['queued', 'running'].includes(scanForBucket.value.status))
const bucketJobs = computed(() => jobsResult.value.jobs.filter(job => job && job.job.bucketId === bucketId.value))
const currentJob = computed(() => bucketJobs.value.find(job => job && ['needs_attention', 'paused'].includes(job.job.status)) ?? bucketJobs.value[0] ?? null)
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
function toggleRowSelection(key: string) {
  if (!selectableOnPage.value.some(item => item.key === key) || jobActive.value || scanning.value) return
  toggleSelected(key, !selectedKeys.value.includes(key))
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
function processedCount(summary: { completed: number, skipped: number, sourceChanged: number, invalidJpeg: number, failed: number, needsAttention: number }) {
  return summary.completed + summary.skipped + summary.sourceChanged + summary.invalidJpeg + summary.failed + summary.needsAttention
}
function savedLabel(summary: { savedBytes: number | null, savedPercent: number | null, needsAttention: number }) {
  if (summary.savedBytes == null) return summary.needsAttention ? 'Pending verification' : 'Unknown after source change'
  return `${formatBytes(summary.savedBytes)} (${summary.savedPercent}%)`
}
function jobStatusClass(status: string) {
  if (status === 'completed') return 'text-orange-700'
  if (status === 'completed_with_errors' || status === 'needs_attention' || status === 'paused') return 'text-amber-700'
  return 'text-slate-700'
}
function isLiveJob(status: string) {
  return ['queued', 'running', 'paused', 'needs_attention'].includes(status)
}
function jobRowClass(status: string) {
  if (status === 'paused' || status === 'needs_attention') return 'bg-amber-50/70'
  if (status === 'queued' || status === 'running') return 'bg-orange-50/70'
  return ''
}
const liveJobs = computed(() => bucketJobs.value.filter(summary => isLiveJob(summary.job.status)))
function tabBadgeClass(id: DashboardTab, selected: boolean) {
  if (id === 'jobs' && liveJobs.value.some(summary => summary.job.status === 'paused' || summary.job.status === 'needs_attention')) return 'bg-amber-100 text-amber-900'
  return selected ? 'bg-white text-orange-800' : 'bg-orange-100 text-orange-800'
}
const tabList = computed(() => [
  { id: 'optimize' as const, label: 'Optimize', badge: selectedKeys.value.length ? number.format(selectedKeys.value.length) : '' },
  { id: 'jobs' as const, label: 'Jobs', badge: liveJobs.value.length ? number.format(liveJobs.value.length) : '' },
])
function onTabKeydown(event: KeyboardEvent) {
  const current = tabs.indexOf(tab.value)
  const nextIndex = event.key === 'ArrowRight' ? (current + 1) % tabs.length
    : event.key === 'ArrowLeft' ? (current - 1 + tabs.length) % tabs.length
    : event.key === 'Home' ? 0
    : event.key === 'End' ? tabs.length - 1
    : -1
  if (nextIndex < 0) return
  event.preventDefault()
  const next = tabs[nextIndex]!
  tab.value = next
  document.getElementById(`tab-${next}`)?.focus()
}

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
  if (!window.confirm(`Are you sure you want to start an optimization job for ${selectionLabel} in ${bucketName}?\n\nSelected originals may be replaced after verification. ${backupPolicy}`)) return
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
onMounted(() => { pollTimer = setInterval(() => {
  if (scanning.value || jobActive.value) void Promise.all([refreshOverview(), refreshObjects(), refreshJobs()])
}, 2000) })
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer) })
</script>

<template>
  <main class="mx-auto max-w-7xl px-5 py-10 sm:px-8">
    <header class="mb-10 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <div class="flex items-center gap-4">
        <img src="/bucketlean-logo.svg" alt="" width="72" height="72" class="h-16 w-16 shrink-0 sm:h-[72px] sm:w-[72px]">
        <div>
          <p class="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-orange-700">Cloudflare R2 · JPEG optimization</p>
          <h1 class="text-3xl font-semibold tracking-tight sm:text-4xl">BucketLean</h1>
          <p class="mt-2 max-w-2xl text-sm text-slate-600">Scan your bucket, review candidates, and run a sequential optimization job.</p>
        </div>
      </div>
    </header>

    <div class="mb-6 rounded-xs border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <p v-if="actionError" class="mb-4 rounded-xs border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{{ actionError }}</p>
      <div class="flex flex-col gap-4 lg:flex-row lg:items-end">
        <label class="min-w-0 flex-1 text-sm font-medium text-slate-700">R2 bucket
          <select v-model="bucketId" :disabled="busy || !bucketResult.buckets.length" class="mt-2 block w-full rounded-xs border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-600 disabled:cursor-not-allowed disabled:bg-slate-50">
            <option v-for="bucket in bucketResult.buckets" :key="bucket.id" :value="bucket.id">{{ bucket.bucket }} · {{ bucket.id }}</option>
          </select>
        </label>
        <label class="min-w-0 flex-1 text-sm font-medium text-slate-700">Scan prefix
          <input v-model="scanPrefix" :disabled="!bucketId || scanning || jobActive" type="text" placeholder="Leave empty for entire bucket" class="mt-2 block w-full rounded-xs border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-600 disabled:cursor-not-allowed disabled:bg-slate-50">
        </label>
        <button :disabled="!bucketId || scanning || jobActive || busy" :aria-busy="scanning || pendingAction === 'scan'" :class="scanForBucket?.status === 'completed' && !scanning && pendingAction !== 'scan' ? 'border border-slate-300 bg-white text-slate-800' : 'bg-orange-700 text-white'" class="inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-xs px-5 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 lg:w-auto" @click="startScan"><span v-if="scanning || pendingAction === 'scan'" aria-hidden="true" class="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white motion-reduce:animate-none"></span>{{ scanning ? 'Scan in progress' : pendingAction === 'scan' ? 'Starting…' : 'Start scan' }}</button>
      </div>
      <p v-if="!bucketResult.buckets.length" class="mt-2 text-sm text-amber-700">Configure an R2 bucket on the server before scanning.</p>
      <p v-else class="mt-2 text-xs text-slate-500">Each bucket keeps its own scan results and jobs. The worker runs one operation at a time.</p>
      <p class="mt-2 text-sm text-slate-600">Leave the prefix empty to scan the whole bucket. Scanning only reads R2.</p>
      <div v-if="scanForBucket" class="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600">
        <span>Status: <strong class="capitalize text-slate-900">{{ scanForBucket.status }}</strong></span>
        <span>Scope: <strong class="text-slate-900">{{ scanForBucket.prefix || 'Entire bucket' }}</strong></span>
        <span>Started: {{ formatDate(scanForBucket.startedAt) }}</span>
        <span v-if="scanning">Discovered: {{ number.format(scanForBucket.discoveredCount) }}</span>
        <span v-if="scanForBucket.metadataErrorCount" class="text-amber-700">{{ number.format(scanForBucket.metadataErrorCount) }} metadata checks failed</span>
      </div>
      <p v-else-if="bucketId" class="mt-4 text-sm text-slate-500">No scan yet for this bucket.</p>
      <p v-if="scanForBucket?.error" class="mt-3 text-sm text-red-700">{{ scanForBucket.error }}</p>
    </div>

    <div class="overflow-hidden rounded-xs border border-slate-200 bg-white shadow-sm">
      <div role="tablist" aria-label="Dashboard" class="grid grid-cols-2 gap-2 border-b border-slate-200 bg-slate-100 p-2 sm:p-3">
        <button v-for="item in tabList" :id="`tab-${item.id}`" :key="item.id" type="button" role="tab" :aria-selected="tab === item.id" :aria-controls="`panel-${item.id}`" :tabindex="tab === item.id ? 0 : -1" class="flex w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-xs border px-3 py-2.5 text-sm font-semibold shadow-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-800 sm:flex-row sm:gap-2 sm:py-3" :class="tab === item.id ? 'border-orange-800 bg-orange-700 text-white' : 'border-slate-300 bg-white text-slate-700 hover:border-orange-300 hover:bg-orange-50 hover:text-slate-900'" @click="tab = item.id" @keydown="onTabKeydown">
          <span>{{ item.label }}</span>
          <span v-if="item.badge" class="rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums" :class="tabBadgeClass(item.id, tab === item.id)">{{ item.badge }}</span>
        </button>
      </div>

      <section id="panel-optimize" role="tabpanel" aria-labelledby="tab-optimize" :hidden="tab !== 'optimize'">
      <div class="grid grid-cols-2 gap-3 px-5 py-5 sm:px-6 lg:grid-cols-5">
        <div v-for="card in [
          ['Discovered objects', number.format(overview.totals.objects)],
          ['JPEGs', number.format(overview.totals.jpegs)],
          ['JPEG storage', formatBytes(overview.totals.jpegBytes)],
          ['Already optimized', number.format(overview.totals.optimized)],
          ['Eligible', number.format(overview.totals.eligible)],
        ]" :key="card[0]" class="rounded-xs border border-slate-200 bg-slate-50 p-4">
          <p class="text-xs font-medium text-slate-500">{{ card[0] }}</p><p class="mt-2 text-2xl font-semibold tabular-nums">{{ card[1] }}</p>
        </div>
      </div>

      <div class="border-t border-slate-200 p-5">
        <h2 class="text-lg font-semibold">Scan results</h2>
        <div class="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600">
          <span>Matching JPEGs: <strong class="tabular-nums text-slate-900">{{ number.format(result.total) }}</strong></span>
          <span>Selected: <strong class="tabular-nums text-slate-900">{{ number.format(selectedKeys.length) }}</strong></span>
        </div>
        <p class="mt-2 max-w-3xl text-xs leading-relaxed text-slate-500">Selections persist across pages. Changing the bucket, scan, prefix, size, or status clears them. Maximum 5,000 selections. Unknown metadata is left out of eligibility.</p>
        <div class="mt-4 grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2 lg:grid-cols-3">
          <label class="text-sm font-medium text-slate-700">Key prefix
            <input v-model="prefix" type="text" placeholder="Optional, within the scan" class="mt-2 block w-full rounded-xs border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-600">
          </label>
          <label class="text-sm font-medium text-slate-700">Minimum original size (MiB)
            <select v-model.number="minMiB" class="mt-2 block w-full rounded-xs border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-600">
              <option v-for="size in 20" :key="size" :value="size">{{ size }} MiB</option>
            </select>
          </label>
          <label class="text-sm font-medium text-slate-700">Status
            <select v-model="status" class="mt-2 block w-full rounded-xs border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-600"><option value="all">All</option><option value="not_optimized">Not optimized</option><option value="optimized">Optimized</option><option value="unknown">Unknown</option></select>
          </label>
        </div>
        <p class="mt-2 text-xs text-slate-500">Default is 1 MiB. Eligible count and scan results use this size, from 1 to 20 MiB.</p>
        <div class="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button type="button" :disabled="!selectableOnPage.length || scanning || jobActive" class="w-full rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto" @click="togglePageSelection">{{ allOnPageSelected ? 'Deselect this page' : 'Select eligible on this page' }}</button>
          <button type="button" :disabled="!selectedKeys.length" class="w-full rounded border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto" @click="selectedKeys = []">Clear selection</button>
        </div>
      </div>
      <div class="overflow-x-auto"><table class="w-full min-w-[840px] text-left text-sm"><thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th class="px-5 py-3">Select</th><th class="px-5 py-3">Object key</th><th class="px-5 py-3">Original size</th><th class="px-5 py-3">Last modified</th><th class="px-5 py-3">Status</th><th class="px-5 py-3">Saving</th><th class="px-5 py-3">Preview</th></tr></thead>
        <tbody class="divide-y divide-slate-100"><tr v-for="item in result.items" :key="`${bucketId}:${item.scanId}:${item.key}:${item.etag}`" :tabindex="selectableOnPage.some(row => row.key === item.key) && !jobActive && !scanning ? 0 : -1" :aria-selected="selectedKeys.includes(item.key)" :class="selectableOnPage.some(row => row.key === item.key) && !jobActive && !scanning ? 'cursor-pointer hover:bg-orange-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-600' : ''" @click="toggleRowSelection(item.key)" @keydown.enter.prevent="toggleRowSelection(item.key)" @keydown.space.prevent="toggleRowSelection(item.key)"><td class="px-5 py-3"><input type="checkbox" class="h-5 w-5 cursor-pointer accent-orange-600" :aria-label="`Select ${item.key}`" :checked="selectedKeys.includes(item.key)" :disabled="!selectableOnPage.some(row => row.key === item.key) || jobActive || scanning || (selectedKeys.length >= 5000 && !selectedKeys.includes(item.key))" @click.stop @keydown.stop @change="toggleSelected(item.key, ($event.target as HTMLInputElement).checked)"></td><td class="max-w-[440px] break-all px-5 py-3 font-mono text-xs text-slate-800">{{ item.key }}</td><td class="whitespace-nowrap px-5 py-3 tabular-nums">{{ formatBytes(item.size) }}</td><td class="whitespace-nowrap px-5 py-3 text-slate-600">{{ formatDate(item.lastModified) }}</td><td class="px-5 py-3"><span :class="item.metadataStatus === 'unknown' ? 'text-amber-700' : item.isOptimized ? 'text-orange-700' : 'text-slate-600'">{{ item.metadataStatus === 'unknown' ? 'Unknown' : item.isOptimized ? 'Optimized' : 'Not optimized' }}</span></td><td class="px-5 py-3 text-slate-500">{{ item.savedPercent == null ? 'Not measured' : `${item.savedPercent}%` }}</td><td class="px-5 py-3" @click.stop @keydown.stop><ObjectPreview :bucket-id="bucketId" :object="item" /></td></tr>
          <tr v-if="!result.items.length"><td colspan="7" class="px-5 py-10 text-center text-slate-500">{{ scanForBucket ? 'No JPEGs match these filters.' : 'Start a scan to discover JPEGs.' }}</td></tr></tbody>
      </table></div>
      <div class="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-sm"><span class="text-slate-500">Page {{ page }} of {{ maxPage }}</span><div class="flex gap-2"><button :disabled="page <= 1" class="rounded border border-slate-300 px-3 py-1.5 disabled:opacity-40" @click="page--">Previous</button><button :disabled="page >= maxPage" class="rounded border border-slate-300 px-3 py-1.5 disabled:opacity-40" @click="page++">Next</button></div></div>
      <p class="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">Objects above 128 MiB are skipped. Review failed items in <code>/api/jobs/{id}</code>; verified originals remain under the backup prefix for recovery.</p>
        <div class="border-t border-slate-200 p-5 sm:p-6">
        <h2 class="text-lg font-semibold">Job settings</h2>
        <p class="mt-1 max-w-3xl text-sm text-slate-600">These settings apply to the JPEGs selected above. Each original is backed up before replacement.</p>
        <div class="mt-5 grid gap-4 sm:grid-cols-2">
          <label class="text-sm font-medium text-slate-700">JPEG preset
            <select v-model="preset" :disabled="jobActive" class="mt-2 block w-full rounded-xs border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-600 disabled:cursor-not-allowed disabled:bg-slate-50">
              <option value="archival">Archival · quality 90</option>
              <option value="balanced">Balanced · quality 82</option>
              <option value="aggressive">Aggressive · quality 72</option>
            </select>
          </label>
          <label class="text-sm font-medium text-slate-700">Minimum saving (%)
            <input v-model.number="minimumSavingPercent" :disabled="jobActive" type="number" min="1" max="99" step="1" class="mt-2 block w-full rounded-xs border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-600 disabled:cursor-not-allowed disabled:bg-slate-50">
          </label>
        </div>
        <div class="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-8">
          <label class="flex items-center gap-2 text-sm text-slate-700"><input v-model="preserveMetadata" :disabled="jobActive" type="checkbox" class="h-5 w-5 cursor-pointer accent-orange-600"> Preserve photo metadata</label>
          <div class="flex items-center gap-2 text-sm text-slate-700">
            <label class="flex items-center gap-2"><input v-model="deleteBackupAfterOptimization" :disabled="jobActive" type="checkbox" class="h-5 w-5 cursor-pointer accent-orange-600"> Delete backup after successful optimization</label>
            <span class="group relative inline-flex">
              <button type="button" aria-label="About backup deletion" aria-describedby="backup-deletion-help" class="flex h-5 w-5 items-center justify-center rounded-full border border-slate-400 text-xs font-semibold text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-600">i</button>
              <span id="backup-deletion-help" role="tooltip" class="pointer-events-none invisible absolute top-full right-0 z-10 mt-2 w-72 max-w-[calc(100vw-3rem)] rounded-xs border border-slate-200 bg-white p-3 text-xs font-normal leading-relaxed text-slate-700 shadow-lg group-hover:visible group-focus-within:visible">The original is backed up before replacement. After the optimized image is verified at its original key, this option deletes that backup and its restore manifest. You will no longer have a restore copy.</span>
            </span>
          </div>
        </div>
        <div class="mt-5 flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p class="text-sm text-slate-600">{{ optimizeHint }}</p>
            <button v-if="jobActive" type="button" class="mt-2 text-sm font-semibold text-orange-800 underline decoration-orange-300 underline-offset-2 hover:decoration-orange-700" @click="tab = 'jobs'">View jobs</button>
          </div>
          <button :disabled="!canStartJob" class="inline-flex w-full shrink-0 items-center justify-center rounded-xs bg-orange-700 px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto" @click="startJob">{{ currentJob?.job.status === 'paused' ? 'Job paused' : jobActive ? 'Job in progress' : `Start job for ${number.format(selectedKeys.length)} selected JPEGs` }}</button>
        </div>
        </div>
      </section>

      <section id="panel-jobs" role="tabpanel" aria-labelledby="tab-jobs" :hidden="tab !== 'jobs'">
        <div class="border-b border-slate-200 p-5">
          <h2 class="text-lg font-semibold">Jobs</h2>
          <p class="mt-1 text-xs text-slate-500">{{ bucketJobs.length ? 'Recent jobs for this bucket.' : 'No jobs for this bucket yet.' }}</p>
        </div>
        <div v-if="bucketJobs.length" class="overflow-x-auto">
          <table class="w-full min-w-[960px] text-left text-sm">
            <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th class="px-5 py-3">Job</th>
                <th class="px-5 py-3">Status</th>
                <th class="px-5 py-3">Created</th>
                <th class="px-5 py-3">Preset</th>
                <th class="px-5 py-3">Processed</th>
                <th class="px-5 py-3">Saved</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="summary in bucketJobs" :key="summary.job.id">
                <tr :class="jobRowClass(summary.job.status)" class="border-t border-slate-100">
                  <td class="px-5 py-3">
                    <p class="font-semibold">Job #{{ summary.job.id }}</p>
                    <p class="mt-1 break-all font-mono text-xs text-slate-600">{{ summary.job.prefix || 'Entire bucket' }}</p>
                    <p class="mt-1 text-xs text-slate-500"><code>/api/jobs/{{ summary.job.id }}</code></p>
                  </td>
                  <td class="px-5 py-3">
                    <p :class="jobStatusClass(summary.job.status)" class="whitespace-nowrap capitalize">{{ summary.job.status.replaceAll('_', ' ') }}</p>
                  </td>
                  <td class="whitespace-nowrap px-5 py-3 text-slate-600">
                    <p>{{ formatDate(summary.job.createdAt ?? null) }}</p>
                    <p v-if="summary.job.finishedAt" class="mt-1 text-xs text-slate-500">Finished {{ formatDate(summary.job.finishedAt) }}</p>
                  </td>
                  <td class="whitespace-nowrap px-5 py-3 capitalize text-slate-700">{{ summary.job.preset ?? '—' }}<span v-if="summary.job.minimumSavingPercent != null" class="mt-1 block text-xs normal-case text-slate-500">{{ summary.job.minimumSavingPercent }}% minimum saving</span></td>
                  <td class="px-5 py-3 text-slate-600">{{ number.format(processedCount(summary)) }} / {{ number.format(summary.total) }} · {{ number.format(summary.completed) }} optimized · {{ number.format(summary.skipped) }} skipped · {{ number.format(summary.sourceChanged) }} source changed · {{ number.format(summary.invalidJpeg) }} invalid JPEG · {{ number.format(summary.failed) }} failed · {{ number.format(summary.needsAttention) }} need attention</td>
                  <td class="whitespace-nowrap px-5 py-3 tabular-nums">
                    <p>{{ savedLabel(summary) }}</p>
                    <p v-if="summary.finalBytes != null" class="mt-1 text-xs font-normal text-slate-500">Original {{ formatBytes(summary.originalBytes) }} · Final {{ formatBytes(summary.finalBytes) }}</p>
                  </td>
                </tr>
                <tr v-if="isLiveJob(summary.job.status)" :class="jobRowClass(summary.job.status)">
                  <td colspan="6" class="px-5 pb-4">
                    <p v-if="summary.current" class="break-all text-xs text-slate-600">Now {{ summary.current.status }}: <span class="font-mono">{{ summary.current.key }}</span></p>
                    <p v-if="summary.nextRetryAt" class="mt-1 text-xs text-slate-600">Next retry: {{ formatDate(new Date(summary.nextRetryAt).toISOString()) }}</p>
                    <div class="mt-3 h-2 overflow-hidden rounded-full bg-slate-100"><div class="h-full bg-orange-600" :style="{ width: `${summary.total ? 100 * processedCount(summary) / summary.total : 0}%` }"></div></div>
                    <div v-if="summary.job.status === 'needs_attention'" class="mt-3 rounded-xs border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                      <p>R2 did not confirm the source or backup state of {{ number.format(summary.needsAttention) }} item(s). Review the item errors in <code>/api/jobs/{{ summary.job.id }}</code>, then recheck the source and backup before retrying.</p>
                      <button :disabled="busy" class="mt-2 rounded bg-amber-700 px-3 py-1.5 font-semibold text-white disabled:opacity-50" @click="recheckJob(summary.job.id)">{{ busy ? 'Rechecking…' : 'Recheck remote state' }}</button>
                    </div>
                    <div v-if="summary.job.status === 'paused'" class="mt-3 rounded-xs border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                      <p>Job paused after a bucket or credential error: {{ summary.job.pauseReason }}. Fix the R2 configuration or access, then resume.</p>
                      <button :disabled="busy" class="mt-2 rounded bg-amber-700 px-3 py-1.5 font-semibold text-white disabled:opacity-50" @click="resumeJob(summary.job.id)">{{ busy ? 'Resuming…' : 'Resume job' }}</button>
                    </div>
                    <p class="mt-2 text-xs text-slate-500">Backups: <code>__optimizer/originals/{{ summary.job.id }}/</code></p>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </main>
</template>
