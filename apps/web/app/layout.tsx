import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import type { ReactNode } from 'react'
import { Toaster } from 'sonner'
import { THEME_SCRIPT } from '@/modules/shell/theme'
import { TooltipProvider } from '@/modules/ui'
import './globals.css'

const averta = localFont({
  src: [
    { path: '../public/fonts/Averta.otf', weight: '400', style: 'normal' },
    { path: '../public/fonts/Averta-Semibold.otf', weight: '600', style: 'normal' },
    { path: '../public/fonts/Averta-Bold.otf', weight: '700', style: 'normal' },
  ],
  variable: '--font-averta',
  display: 'swap',
  // Averta's own metrics sit glyphs about 1px above the line center. These center the cap height and keep the total height.
  declarations: [
    { prop: 'ascent-override', value: '85.5%' },
    { prop: 'descent-override', value: '14.5%' },
  ],
})

const DESCRIPTION = 'The agentic software factory. Agents pick up Linear issues, open GitLab merge requests, and answer review.'

export const metadata: Metadata = {
  metadataBase: new URL(process.env.FACTORIX_PUBLIC_URL ?? 'http://localhost:4101'),
  title: { default: 'Factorix', template: '%s · Factorix' },
  description: DESCRIPTION,
  applicationName: 'Factorix',
  openGraph: { type: 'website', siteName: 'Factorix', title: 'Factorix', description: DESCRIPTION, url: '/' },
  twitter: { card: 'summary_large_image', title: 'Factorix', description: DESCRIPTION },
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#1d1d1f' },
  ],
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={averta.variable} suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant that sets the theme before first paint */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: 'var(--surface)',
              color: 'var(--ink)',
              border: '1px solid var(--divider)',
              fontFamily: 'var(--font-sans)',
              fontSize: 13,
            },
          }}
        />
      </body>
    </html>
  )
}
