import { DockerSandboxProvider, serveSandbox } from '@factorix/sandbox'
import { connectRunner } from './link'
import { createGrantStore } from './store'

const need = (name: string): string => {
  const value = process.env[name]
  if (!value) {
    console.error(`[runner] ${name} is not set`)
    process.exit(1)
  }
  return value
}

const log = (message: string) => console.error(`[runner] ${message}`)
const stack = process.env.FACTORIX_STACK ?? 'factorix-runner'

const link = connectRunner({ url: need('FACTORIX_URL'), token: need('FACTORIX_RUNNER_TOKEN'), log })
const sandbox = new DockerSandboxProvider({
  image: process.env.FACTORIX_SANDBOX_IMAGE ?? 'factorix/sandbox-base:dev',
  stepNetwork: process.env.FACTORIX_STEP_NETWORK,
  agentNetwork: process.env.FACTORIX_AGENT_NETWORK,
  stack,
})
const stopServing = serveSandbox(sandbox, link, { stack, log })

// Without a secret there is no proxy to answer, which is the development setup: agents reach the network directly.
const storeSecret = process.env.FACTORIX_STORE_SECRET
const store = storeSecret ? createGrantStore({ link, secret: storeSecret }) : null
store?.listen(Number(process.env.STORE_PORT ?? 8090), '0.0.0.0', () => log('answering the egress proxy'))

log(`serving sandboxes for ${process.env.FACTORIX_URL} as stack ${stack}`)

// Containers keep running. The worker reattaches to them through the next runner process.
const shutdown = () => {
  stopServing()
  link.close()
  store?.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
