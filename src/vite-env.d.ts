/// <reference types="vite/client" />

/** Injected in vite.config (merges DATABASE_URL + VITE_DATABASE_URL at build time). */
declare const __ROOFIQ_DATABASE_URL__: string
/** Injected in vite.config (merges GEMINI_API_KEY and other aliases into the client bundle). */
declare const __ROOFIQ_GEMINI_API_KEY__: string

interface ImportMetaEnv {
  readonly VITE_GOOGLE_MAPS_API_KEY?: string
  readonly VITE_GOOGLE_AI_KEY?: string
  readonly VITE_DATABASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
