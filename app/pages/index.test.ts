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
  scan?: { id: number, bucketId: string, status: string, prefix: string, discoveredCount: number, metadataErrorCount: number, startedAt: string | null } | null
  eligible?: number
  activeJob?: boolean
  attentionJob?: boolean
  pausedJob?: boolean
}

function setupData({ scan = null, eligible = 0, activeJob = false, attentionJob = false, pausedJob = false }: DashboardData = {}) {
  const overview = ref({ scan, totals: { objects: 0, jpegs: eligible, jpegBytes: 0, optimized: 0, eligible, metadataUnknown: 0 } })
  const objects = ref({ items: eligible ? [{ scanId: scan?.id ?? 1, key: 'photos/one.jpg', etag: '"old"', size: 10 * 1048576,
    isJpeg: true, isOptimized: false, metadataStatus: 'known', lastModified: null, savedPercent: null }] : [], total: eligible ? 1 : 0, page: 1, pageSize: 100 })
  const attentionSummary = { job: { id: 1, bucketId: 'default', status: 'needs_attention' },
    total: 1, completed: 0, skipped: 0, sourceChanged: 0, invalidJpeg: 0, failed: 0, needsAttention: 1,
    originalBytes: 100, finalBytes: null, savedBytes: null, savedPercent: null, current: null, nextRetryAt: null }
  const jobs = ref({ jobs: attentionJob ? [
    { ...attentionSummary, job: { id: 2, bucketId: 'default', status: 'completed' }, needsAttention: 0,
      finalBytes: 70, savedBytes: 30, savedPercent: 30 }, attentionSummary,
  ] : activeJob || pausedJob ? [{ job: { id: 1, bucketId: 'default', status: pausedJob ? 'paused' : 'running', pauseReason: pausedJob ? 'credentials: Access denied' : null },
    total: 1, completed: 0, skipped: 0, sourceChanged: 0, invalidJpeg: 0, failed: 0, needsAttention: 0,
    originalBytes: 100, finalBytes: 100, savedBytes: 0,
    savedPercent: 0, current: null, nextRetryAt: null }] : [] })
  vi.stubGlobal('useFetch', (url: string) => {
    if (url === '/api/buckets') return { data: ref({ buckets: [
      { id: 'default', endpoint: 'https://example.r2.cloudflarestorage.com/', bucket: 'test' },
      { id: 'media', endpoint: 'https://example.r2.cloudflarestorage.com/', bucket: 'media' },
    ] }) }
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
  expect(wrapper.find('h1').text()).toBe('BucketLean')
  expect(wrapper.find('header img').exists()).toBe(true)
  expect(wrapper.find('header img').attributes('alt')).toBe('')
  const scanSection = wrapper.findAll('section').find(section => section.text().includes('Start scan'))
  expect(scanSection?.text()).toContain('R2 bucket')
  expect(scanSection?.text()).toContain('Scan prefix')
  expect(button('Start job').attributes('disabled')).toBeDefined()
  await inputFor('Scan prefix').setValue('photos/test/')
  await button('Start scan').trigger('click')
  await flushPromises()
  expect(post).toHaveBeenCalledWith('/api/scan', { method: 'POST', body: { bucketId: 'default', prefix: 'photos/test/' } })
  expect(refreshOverview).toHaveBeenCalledOnce()
  expect(refreshObjects).toHaveBeenCalledOnce()
  wrapper.unmount()
})

test('job start requires acknowledgment and submits the selected settings', async () => {
  setupData({ scan: { id: 1, bucketId: 'default', status: 'completed', prefix: '', discoveredCount: 2, metadataErrorCount: 0, startedAt: null }, eligible: 2 })
  const { wrapper, button, inputFor } = await renderPage()
  expect(wrapper.text()).not.toContain('Back up originals (required)')
  expect(wrapper.text()).toContain('Each original is backed up before replacement.')
  const jobSection = wrapper.findAll('section').find(section => section.find('h2').exists() && section.find('h2').text() === 'Optimize eligible JPEGs')
  expect(jobSection?.text()).toContain('Minimum original size (MiB)')
  expect((inputFor('Minimum original size').element as HTMLInputElement).value).toBe('1')
  expect(button('Start job').attributes('disabled')).toBeDefined()
  await inputFor('Key prefix').setValue('photos/')
  await inputFor('Minimum original size').setValue('2')
  await inputFor('JPEG preset').setValue('archival')
  await inputFor('Minimum saving').setValue('25')
  await inputFor('Preserve photo metadata').setValue(false)
  await inputFor('I understand').setValue(true)
  expect(button('Start job').attributes('disabled')).toBeDefined()
  await wrapper.find('input[aria-label="Select photos/one.jpg"]').setValue(true)
  expect(wrapper.text()).toContain('1 selected for this job')
  expect(button('Start job').attributes('disabled')).toBeUndefined()
  await button('Start job').trigger('click')
  await flushPromises()
  expect(post).toHaveBeenCalledWith('/api/jobs', { method: 'POST', body: {
    bucketId: 'default', scanId: 1, selectedKeys: ['photos/one.jpg'], prefix: 'photos/', minBytes: 2 * 1048576, preset: 'archival', minimumSavingPercent: 25,
    preserveMetadata: false, deleteBackupAfterOptimization: false,
  } })
  expect(refreshJobs).toHaveBeenCalledOnce()
  expect((inputFor('I understand').element as HTMLInputElement).checked).toBe(false)
  wrapper.unmount()
})

test('minimum original size offers presets and accepts custom values from 1 to 50 MiB', async () => {
  setupData({ scan: { id: 1, bucketId: 'default', status: 'completed', prefix: '', discoveredCount: 1, metadataErrorCount: 0, startedAt: null }, eligible: 1 })
  const { wrapper, button, inputFor } = await renderPage()
  const sizeInput = inputFor('Minimum original size')
  await inputFor('I understand').setValue(true)
  await wrapper.find('input[aria-label="Select photos/one.jpg"]').setValue(true)

  for (const size of [3, 5, 8]) {
    await button(`${size} MiB`).trigger('click')
    await wrapper.find('input[aria-label="Select photos/one.jpg"]').setValue(true)
    expect((sizeInput.element as HTMLInputElement).value).toBe(String(size))
    expect(button(`${size} MiB`).attributes('aria-pressed')).toBe('true')
  }

  await sizeInput.setValue('0')
  expect(button('Start job').attributes('disabled')).toBeDefined()
  await sizeInput.setValue('50.1')
  expect(button('Start job').attributes('disabled')).toBeDefined()
  await sizeInput.setValue('50')
  await wrapper.find('input[aria-label="Select photos/one.jpg"]').setValue(true)
  expect(button('Start job').attributes('disabled')).toBeUndefined()
  await sizeInput.setValue('1')
  await wrapper.find('input[aria-label="Select photos/one.jpg"]').setValue(true)
  expect(button('Start job').attributes('disabled')).toBeUndefined()
  await sizeInput.setValue('')
  expect(button('Start job').attributes('disabled')).toBeDefined()
  await sizeInput.setValue('4.25')
  await wrapper.find('input[aria-label="Select photos/one.jpg"]').setValue(true)
  expect(button('Start job').attributes('disabled')).toBeUndefined()
  expect(button('3 MiB').attributes('aria-pressed')).toBe('false')
  await button('Start job').trigger('click')
  await flushPromises()
  expect(post).toHaveBeenCalledWith('/api/jobs', { method: 'POST', body: expect.objectContaining({ minBytes: 4.25 * 1048576 }) })
  wrapper.unmount()
})

test('active work disables conflicting actions and API errors remain visible', async () => {
  setupData({ scan: { id: 1, bucketId: 'default', status: 'completed', prefix: '', discoveredCount: 1, metadataErrorCount: 0, startedAt: null }, eligible: 1, activeJob: true })
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
  setupData({ scan: { id: 1, bucketId: 'default', status: 'completed', prefix: '', discoveredCount: 1,
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
  setupData({ scan: { id: 1, bucketId: 'default', status: 'completed', prefix: '', discoveredCount: 1,
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

test('switching buckets sends the selected profile ID and clears the previous scan context', async () => {
  setupData({ scan: { id: 1, bucketId: 'default', status: 'completed', prefix: '', discoveredCount: 1,
    metadataErrorCount: 0, startedAt: null }, eligible: 1 })
  const { wrapper, button, inputFor } = await renderPage()
  await inputFor('R2 bucket').setValue('media')
  await nextTick()
  expect(button('Start job').attributes('disabled')).toBeDefined()
  await inputFor('Scan prefix').setValue('media/test/')
  await button('Start scan').trigger('click')
  await flushPromises()
  expect(post).toHaveBeenCalledWith('/api/scan', { method: 'POST', body: { bucketId: 'media', prefix: 'media/test/' } })
  wrapper.unmount()
})

test('backup cleanup is opt-in while required backup creation stays implicit', async () => {
  setupData({ scan: { id: 1, bucketId: 'default', status: 'completed', prefix: '', discoveredCount: 1,
    metadataErrorCount: 0, startedAt: null }, eligible: 1 })
  const { wrapper, button, inputFor } = await renderPage()
  const deletion = inputFor('Delete the original backup')
  expect((deletion.element as HTMLInputElement).checked).toBe(false)
  await deletion.setValue(true)
  await inputFor('I understand').setValue(true)
  await wrapper.find('input[aria-label="Select photos/one.jpg"]').setValue(true)
  await button('Start job').trigger('click')
  await flushPromises()
  expect(post).toHaveBeenCalledWith('/api/jobs', { method: 'POST', body: expect.objectContaining({
    deleteBackupAfterOptimization: true,
  }) })
  wrapper.unmount()
})

test('selection persists across pages and clears when filters change', async () => {
  const data = setupData({ scan: { id: 4, bucketId: 'default', status: 'completed', prefix: '', discoveredCount: 2,
    metadataErrorCount: 0, startedAt: null }, eligible: 2 })
  data.objects.value.total = 200
  const { wrapper, button, inputFor } = await renderPage()
  await wrapper.find('input[aria-label="Select photos/one.jpg"]').setValue(true)
  expect(wrapper.text()).toContain('1 selected for this job')
  await button('Next').trigger('click')
  data.objects.value.items = [{ ...data.objects.value.items[0]!, key: 'photos/two.jpg' }]
  await nextTick()
  await wrapper.find('input[aria-label="Select photos/two.jpg"]').setValue(true)
  expect(wrapper.text()).toContain('2 selected for this job')
  await button('Previous').trigger('click')
  data.objects.value.items = [{ ...data.objects.value.items[0]!, key: 'photos/one.jpg' }]
  await nextTick()
  expect((wrapper.find('input[aria-label="Select photos/one.jpg"]').element as HTMLInputElement).checked).toBe(true)
  await inputFor('Key prefix').setValue('other/')
  expect(wrapper.text()).toContain('0 selected for this job')
  expect(button('Start job').attributes('disabled')).toBeDefined()
  wrapper.unmount()
})

test('page selection excludes optimized and unknown objects', async () => {
  const data = setupData({ scan: { id: 3, bucketId: 'default', status: 'completed', prefix: '', discoveredCount: 3,
    metadataErrorCount: 0, startedAt: null }, eligible: 1 })
  const eligible = data.objects.value.items[0]!
  data.objects.value.items = [eligible, { ...eligible, key: 'photos/done.jpg', isOptimized: true },
    { ...eligible, key: 'photos/unknown.jpg', metadataStatus: 'unknown' }]
  const { wrapper, button } = await renderPage()
  expect(wrapper.find('input[aria-label="Select photos/done.jpg"]').attributes('disabled')).toBeDefined()
  expect(wrapper.find('input[aria-label="Select photos/unknown.jpg"]').attributes('disabled')).toBeDefined()
  await button('Select eligible on this page').trigger('click')
  expect(wrapper.text()).toContain('1 selected for this job')
  await button('Deselect this page').trigger('click')
  expect(wrapper.text()).toContain('0 selected for this job')
  wrapper.unmount()
})

test('clicking an eligible row toggles selection without preview or checkbox double toggles', async () => {
  const data = setupData({ scan: { id: 5, bucketId: 'default', status: 'completed', prefix: '', discoveredCount: 2,
    metadataErrorCount: 0, startedAt: null }, eligible: 1 })
  const eligible = data.objects.value.items[0]!
  data.objects.value.items = [eligible, { ...eligible, key: 'photos/done.jpg', isOptimized: true }]
  const { wrapper } = await renderPage()
  expect(wrapper.findAll('thead th').map(cell => cell.text())).toEqual([
    'Select', 'Object key', 'Original size', 'Last modified', 'Status', 'Saving', 'Preview',
  ])
  const rows = wrapper.findAll('tbody tr')
  const checkbox = rows[0]!.find('input[type="checkbox"]')
  expect(checkbox.classes()).toContain('h-5')
  expect(checkbox.classes()).toContain('w-5')
  await rows[0]!.findAll('td')[1]!.trigger('click')
  expect((checkbox.element as HTMLInputElement).checked).toBe(true)
  await rows[0]!.find('button[aria-label="Show preview of photos/one.jpg"]').trigger('click')
  expect((checkbox.element as HTMLInputElement).checked).toBe(true)
  await checkbox.setValue(false)
  expect((checkbox.element as HTMLInputElement).checked).toBe(false)
  await rows[0]!.trigger('keydown.space')
  expect((checkbox.element as HTMLInputElement).checked).toBe(true)
  await rows[1]!.trigger('click')
  expect(wrapper.text()).toContain('1 selected for this job')
  wrapper.unmount()
})
