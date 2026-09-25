import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(defineConfig({
  title: 'BucketLean',
  description: 'Self-hosted JPEG optimization for Cloudflare R2',
  base: process.env.DOCS_BASE || '/',
  vite: {
    optimizeDeps: { include: ['fastdom', 'fastdom/extensions/fastdom-promised.js'] },
  },
  themeConfig: {
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
