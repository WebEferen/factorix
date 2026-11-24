'use client'

import { useEffect, useState } from 'react'

const KEY = 'fx-single-key-shortcuts'
const CHANGED = 'fx-shortcuts-changed'
let remembered: boolean | null = null

/** Single-key shortcuts can clash with a screen reader or a browser extension, so a person can turn them off in this browser. */
function singleKeysOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return remembered ?? true
  }
}

export function setSingleKeys(on: boolean): void {
  remembered = on
  try {
    if (on) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, 'off')
  } catch {}
  window.dispatchEvent(new Event(CHANGED))
}

export function useSingleKeys(): boolean {
  const [on, setOn] = useState(true)
  useEffect(() => {
    const read = () => setOn(singleKeysOn())
    read()
    window.addEventListener(CHANGED, read)
    window.addEventListener('storage', read)
    return () => {
      window.removeEventListener(CHANGED, read)
      window.removeEventListener('storage', read)
    }
  }, [])
  return on
}
