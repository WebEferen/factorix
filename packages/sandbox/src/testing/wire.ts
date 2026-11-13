import type { FrameTransport, RunnerFrame } from '../remote'

/** Two ends of one wire. Frames cross as JSON on a later tick, as they would over a network. */
export function memoryWire(): { worker: FrameTransport; runner: FrameTransport; frames: RunnerFrame[] } {
  const frames: RunnerFrame[] = []
  const end = (mine: Set<(frame: RunnerFrame) => void>, theirs: Set<(frame: RunnerFrame) => void>): FrameTransport => ({
    send(frame) {
      frames.push(frame)
      const copy = JSON.parse(JSON.stringify(frame)) as RunnerFrame
      queueMicrotask(() => {
        for (const listener of theirs) listener(copy)
      })
    },
    onFrame(listener) {
      mine.add(listener)
      return () => mine.delete(listener)
    },
  })
  const workerListeners = new Set<(frame: RunnerFrame) => void>()
  const runnerListeners = new Set<(frame: RunnerFrame) => void>()
  return { worker: end(workerListeners, runnerListeners), runner: end(runnerListeners, workerListeners), frames }
}
