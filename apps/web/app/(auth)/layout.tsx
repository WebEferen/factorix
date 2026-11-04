import type { ReactNode } from 'react'

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-md bg-signal text-sm font-bold text-white">F</span>
          <span className="text-lg font-semibold">Factorix</span>
        </div>
        {children}
      </div>
    </div>
  )
}
