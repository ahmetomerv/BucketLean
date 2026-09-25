import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2026-09-22',
  app: { head: { title: 'BucketLean' } },
  css: ['~/assets/css/main.css'],
  vite: { plugins: [tailwindcss()] },
  nitro: { preset: 'node-server', externals: { inline: [/shared\/r2-profiles\.mjs$/] } },
  typescript: { strict: true },
  devtools: { enabled: false },
})
