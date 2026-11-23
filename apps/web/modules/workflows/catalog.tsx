'use client'

import type { BlockCatalog } from '@factorix/schemas'
import { createContext, useContext } from 'react'

/** The blocks the organization's plugins add. Everything that reads a block's spec in the editor reads it through this. */
const BlockCatalogContext = createContext<BlockCatalog>({})

export const BlockCatalogProvider = BlockCatalogContext.Provider

export function useBlockCatalog(): BlockCatalog {
  return useContext(BlockCatalogContext)
}
