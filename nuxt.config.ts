import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2026-09-22',
  app: { head: {
    title: 'BucketLean',
    link: [
      { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' },
      { rel: 'icon', type: 'image/svg+xml', href: '/bucketlean-logo.svg' },
      { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
    ],
  } },
  css: ['~/assets/css/main.css'],
  vite: { plugins: [tailwindcss()] },
  nitro: { preset: 'node-server', externals: { inline: [/shared\/r2-profiles\.mjs$/] } },
  typescript: { strict: true },
  devtools: { enabled: false },
})
