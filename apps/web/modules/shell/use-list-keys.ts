'use client'

import { useEffect, useState } from 'react'

export function useListKeys<T>(items: T[], open: (item: T) => void): { selected: number; setSelected: (index: number) => void } {
  const [selected, setSelected] = useState(-1)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.closest('[role="dialog"],[role="menu"],[role="listbox"]')
      )
        return
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault()
        setSelected((index) => Math.min(index + 1, items.length - 1))
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault()
        setSelected((index) => Math.max(index - 1, 0))
      } else if (event.key === 'Enter' && selected >= 0 && items[selected]) {
        event.preventDefault()
        open(items[selected])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, open, selected])
  return { selected, setSelected }
}
