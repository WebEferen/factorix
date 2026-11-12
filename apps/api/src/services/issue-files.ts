import type { SourceMarkup, TrackerConnector, TrackerResource } from '@factorix/connectors'
import type { PhaseResource } from '@factorix/core'
import { ISSUE_FILES_DIR, type RunFile } from '@factorix/runtime'

export const MAX_FILES = 20
export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024

const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'video/mp4': '.mp4',
}

/** Uploads written into the description, which the source's markup recognizes, as files unless a resource already lists them. */
export function uploadsIn(text: string | null, markup: SourceMarkup | undefined, listed: TrackerResource[]): TrackerResource[] {
  if (!text || !markup) return []
  const urls: string[] = []
  // A placeholder rather than the URL itself, so a dialect that also links bare upload URLs cannot match the same one twice.
  const markdown = markup.toMarkdown(text, { media: (url) => `factorix-upload:${urls.push(url) - 1}` })
  const known = new Set(listed.map((resource) => resource.url))
  return urls.flatMap((url, index) => {
    if (known.has(url)) return []
    known.add(url)
    const label = new RegExp(`\\[([^\\]]*)\\]\\(factorix-upload:${index}\\)`).exec(markdown)?.[1]?.trim()
    return [{ kind: 'file' as const, title: label || 'upload', url, subtitle: 'in the description', content: null }]
  })
}

/**
 * Reads each file with the tracker's credentials, which stay here, and hands back copies for the container. Text is masked
 * with `redact` first. Files over the limits are listed with a note instead.
 */
export async function copyFiles(
  tracker: Pick<TrackerConnector, 'fetchMedia'>,
  resources: PhaseResource[],
  redact: (text: string) => string,
  warn: (message: string) => void,
): Promise<RunFile[]> {
  const files: RunFile[] = []
  let room = MAX_TOTAL_BYTES
  for (const resource of resources) {
    if (resource.kind !== 'file') continue
    if (files.length >= MAX_FILES) {
      resource.note = `only the first ${MAX_FILES} files are copied`
      continue
    }
    const limit = Math.min(MAX_FILE_BYTES, room)
    try {
      const read = await download(tracker, resource.url, limit)
      if (read === 'missing') {
        resource.note = 'the tracker did not return it'
        continue
      }
      if (read === 'too large') {
        resource.note = limit < MAX_FILE_BYTES ? 'the files before it used the 25 MB allowed' : 'it is over 10 MB'
        continue
      }
      const bytes = maskText(read.bytes, redact)
      const name = `${files.length + 1}-${fileName(resource.title, read.contentType)}`
      files.push({ name, content: bytes.toString('base64') })
      resource.path = `${ISSUE_FILES_DIR}/${name}`
      room -= read.bytes.length
    } catch (error) {
      resource.note = 'it could not be read'
      warn(`Could not copy ${resource.title} from the tracker: ${(error as Error).message}`)
    }
  }
  return files
}

async function download(
  tracker: Pick<TrackerConnector, 'fetchMedia'>,
  url: string,
  limit: number,
): Promise<{ bytes: Buffer; contentType: string | null } | 'missing' | 'too large'> {
  const media = await tracker.fetchMedia(url)
  if (!media) return 'missing'
  if (Number(media.contentLength) > limit) {
    await media.body.cancel()
    return 'too large'
  }
  const reader = media.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) {
      await reader.cancel()
      return 'too large'
    }
    chunks.push(value)
  }
  return { bytes: Buffer.concat(chunks), contentType: media.contentType }
}

/** Text, by its bytes rather than a declared type, is masked. Binary files such as images go as they are. */
function maskText(bytes: Buffer, redact: (text: string) => string): Buffer {
  if (bytes.subarray(0, 8192).includes(0)) return bytes
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return bytes
  }
  return Buffer.from(redact(text), 'utf8')
}

function fileName(title: string, contentType: string | null): string {
  const base =
    title
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[.-]+|-+$/g, '')
      .slice(0, 80) || 'file'
  if (/\.[A-Za-z0-9]{1,8}$/.test(base)) return base
  return `${base}${EXTENSIONS[contentType?.split(';')[0]?.trim() ?? ''] ?? ''}`
}
