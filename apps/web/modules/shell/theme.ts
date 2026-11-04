'use client'

import { useCallback, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

export const THEME_SCRIPT = `try{var t=localStorage.getItem('fx-theme');if(!t)t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t}catch(e){}`

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>('light')
  useEffect(() => {
    setTheme((document.documentElement.dataset.theme as Theme | undefined) ?? 'light')
  }, [])
  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark'
      document.documentElement.dataset.theme = next
      try {
        localStorage.setItem('fx-theme', next)
      } catch {}
      return next
    })
  }, [])
  return [theme, toggle]
}
