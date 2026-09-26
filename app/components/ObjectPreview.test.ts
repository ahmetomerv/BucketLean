// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { computed, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import ObjectPreview from './ObjectPreview.vue'

beforeEach(() => {
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
})
afterEach(() => { vi.unstubAllGlobals() })

function mountPreview(object: { key: string, scanId: number }) {
  return mount(ObjectPreview, {
    props: { bucketId: 'photos', object },
    global: { stubs: { Teleport: true } },
  })
}

test('loads a preview in a modal only after a click and encodes the selected bucket and key', async () => {
  const wrapper = mountPreview({ key: '2026/café & sun.jpg', scanId: 12 })
  expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  expect(wrapper.find('img').exists()).toBe(false)
  expect(wrapper.text()).not.toContain('JPEG')
  await wrapper.get('button').trigger('click')
  const dialog = wrapper.get('[role="dialog"]')
  expect(dialog.attributes('aria-modal')).toBe('true')
  expect(dialog.text()).toContain('2026/café & sun.jpg')
  const image = wrapper.get('img')
  const url = new URL(image.attributes('src')!, 'http://localhost')
  expect(url.pathname).toBe('/api/objects/preview')
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ bucketId: 'photos', key: '2026/café & sun.jpg', scanId: '12' })
  expect(wrapper.text()).toContain('Loading')
  expect(wrapper.text()).toContain('Show preview')
  await image.trigger('load')
  await nextTick()
  expect(wrapper.get('img').classes()).not.toContain('hidden')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await nextTick()
  expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  expect(wrapper.find('img').exists()).toBe(false)
  wrapper.unmount()
})

test('shows a retry when a preview fails', async () => {
  const wrapper = mountPreview({ key: 'bad.jpg', scanId: 2 })
  await wrapper.get('button').trigger('click')
  const firstUrl = wrapper.get('img').attributes('src')
  await wrapper.get('img').trigger('error')
  expect(wrapper.text()).toContain('Preview unavailable')
  const retry = wrapper.findAll('button').find(button => button.text().includes('Retry preview'))
  if (!retry) throw new Error('Retry preview button not found')
  await retry.trigger('click')
  await nextTick()
  expect(wrapper.get('img').attributes('src')).not.toBe(firstUrl)
  wrapper.unmount()
})
