/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  readonly VITE_ALLOW_DEMO_WALLET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
