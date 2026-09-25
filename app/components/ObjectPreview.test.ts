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

test('loads a preview only after a click and encodes the selected bucket and key', async () => {
  const wrapper = mount(ObjectPreview, { props: { bucketId: 'photos', object: { key: '2026/café & sun.jpg', scanId: 12 } } })
  expect(wrapper.find('img').exists()).toBe(false)
  await wrapper.get('button').trigger('click')
  const image = wrapper.get('img')
  const url = new URL(image.attributes('src')!, 'http://localhost')
  expect(url.pathname).toBe('/api/objects/preview')
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ bucketId: 'photos', key: '2026/café & sun.jpg', scanId: '12' })
  expect(wrapper.text()).toContain('Loading')
  await image.trigger('load')
  expect(wrapper.text()).toContain('Hide preview')
  await wrapper.get('button').trigger('click')
  expect(wrapper.find('img').exists()).toBe(false)
  wrapper.unmount()
})

test('shows a retry when a preview fails', async () => {
  const wrapper = mount(ObjectPreview, { props: { bucketId: 'photos', object: { key: 'bad.jpg', scanId: 2 } } })
  await wrapper.get('button').trigger('click')
  const firstUrl = wrapper.get('img').attributes('src')
  await wrapper.get('img').trigger('error')
  expect(wrapper.text()).toContain('Unavailable')
  await wrapper.get('button').trigger('click')
  await nextTick()
  expect(wrapper.get('img').attributes('src')).not.toBe(firstUrl)
  wrapper.unmount()
})
