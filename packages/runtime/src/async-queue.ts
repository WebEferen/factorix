/** Unbounded single-consumer queue that bridges callbacks into an async iterable. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private waiter: ((result: IteratorResult<T>) => void) | null = null
  private closed = false

  get size(): number {
    return this.items.length
  }

  push(item: T): void {
    if (this.closed) return
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = null
      waiter({ value: item, done: false })
    } else {
      this.items.push(item)
    }
  }

  close(): void {
    this.closed = true
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = null
      waiter({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiter = resolve
        })
      },
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}
