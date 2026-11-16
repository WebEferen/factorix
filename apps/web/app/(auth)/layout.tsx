import type { ReactNode } from 'react'
import { Showcase } from '@/modules/auth/showcase'

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-canvas lg:grid-cols-3">
      <div className="flex items-center justify-center px-6 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-md bg-signal text-sm font-bold text-white">F</span>
            <span className="text-lg font-semibold">Factorix</span>
          </div>
          {children}
        </div>
      </div>
      <div className="hidden border-l border-divider bg-softer lg:col-span-2 lg:flex">
        <Showcase />
      </div>
    </div>
  )
}
