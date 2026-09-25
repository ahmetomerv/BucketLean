import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

const base = process.env.DOCS_BASE || '/'

export default withMermaid(defineConfig({
  title: 'BucketLean',
  description: 'Self-hosted JPEG optimization for Cloudflare R2',
  base,
  head: [
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: `${base}favicon-32.png` }],
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}bucketlean-logo.svg` }],
    ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: `${base}apple-touch-icon.png` }],
  ],
  vite: {
    optimizeDeps: { include: ['fastdom', 'fastdom/extensions/fastdom-promised.js'] },
  },
  themeConfig: {
    logo: '/bucketlean-logo.svg',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/' },
      { text: 'Architecture', link: '/architecture' },
    ],
    sidebar: [
      { text: 'Guide', items: [
        { text: 'Getting started', link: '/guide/getting-started' },
        { text: 'Architecture', link: '/architecture' },
        { text: 'Operations and recovery', link: '/operations' },
      ] },
      { text: 'HTTP API', items: [
        { text: 'Overview and authentication', link: '/api/' },
        { text: 'Endpoints', link: '/api/endpoints' },
        { text: 'Automation workflow', link: '/api/workflow' },
      ] },
    ],
    search: { provider: 'local' },
    footer: { message: 'BucketLean is self-hosted software. The documentation site is static.' },
  },
}))
