import { resolve } from 'node:path'
import type { NextConfig } from 'next'

const apiUrl = process.env.API_URL ?? 'http://localhost:4100'
const pluginsUrl = process.env.FACTORIX_PLUGINS_INTERNAL_URL || 'http://localhost:4110'
const packagesUrl = process.env.FACTORIX_PACKAGES_INTERNAL_URL || 'http://localhost:4103'
const previewBase = new URL(process.env.FACTORIX_PREVIEW_URL ?? 'http://preview.localhost:4102')
const previewOrigins = `${previewBase.protocol}//*.${previewBase.host}`

const config: NextConfig = {
  compress: false,
  output: 'standalone',
  outputFileTracingRoot: resolve(import.meta.dirname, '../..'),
  reactStrictMode: true,
  transpilePackages: ['@factorix/schemas', '@factorix/runtime'],
  devIndicators: false,
  // Ticket and agent text must not be able to load a remote image or video, because the request itself can carry data out.
  // Previews are the one exception for frames: the issue page embeds the running app from the preview gateway.
  // Bundled and packaged plugins' pages keep the sandbox policy the plugin host or gateway sends, so nothing here may replace it.
  async headers() {
    return [
      {
        source: '/:path((?!_plugin/|_package/).*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: `img-src 'self' data: blob:; media-src 'self' blob:; frame-src https://www.loom.com https://www.youtube-nocookie.com ${previewOrigins}`,
          },
        ],
      },
    ]
  },
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${apiUrl}/api/:path*` },
      { source: '/webhooks/:path*', destination: `${apiUrl}/webhooks/:path*` },
      { source: '/_plugin/:path*', destination: `${pluginsUrl}/_plugin/:path*` },
      { source: '/_package/:path*', destination: `${packagesUrl}/_package/:path*` },
    ]
  },
}

export default config
