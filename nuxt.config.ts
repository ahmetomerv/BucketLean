export default defineNuxtConfig({
  compatibilityDate: '2026-09-22',
  modules: ['@element-plus/nuxt'],
  elementPlus: {
    installMethods: ['ElMessageBox'],
    themes: ['dark'],
  },
  app: { head: {
    title: 'BucketLean',
    meta: [{ name: 'color-scheme', content: 'light dark' }],
    script: [{
      key: 'system-color-scheme',
      tagPriority: 'critical',
      innerHTML: `(function(){var query=window.matchMedia('(prefers-color-scheme: dark)');var apply=function(){document.documentElement.classList.toggle('dark',query.matches)};apply();query.addEventListener('change',apply)})()`,
    }],
    link: [
      { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' },
      { rel: 'icon', type: 'image/svg+xml', href: '/bucketlean-logo.svg' },
      { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
    ],
  } },
  css: ['~/assets/css/main.css'],
  nitro: { preset: 'node-server', externals: { inline: [/shared\/r2-profiles\.mjs$/] } },
  typescript: { strict: true },
  devtools: { enabled: false },
})
