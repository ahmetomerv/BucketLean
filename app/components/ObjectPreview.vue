<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue'

const props = defineProps<{ bucketId: string, object: { key: string, scanId: number } }>()
const open = ref(false)
const loaded = ref(false)
const failed = ref(false)
const attempt = ref(0)
const trigger = ref<{ $el?: HTMLButtonElement } | null>(null)

const previewUrl = computed(() => {
  const query = new URLSearchParams({ bucketId: props.bucketId, key: props.object.key,
    scanId: String(props.object.scanId), attempt: String(attempt.value) })
  return `/api/objects/preview?${query}`
})

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closePreview()
}

function openPreview() {
  attempt.value++
  loaded.value = false
  failed.value = false
  open.value = true
  document.removeEventListener('keydown', onDocumentKeydown)
  document.addEventListener('keydown', onDocumentKeydown)
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
  document.removeEventListener('keydown', onDocumentKeydown)
  void nextTick(() => trigger.value?.$el?.focus())
}

onUnmounted(() => {
  open.value = false
  document.removeEventListener('keydown', onDocumentKeydown)
})
</script>

<template>
  <el-button ref="trigger" link type="primary" aria-haspopup="dialog" :aria-label="`Show preview of ${object.key}`" @click="openPreview">Show preview</el-button>
  <el-dialog v-if="open" :model-value="true" title="Preview" width="896px" align-center append-to-body @close="closePreview">
    <p class="object-key">{{ object.key }}</p>
    <div class="preview-stage" aria-live="polite">
      <img v-if="!failed" :src="previewUrl" :alt="`Preview of ${object.key}`" decoding="async" class="preview-image" :class="{ hidden: !loaded }" @load="loaded = true" @error="failed = true">
      <div v-if="failed" class="preview-fallback">
        <p>Preview unavailable.</p>
        <el-button @click="retryPreview">Retry preview</el-button>
      </div>
      <p v-else-if="!loaded">Loading…</p>
    </div>
    <template #footer>
      <el-button @click="closePreview">Close</el-button>
    </template>
  </el-dialog>
</template>
