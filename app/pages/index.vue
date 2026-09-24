<script setup lang="ts">
const prefix = ref('')
const minMiB = ref(1)
const status = ref('all')
const page = ref(1)
const scanPrefix = ref('')
const busy = ref(false)
const actionError = ref('')
const preset = ref<'archival' | 'balanced' | 'aggressive'>('balanced')
const minimumSavingPercent = ref(15)
const preserveMetadata = ref(true)
const backupOriginals = ref(true)
const acknowledged = ref(false)

const filters = computed(() => ({ prefix: prefix.value, minBytes: Math.max(0, Math.floor((Number(minMiB.value) || 0) * 1048576)), status: status.value, page: page.value }))
const { data: overview, refresh: refreshOverview } = await useFetch('/api/overview', { query: filters, default: () => ({ scan: null, totals: { objects: 0, jpegs: 0, jpegBytes: 0, optimized: 0, eligible: 0, metadataUnknown: 0 } }) })
const { data: result, refresh: refreshObjects } = await useFetch('/api/objects', { query: filters, default: () => ({ items: [], total: 0, page: 1, pageSize: 100 }) })
const { data: jobsResult, refresh: refreshJobs } = await useFetch('/api/jobs', { default: () => ({ jobs: [] }) })

watch([prefix, minMiB, status], () => { page.value = 1 })
const scanning = computed(() => ['queued', 'running'].includes(overview.value.scan?.status ?? ''))
const currentJob = computed(() => jobsResult.value.jobs.find(job => ['needs_attention', 'paused'].includes(job?.job.status ?? '')) ?? jobsResult.value.jobs[0] ?? null)
const jobActive = computed(() => ['queued', 'running', 'paused', 'needs_attention'].includes(currentJob.value?.job.status ?? ''))
const maxPage = computed(() => Math.max(1, Math.ceil(result.value.total / result.value.pageSize)))
const number = new Intl.NumberFormat()
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const unit = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** unit).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`
}
function formatDate(value: string | null) { return value ? new Date(value).toLocaleString() : '—' }

async function startScan() {
  busy.value = true
  actionError.value = ''
  try {
    await $fetch('/api/scan', { method: 'POST', body: { prefix: scanPrefix.value } })
    await Promise.all([refreshOverview(), refreshObjects()])
  } catch (error: unknown) {
    actionError.value = error && typeof error === 'object' && 'data' in error
      ? String((error as { data?: { statusMessage?: string } }).data?.statusMessage ?? 'Scan could not start')
      : 'Scan could not start'
  } finally { busy.value = false }
}

async function startJob() {
  busy.value = true
  actionError.value = ''
  try {
    await $fetch('/api/jobs', { method: 'POST', body: {
      prefix: prefix.value, minBytes: filters.value.minBytes, preset: preset.value,
      minimumSavingPercent: minimumSavingPercent.value, preserveMetadata: preserveMetadata.value,
      backupOriginals: backupOriginals.value,
    } })
    acknowledged.value = false
    await refreshJobs()
  } catch (error: unknown) {
    actionError.value = error && typeof error === 'object' && 'data' in error
      ? String((error as { data?: { statusMessage?: string } }).data?.statusMessage ?? 'Job could not start')
      : 'Job could not start'
  } finally { busy.value = false }
}

async function recheckJob() {
  if (!currentJob.value) return
  busy.value = true
  actionError.value = ''
  try {
    await $fetch(`/api/jobs/${currentJob.value.job.id}/reconcile`, { method: 'POST' })
    await refreshJobs()
  } catch (error: unknown) {
    actionError.value = error && typeof error === 'object' && 'data' in error
      ? String((error as { data?: { statusMessage?: string } }).data?.statusMessage ?? 'Recheck could not start')
      : 'Recheck could not start'
  } finally { busy.value = false }
}

async function resumeJob() {
  if (!currentJob.value) return
  busy.value = true
  actionError.value = ''
  try {
    await $fetch(`/api/jobs/${currentJob.value.job.id}/resume`, { method: 'POST' })
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
      <div>
        <p class="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">Cloudflare R2 · JPEG optimization</p>
        <h1 class="text-3xl font-semibold tracking-tight sm:text-4xl">R2 JPEG Optimizer</h1>
        <p class="mt-2 max-w-2xl text-sm text-slate-600">Scan your bucket, review candidates, and run a sequential optimization job.</p>
      </div>
      <span class="w-fit rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800">One image at a time</span>
    </header>

    <section class="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div class="flex flex-col gap-4 lg:flex-row lg:items-end">
        <label class="flex-1 text-sm font-medium text-slate-700">Scan prefix
          <input v-model="scanPrefix" :disabled="scanning || jobActive" type="text" placeholder="Leave empty for entire bucket" class="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-emerald-600">
        </label>
        <button :disabled="scanning || jobActive || busy" class="rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" @click="startScan">{{ scanning ? 'Scan in progress' : busy ? 'Starting…' : 'Start scan' }}</button>
      </div>
      <p v-if="actionError" class="mt-3 text-sm text-red-700">{{ actionError }}</p>
      <div v-if="overview.scan" class="mt-4 flex flex-wrap gap-x-6 gap-y-1 border-t border-slate-100 pt-4 text-sm text-slate-600">
        <span>Status: <strong class="capitalize text-slate-900">{{ overview.scan.status }}</strong></span>
        <span>Scope: <strong class="text-slate-900">{{ overview.scan.prefix || 'Entire bucket' }}</strong></span>
        <span>Started: {{ formatDate(overview.scan.startedAt) }}</span>
        <span v-if="scanning">Discovered: {{ number.format(overview.scan.discoveredCount) }}</span>
        <span v-if="overview.scan.metadataErrorCount" class="text-amber-700">{{ number.format(overview.scan.metadataErrorCount) }} metadata checks failed</span>
      </div>
      <p v-if="overview.scan?.error" class="mt-3 text-sm text-red-700">{{ overview.scan.error }}</p>
    </section>

    <section class="mb-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div class="mb-4"><h2 class="text-lg font-semibold">Optimize eligible JPEGs</h2><p class="mt-1 text-sm text-slate-600">Uses the key prefix and minimum size filters below. Already optimized and unknown objects are excluded. Each original is backed up before replacement.</p><p v-if="!prefix" class="mt-2 text-sm font-medium text-amber-700">No key prefix is set: this job will include all eligible JPEGs in the completed scan.</p></div>
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label class="text-xs font-medium text-slate-600">JPEG preset<select v-model="preset" :disabled="jobActive" class="mt-1 block w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"><option value="archival">Archival · quality 90</option><option value="balanced">Balanced · quality 82</option><option value="aggressive">Aggressive · quality 72</option></select></label>
        <label class="text-xs font-medium text-slate-600">Minimum saving (%)<input v-model.number="minimumSavingPercent" :disabled="jobActive" type="number" min="1" max="99" step="1" class="mt-1 block w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"></label>
        <label class="flex items-center gap-2 self-end pb-2 text-sm text-slate-700"><input v-model="preserveMetadata" :disabled="jobActive" type="checkbox"> Preserve photo metadata</label>
        <label class="flex items-center gap-2 self-end pb-2 text-sm text-slate-700"><input v-model="backupOriginals" type="checkbox" disabled> Back up originals (required)</label>
      </div>
      <div class="mt-5 flex flex-wrap items-center gap-4 border-t border-slate-100 pt-4">
        <label class="flex items-center gap-2 text-sm text-slate-700"><input v-model="acknowledged" :disabled="jobActive" type="checkbox"> I understand qualifying originals will be replaced after backup.</label>
        <button :disabled="!acknowledged || !backupOriginals || !overview.scan || overview.scan.status !== 'completed' || !overview.totals.eligible || scanning || jobActive || busy" class="rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" @click="startJob">{{ currentJob?.job.status === 'paused' ? 'Job paused' : jobActive ? 'Job in progress' : `Start job for ${number.format(overview.totals.eligible)} JPEGs` }}</button>
      </div>
      <p class="mt-3 text-xs text-slate-500">The R2 credentials need Object Read &amp; Write access. Jobs only start when you press the button.</p>
      <div v-if="currentJob" class="mt-5 border-t border-slate-100 pt-5">
        <h3 class="font-semibold">Job #{{ currentJob.job.id }} · <span class="capitalize">{{ currentJob.job.status.replaceAll('_', ' ') }}</span></h3>
        <p class="mt-1 text-sm text-slate-600">{{ number.format(currentJob.completed + currentJob.skipped + currentJob.sourceChanged + currentJob.invalidJpeg + currentJob.failed + currentJob.needsAttention) }} / {{ number.format(currentJob.total) }} processed · {{ number.format(currentJob.completed) }} optimized · {{ number.format(currentJob.skipped) }} skipped · {{ number.format(currentJob.sourceChanged) }} source changed · {{ number.format(currentJob.invalidJpeg) }} invalid JPEG · {{ number.format(currentJob.failed) }} failed · {{ number.format(currentJob.needsAttention) }} need attention</p>
        <p v-if="currentJob.current" class="mt-1 break-all text-xs text-slate-600">Now {{ currentJob.current.status }}: <span class="font-mono">{{ currentJob.current.key }}</span></p>
        <p v-if="currentJob.nextRetryAt" class="mt-1 text-xs text-slate-600">Next retry: {{ formatDate(new Date(currentJob.nextRetryAt).toISOString()) }}</p>
        <div class="mt-3 h-2 overflow-hidden rounded-full bg-slate-100"><div class="h-full bg-emerald-600" :style="{ width: `${currentJob.total ? 100 * (currentJob.completed + currentJob.skipped + currentJob.sourceChanged + currentJob.invalidJpeg + currentJob.failed + currentJob.needsAttention) / currentJob.total : 0}%` }"></div></div>
        <p class="mt-3 text-sm text-slate-700">Original {{ formatBytes(currentJob.originalBytes) }} · Final {{ currentJob.finalBytes == null ? currentJob.needsAttention ? 'Pending verification' : 'Unknown after source change' : formatBytes(currentJob.finalBytes) }} · Saved {{ currentJob.savedBytes == null ? currentJob.needsAttention ? 'Pending verification' : 'Unknown after source change' : `${formatBytes(currentJob.savedBytes)} (${currentJob.savedPercent}%)` }}</p>
        <div v-if="currentJob.job.status === 'needs_attention'" class="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p>R2 did not confirm the source or backup state of {{ number.format(currentJob.needsAttention) }} item(s). Review the item errors in <code>/api/jobs/{{ currentJob.job.id }}</code>, then recheck the source and backup before retrying.</p>
          <button :disabled="busy" class="mt-2 rounded bg-amber-700 px-3 py-1.5 font-semibold text-white disabled:opacity-50" @click="recheckJob">{{ busy ? 'Rechecking…' : 'Recheck remote state' }}</button>
        </div>
        <div v-if="currentJob.job.status === 'paused'" class="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p>Job paused after a bucket or credential error: {{ currentJob.job.pauseReason }}. Fix the R2 configuration or access, then resume.</p>
          <button :disabled="busy" class="mt-2 rounded bg-amber-700 px-3 py-1.5 font-semibold text-white disabled:opacity-50" @click="resumeJob">{{ busy ? 'Resuming…' : 'Resume job' }}</button>
        </div>
        <p class="mt-1 text-xs text-slate-500">Backups: <code>__optimizer/originals/{{ currentJob.job.id }}/</code></p>
      </div>
    </section>

    <section class="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-5">
      <div v-for="card in [
        ['Discovered objects', number.format(overview.totals.objects)],
        ['JPEGs', number.format(overview.totals.jpegs)],
        ['JPEG storage', formatBytes(overview.totals.jpegBytes)],
        ['Already optimized', number.format(overview.totals.optimized)],
        ['Eligible', number.format(overview.totals.eligible)],
      ]" :key="card[0]" class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p class="text-xs font-medium text-slate-500">{{ card[0] }}</p><p class="mt-2 text-2xl font-semibold tabular-nums">{{ card[1] }}</p>
      </div>
    </section>

    <section class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div class="flex flex-col gap-4 border-b border-slate-200 p-5 lg:flex-row lg:items-end lg:justify-between">
        <div><h2 class="text-lg font-semibold">Scan results</h2><p class="mt-1 text-xs text-slate-500">{{ number.format(result.total) }} matching JPEGs · eligibility excludes unknown metadata</p></div>
        <div class="flex flex-wrap gap-3">
          <label class="text-xs font-medium text-slate-600">Key prefix<input v-model="prefix" type="text" placeholder="photos/" class="mt-1 block w-40 rounded-lg border border-slate-300 px-2.5 py-2 text-sm"></label>
          <label class="text-xs font-medium text-slate-600">Minimum MiB<input v-model.number="minMiB" type="number" min="0" step="0.1" class="mt-1 block w-28 rounded-lg border border-slate-300 px-2.5 py-2 text-sm"></label>
          <label class="text-xs font-medium text-slate-600">Status<select v-model="status" class="mt-1 block w-40 rounded-lg border border-slate-300 px-2.5 py-2 text-sm"><option value="all">All</option><option value="not_optimized">Not optimized</option><option value="optimized">Optimized</option><option value="unknown">Unknown</option></select></label>
        </div>
      </div>
      <div class="overflow-x-auto"><table class="w-full min-w-[760px] text-left text-sm"><thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th class="px-5 py-3">Object key</th><th class="px-5 py-3">Original size</th><th class="px-5 py-3">Last modified</th><th class="px-5 py-3">Status</th><th class="px-5 py-3">Saving</th></tr></thead>
        <tbody class="divide-y divide-slate-100"><tr v-for="item in result.items" :key="item.key"><td class="max-w-[440px] break-all px-5 py-3 font-mono text-xs text-slate-800">{{ item.key }}</td><td class="whitespace-nowrap px-5 py-3 tabular-nums">{{ formatBytes(item.size) }}</td><td class="whitespace-nowrap px-5 py-3 text-slate-600">{{ formatDate(item.lastModified) }}</td><td class="px-5 py-3"><span :class="item.metadataStatus === 'unknown' ? 'text-amber-700' : item.isOptimized ? 'text-emerald-700' : 'text-slate-600'">{{ item.metadataStatus === 'unknown' ? 'Unknown' : item.isOptimized ? 'Optimized' : 'Not optimized' }}</span></td><td class="px-5 py-3 text-slate-500">{{ item.savedPercent == null ? 'Not measured' : `${item.savedPercent}%` }}</td></tr>
          <tr v-if="!result.items.length"><td colspan="5" class="px-5 py-10 text-center text-slate-500">{{ overview.scan ? 'No JPEGs match these filters.' : 'Start a scan to discover JPEGs.' }}</td></tr></tbody>
      </table></div>
      <div class="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-sm"><span class="text-slate-500">Page {{ page }} of {{ maxPage }}</span><div class="flex gap-2"><button :disabled="page <= 1" class="rounded border border-slate-300 px-3 py-1.5 disabled:opacity-40" @click="page--">Previous</button><button :disabled="page >= maxPage" class="rounded border border-slate-300 px-3 py-1.5 disabled:opacity-40" @click="page++">Next</button></div></div>
    </section>
    <p class="mt-5 text-xs text-slate-500">Objects above 128 MiB are skipped. Review failed items in <code>/api/jobs/{id}</code>; verified originals remain under the backup prefix for recovery.</p>
  </main>
</template>
