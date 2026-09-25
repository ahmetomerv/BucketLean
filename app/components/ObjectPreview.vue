<script setup lang="ts">
const props = defineProps<{ bucketId: string, object: { key: string, scanId: number } }>()
const requested = ref(false)
const loaded = ref(false)
const failed = ref(false)
const attempt = ref(0)

const previewUrl = computed(() => {
  const query = new URLSearchParams({ bucketId: props.bucketId, key: props.object.key,
    scanId: String(props.object.scanId), attempt: String(attempt.value) })
  return `/api/objects/preview?${query}`
})

function togglePreview() {
  if (requested.value && !failed.value) {
    requested.value = false
    loaded.value = false
    return
  }
  attempt.value++
  requested.value = true
  loaded.value = false
  failed.value = false
}
</script>

<template>
  <div class="flex flex-col items-center gap-1.5">
    <div class="flex h-[72px] w-[72px] items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 text-center text-[10px] text-slate-500" aria-live="polite">
      <img v-if="requested && !failed" :src="previewUrl" :alt="`Preview of ${object.key}`" width="72" height="72" decoding="async" class="h-full w-full object-contain" :class="loaded ? '' : 'hidden'" @load="loaded = true" @error="failed = true">
      <span v-if="!requested">JPEG</span>
      <span v-else-if="failed">Unavailable</span>
      <span v-else-if="!loaded">Loading…</span>
    </div>
    <button type="button" class="text-xs font-medium text-emerald-700 underline-offset-2 hover:underline" :aria-label="`${failed ? 'Retry' : requested ? 'Hide' : 'Show'} preview of ${object.key}`" @click="togglePreview">{{ failed ? 'Retry' : requested ? 'Hide' : 'Show' }} preview</button>
  </div>
</template>
