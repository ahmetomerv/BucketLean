<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue'

const props = defineProps<{ bucketId: string, object: { key: string, scanId: number } }>()
const open = ref(false)
const loaded = ref(false)
const failed = ref(false)
const attempt = ref(0)
const trigger = ref<HTMLButtonElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closePreview()
}

const previewUrl = computed(() => {
  const query = new URLSearchParams({ bucketId: props.bucketId, key: props.object.key,
    scanId: String(props.object.scanId), attempt: String(attempt.value) })
  return `/api/objects/preview?${query}`
})

function openPreview() {
  attempt.value++
  loaded.value = false
  failed.value = false
  open.value = true
  document.body.style.overflow = 'hidden'
  document.removeEventListener('keydown', onDocumentKeydown)
  document.addEventListener('keydown', onDocumentKeydown)
  void nextTick(() => closeButton.value?.focus())
}

function retryPreview() {
  attempt.value++
  loaded.value = false
  failed.value = false
}

function closePreview() {
  if (!open.value) return
  open.value = false
  loaded.value = false
  failed.value = false
  document.body.style.overflow = ''
  document.removeEventListener('keydown', onDocumentKeydown)
  trigger.value?.focus()
}

onUnmounted(() => {
  document.body.style.overflow = ''
  document.removeEventListener('keydown', onDocumentKeydown)
})
</script>

<template>
  <button ref="trigger" type="button" class="text-xs font-medium text-orange-700 underline-offset-2 hover:underline" aria-haspopup="dialog" :aria-label="`Show preview of ${object.key}`" @click="openPreview">Show preview</button>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" @click.self="closePreview">
      <div role="dialog" aria-modal="true" aria-labelledby="preview-title" class="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xs border border-slate-200 bg-white shadow-xl" @keydown.esc="closePreview">
        <div class="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div class="min-w-0">
            <h2 id="preview-title" class="text-sm font-semibold text-slate-900">Preview</h2>
            <p class="mt-1 break-all font-mono text-xs text-slate-600">{{ object.key }}</p>
          </div>
          <button ref="closeButton" type="button" class="shrink-0 rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-600" @click="closePreview">Close</button>
        </div>
        <div class="flex min-h-48 flex-1 items-center justify-center bg-slate-50 p-4" aria-live="polite">
          <img v-if="!failed" :src="previewUrl" :alt="`Preview of ${object.key}`" decoding="async" class="max-h-[70vh] max-w-full object-contain" :class="loaded ? '' : 'hidden'" @load="loaded = true" @error="failed = true">
          <div v-if="failed" class="flex flex-col items-center gap-3 text-center">
            <p class="text-sm text-slate-600">Preview unavailable.</p>
            <button type="button" class="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700" @click="retryPreview">Retry preview</button>
          </div>
          <p v-else-if="!loaded" class="text-sm text-slate-600">Loading…</p>
        </div>
      </div>
    </div>
  </Teleport>
</template>
