import { connectRunner } from './link'
import { serveTunnel } from './tunnel'

const need = (name: string): string => {
  const value = process.env[name]
  if (!value) {
    console.error(`[preview-tunnel] ${name} is not set`)
    process.exit(1)
  }
  return value
}

const log = (message: string) => console.error(`[preview-tunnel] ${message}`)
const link = connectRunner({ url: need('FACTORIX_STORE_URL'), token: need('FACTORIX_STORE_SECRET'), log })
const stop = serveTunnel(link, { log })

const shutdown = () => {
  stop()
  link.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
