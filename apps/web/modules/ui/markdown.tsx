import { Download } from 'lucide-react'
import Link from 'next/link'
import { type ComponentProps, memo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '../lib/format'
import { Boundary } from './boundary'

const VIDEO_FILE = /\.(mp4|mov|webm|m4v|ogv)$/i
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif)$/i

const linkStyle = 'break-words text-link hover:underline'

function embedFor(url: string): string | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, '')
    if (host === 'loom.com') {
      const id = /^\/(?:share|embed)\/([a-f0-9]{32})/.exec(parsed.pathname)?.[1]
      return id ? `https://www.loom.com/embed/${id}` : null
    }
    const youtube = host === 'youtu.be' ? parsed.pathname.slice(1) : host === 'youtube.com' ? parsed.searchParams.get('v') : null
    return youtube && /^[\w-]{6,20}$/.test(youtube) ? `https://www.youtube-nocookie.com/embed/${youtube}` : null
  } catch {
    return null
  }
}

function Media({ src, alt }: { src: string; alt: string }) {
  const [kind, setKind] = useState<'image' | 'video' | 'link'>(VIDEO_FILE.test(alt) ? 'video' : 'image')
  const name = alt || 'Attachment'
  if (kind === 'link')
    return (
      <a href={src} className={cn(linkStyle, 'inline-flex items-center gap-1')}>
        <Download className="size-3.5" />
        {name}
      </a>
    )
  if (kind === 'video')
    return (
      <span className="my-1 block">
        {/* biome-ignore lint/a11y/useMediaCaption: uploads from the tracker come without captions */}
        <video
          src={src}
          controls
          preload="metadata"
          aria-label={name}
          className="max-h-[32rem] max-w-full rounded-md border border-divider bg-soft"
          onError={() => setKind('link')}
        />
      </span>
    )
  return (
    <a href={src} target="_blank" rel="noreferrer" className="my-1 block w-fit max-w-full">
      {/* biome-ignore lint/performance/noImgElement: these come from the media proxy, which next/image cannot optimize */}
      <img
        src={src}
        alt={name}
        loading="lazy"
        className="max-h-[32rem] max-w-full rounded-md border border-divider bg-soft"
        onError={() => setKind(IMAGE_FILE.test(alt) ? 'link' : 'video')}
      />
    </a>
  )
}

/** Anything else is a request to a host the text chose, which would let agent output or a ticket leak data through an image URL. */
const isTrustedMedia = (src: string) => src.startsWith('/api/issues/')

const components: Components = {
  h1: ({ node: _node, ...props }) => <h2 className="mt-2 text-lg font-semibold" {...props} />,
  h2: ({ node: _node, ...props }) => <h3 className="mt-2 text-base font-semibold" {...props} />,
  h3: ({ node: _node, ...props }) => <h4 className="mt-1 text-sm font-semibold" {...props} />,
  h4: ({ node: _node, ...props }) => <h5 className="mt-1 text-sm font-semibold" {...props} />,
  h5: ({ node: _node, ...props }) => <h6 className="text-sm font-semibold" {...props} />,
  h6: ({ node: _node, ...props }) => <h6 className="text-sm font-semibold text-ink-2" {...props} />,
  ul: ({ node: _node, className, ...props }) => (
    <ul
      className={cn(
        'flex list-disc flex-col gap-1 pl-5 [&_ol]:mt-1 [&_ul]:mt-1',
        className?.includes('contains-task-list') && 'list-none pl-1',
        className,
      )}
      {...props}
    />
  ),
  ol: ({ node: _node, ...props }) => <ol className="flex list-decimal flex-col gap-1 pl-5 [&_ol]:mt-1 [&_ul]:mt-1" {...props} />,
  input: ({ node: _node, ...props }) => <input {...props} disabled className="mr-1.5 translate-y-px accent-[var(--color-signal)]" />,
  blockquote: ({ node: _node, ...props }) => <blockquote className="flex flex-col gap-2 border-l-2 border-field pl-3 text-ink-2" {...props} />,
  hr: () => <hr className="my-2 border-divider" />,
  a: ({ node: _node, href, children, ...props }) => {
    if (href?.startsWith('/issues/'))
      return (
        <Link href={href} className={linkStyle}>
          {children}
        </Link>
      )
    const bare = typeof children === 'string' && children === href
    const embed = bare && href ? embedFor(href) : null
    const link = (
      <a href={href} target="_blank" rel="noreferrer" className={linkStyle} {...props}>
        {children}
      </a>
    )
    if (!embed) return link
    return (
      <>
        {link}
        <span className="mt-2 block aspect-video w-full max-w-2xl overflow-hidden rounded-md border border-divider bg-soft">
          <iframe
            src={embed}
            title="Embedded video"
            loading="lazy"
            allow="fullscreen; picture-in-picture"
            sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
            referrerPolicy="strict-origin-when-cross-origin"
            className="size-full"
          />
        </span>
      </>
    )
  },
  img: ({ src, alt }) => {
    const url = typeof src === 'string' ? src : ''
    if (isTrustedMedia(url)) return <Media src={url} alt={alt ?? ''} />
    return url ? (
      <a href={url} target="_blank" rel="noreferrer" className={linkStyle}>
        {alt || url}
      </a>
    ) : null
  },
  code: ({ node: _node, className, children, ...props }: ComponentProps<'code'> & { node?: unknown }) =>
    className || String(children).includes('\n') ? (
      <code className={className} {...props}>
        {children}
      </code>
    ) : (
      <code className="rounded-sm bg-soft px-1 py-px font-mono text-[0.92em]" {...props}>
        {children}
      </code>
    ),
  pre: ({ node: _node, ...props }) => <pre className="scroll-thin overflow-x-auto rounded-md bg-soft p-3 font-mono text-xs" {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className="scroll-thin overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => <th className="border border-divider bg-softer px-2 py-1 text-left font-semibold" {...props} />,
  td: ({ node: _node, ...props }) => <td className="border border-divider px-2 py-1 align-top" {...props} />,
}

const plugins = [remarkGfm]

/** Expects portable Markdown, which the API produces with the source's formatter. Tracker and agent text is untrusted, so raw HTML is dropped. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2 text-sm break-words', className)}>
      <Boundary label="this text" resetKey={text} fallback={<p className="whitespace-pre-wrap">{text}</p>}>
        <ReactMarkdown remarkPlugins={plugins} components={components} skipHtml>
          {text}
        </ReactMarkdown>
      </Boundary>
    </div>
  )
})
