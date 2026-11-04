import { resolve } from 'node:path'
import type { NextConfig } from 'next'

const apiUrl = process.env.API_URL ?? 'http://localhost:4100'

const config: NextConfig = {
  compress: false,
  output: 'standalone',
  outputFileTracingRoot: resolve(import.meta.dirname, '../..'),
  reactStrictMode: true,
  transpilePackages: ['@factorix/schemas', '@factorix/runtime'],
  devIndicators: false,
  // Ticket and agent text must not be able to load a remote image or video, because the request itself can carry data out.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "img-src 'self' data: blob:; media-src 'self' blob:; frame-src https://www.loom.com https://www.youtube-nocookie.com",
          },
        ],
      },
    ]
  },
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${apiUrl}/api/:path*` },
      { source: '/webhooks/:path*', destination: `${apiUrl}/webhooks/:path*` },
    ]
  },
}

export default config
