// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, onMounted, onUnmounted, ref, Suspense, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import Page from './index.vue'

const refreshOverview = vi.fn(async () => {})
const refreshObjects = vi.fn(async () => {})
const refreshJobs = vi.fn(async () => {})
const post = vi.fn(async () => ({}))

type DashboardData = {
  scan?: { id: number, status: string, prefix: string, discoveredCount: number, metadataErrorCount: number, startedAt: string | null } | null
  eligible?: number
  activeJob?: boolean
  attentionJob?: boolean
  pausedJob?: boolean
}

function setupData({ scan = null, eligible = 0, activeJob = false, attentionJob = false, pausedJob = false }: DashboardData = {}) {
  const overview = ref({ scan, totals: { objects: 0, jpegs: eligible, jpegBytes: 0, optimized: 0, eligible, metadataUnknown: 0 } })
  const objects = ref({ items: [], total: 0, page: 1, pageSize: 100 })
  const attentionSummary = { job: { id: 1, status: 'needs_attention' },
    total: 1, completed: 0, skipped: 0, sourceChanged: 0, invalidJpeg: 0, failed: 0, needsAttention: 1,
    originalBytes: 100, finalBytes: null, savedBytes: null, savedPercent: null, current: null, nextRetryAt: null }
  const jobs = ref({ jobs: attentionJob ? [
    { ...attentionSummary, job: { id: 2, status: 'completed' }, needsAttention: 0,
      finalBytes: 70, savedBytes: 30, savedPercent: 30 }, attentionSummary,
  ] : activeJob || pausedJob ? [{ job: { id: 1, status: pausedJob ? 'paused' : 'running', pauseReason: pausedJob ? 'credentials: Access denied' : null },
    total: 1, completed: 0, skipped: 0, sourceChanged: 0, invalidJpeg: 0, failed: 0, needsAttention: 0,
    originalBytes: 100, finalBytes: 100, savedBytes: 0,
    savedPercent: 0, current: null, nextRetryAt: null }] : [] })
  vi.stubGlobal('useFetch', (url: string) => {
    if (url === '/api/overview') return { data: overview, refresh: refreshOverview }
    if (url === '/api/objects') return { data: objects, refresh: refreshObjects }
    if (url === '/api/jobs') return { data: jobs, refresh: refreshJobs }
    throw new Error(`Unexpected useFetch URL: ${url}`)
  })
  return { overview, objects, jobs }
}

async function renderPage() {
  const Host = defineComponent({ render: () => h(Suspense, null, { default: () => h(Page) }) })
  const wrapper = mount(Host)
  await flushPromises()
  await nextTick()
  const button = (label: string) => {
    const found = wrapper.findAll('button').find(item => item.text().includes(label))
    if (!found) throw new Error(`Button not found: ${label}`)
    return found
  }
  const inputFor = (label: string) => {
    const found = wrapper.findAll('label').find(item => item.text().includes(label))
    if (!found) throw new Error(`Label not found: ${label}`)
    return found.find('input, select')
  }
  return { wrapper, button, inputFor }
}

beforeEach(() => {
  for (const [name, value] of Object.entries({ ref, computed, watch, onMounted, onUnmounted })) vi.stubGlobal(name, value)
  vi.stubGlobal('$fetch', post)
  vi.clearAllMocks()
})
afterEach(() => { vi.unstubAllGlobals() })

test('scan sends its prefix and refreshes the displayed results', async () => {
  setupData()
  const { wrapper, button, inputFor } = await renderPage()
  expect(button('Start job').attributes('disabled')).toBeDefined()
  await inputFor('Scan prefix').setValue('photos/test/')
  await button('Start scan').trigger('click')
  await flushPromises()
  expect(post).toHaveBeenCalledWith('/api/scan', { method: 'POST', body: { prefix: 'photos/test/' } })
  expect(refreshOverview).toHaveBeenCalledOnce()
  expect(refreshObjects).toHaveBeenCalledOnce()
  wrapper.unmount()
})

test('job start requires acknowledgment and submits the selected settings', async () => {
  setupData({ scan: { id: 1, status: 'completed', prefix: '', discoveredCount: 2, metadataErrorCount: 0, startedAt: null }, eligible: 2 })
  const { wrapper, button, inputFor } = await renderPage()
  expect(button('Start job').attributes('disabled')).toBeDefined()
  await inputFor('Key prefix').setValue('photos/')
  await inputFor('Minimum MiB').setValue('2')
  await inputFor('JPEG preset').setValue('archival')
  await inputFor('Minimum saving').setValue('25')
  await inputFor('Preserve photo metadata').setValue(false)
  await inputFor('I understand').setValue(true)
  expect(button('Start job').attributes('disabled')).toBeUndefined()
  await button('Start job').trigger('click')
  await flushPromises()
  expect(post).toHaveBeenCalledWith('/api/jobs', { method: 'POST', body: {
    prefix: 'photos/', minBytes: 2 * 1048576, preset: 'archival', minimumSavingPercent: 25,
    preserveMetadata: false, backupOriginals: true,
  } })
  expect(refreshJobs).toHaveBeenCalledOnce()
  expect((inputFor('I understand').element as HTMLInputElement).checked).toBe(false)
  wrapper.unmount()
})

test('active work disables conflicting actions and API errors remain visible', async () => {
  setupData({ scan: { id: 1, status: 'completed', prefix: '', discoveredCount: 1, metadataErrorCount: 0, startedAt: null }, eligible: 1, activeJob: true })
  const active = await renderPage()
  expect(active.button('Start scan').attributes('disabled')).toBeDefined()
  expect(active.button('Job in progress').attributes('disabled')).toBeDefined()
  active.wrapper.unmount()

  setupData()
  post.mockRejectedValueOnce({ data: { statusMessage: 'R2 unavailable' } })
  const failed = await renderPage()
  await failed.button('Start scan').trigger('click')
  await flushPromises()
  expect(failed.wrapper.text()).toContain('R2 unavailable')
  failed.wrapper.unmount()
})

test('an uncertain job shows unknown totals and offers an explicit remote recheck', async () => {
  setupData({ scan: { id: 1, status: 'completed', prefix: '', discoveredCount: 1,
    metadataErrorCount: 0, startedAt: null }, eligible: 1, attentionJob: true })
  const { wrapper, button } = await renderPage()
  expect(wrapper.text()).toContain('Pending verification')
  expect(wrapper.text()).toContain('1 need attention')
  expect(button('Start scan').attributes('disabled')).toBeDefined()
  await button('Recheck remote state').trigger('click')
  await flushPromises()
  expect(post).toHaveBeenCalledWith('/api/jobs/1/reconcile', { method: 'POST' })
  expect(refreshJobs).toHaveBeenCalledOnce()
  wrapper.unmount()
})

test('a paused job shows the access error and resumes explicitly', async () => {
  setupData({ scan: { id: 1, status: 'completed', prefix: '', discoveredCount: 1,
    metadataErrorCount: 0, startedAt: null }, eligible: 1, pausedJob: true })
  const { wrapper, button } = await renderPage()
  expect(wrapper.text()).toContain('Access denied')
  expect(button('Start scan').attributes('disabled')).toBeDefined()
  expect(button('Job paused').attributes('disabled')).toBeDefined()
  await button('Resume job').trigger('click')
  await flushPromises()
  expect(post).toHaveBeenCalledWith('/api/jobs/1/resume', { method: 'POST' })
  expect(refreshJobs).toHaveBeenCalledOnce()
  wrapper.unmount()
})
