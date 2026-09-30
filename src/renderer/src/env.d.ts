import type { ChainPromptApi } from '../../shared/api'

declare global {
  interface Window {
    api: ChainPromptApi
  }
}
