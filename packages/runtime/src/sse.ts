/** Yields the data of each server-sent event. Comments, ids, and retry hints are dropped. */
export async function* parseSse(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = ''
  let data: string[] = []
  for await (const chunk of chunks) {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (line === '') {
        if (data.length > 0) yield data.join('\n')
        data = []
      } else if (line.startsWith('data:')) {
        data.push(line.slice(line.startsWith('data: ') ? 6 : 5))
      }
    }
  }
}
