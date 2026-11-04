import type { MetadataRoute } from 'next'

// Crawling stays open because a crawler has to read the noindex tag to obey it, and link previews need the page.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/webhooks/'] } }
}
