'use client'

import { createContext, useContext } from 'react'

export interface ShellActions {
  openPalette(): void
  openNewIssue(projectId?: string): void
  openShortcuts(): void
  openNav(): void
}

export const ShellContext = createContext<ShellActions>({ openPalette() {}, openNewIssue() {}, openShortcuts() {}, openNav() {} })

export const useShell = () => useContext(ShellContext)
