'use client'

import { useSyncExternalStore } from 'react'

const DESKTOP = '(min-width: 768px)'

function subscribe(onChange: () => void) {
  const media = window.matchMedia(DESKTOP)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP).matches,
    () => true,
  )
}
