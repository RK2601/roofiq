/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_MAPS_API_KEY?: string
  readonly VITE_GOOGLE_AI_KEY?: string
  readonly VITE_DATABASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
