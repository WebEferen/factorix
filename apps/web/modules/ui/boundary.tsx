'use client'

import { TriangleAlert } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from './index'

interface BoundaryProps {
  /** Finishes the sentence "Could not show ...". */
  label: string
  children: ReactNode
  fallback?: ReactNode
  /** Clears the error when this changes, such as on navigating to another page. */
  resetKey?: unknown
}

/** Keeps a crash in one part of a page from taking the rest of the app with it. */
export class Boundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Could not show ${this.props.label}`, error, info.componentStack)
  }

  override componentDidUpdate(previous: BoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false })
  }

  override render() {
    if (!this.state.failed) return this.props.children
    return (
      this.props.fallback ?? (
        <div role="alert" className="m-2 flex items-center gap-2 rounded-md border border-divider px-3 py-2 text-sm text-ink-2">
          <TriangleAlert className="size-4 shrink-0 text-danger-ink" />
          <span className="min-w-0 flex-1">Could not show {this.props.label}.</span>
          <Button size="sm" variant="ghost" onClick={() => this.setState({ failed: false })}>
            Try again
          </Button>
        </div>
      )
    )
  }
}
