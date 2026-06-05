/// <reference types="vite/client" />

/** Injected in vite.config (merges DATABASE_URL + VITE_DATABASE_URL at build time). */
declare const __ROOFIQ_DATABASE_URL__: string
/** Injected in vite.config (merges GOOGLE_MAPS_API_KEY aliases into the client bundle). */
declare const __ROOFIQ_MAPS_API_KEY__: string
/** Injected in vite.config (merges GEMINI_API_KEY and other aliases into the client bundle). */
declare const __ROOFIQ_GEMINI_API_KEY__: string
/** True when OPENAI_API_KEY (or alias) was present at build time — vision routes OpenAI first. */
declare const __ROOFIQ_OPENAI_CONFIGURED__: string | boolean

interface ImportMetaEnv {
  readonly VITE_GOOGLE_MAPS_API_KEY?: string
  readonly VITE_GOOGLE_AI_KEY?: string
  readonly VITE_DATABASE_URL?: string
  /** `LOW` | `MEDIUM` | `HIGH` — passed to Solar `requiredQuality`. */
  readonly VITE_SOLAR_REQUIRED_QUALITY?: string
  /** When `"true"`, shows an experimental “one outline” button from Solar `boundingBox`. */
  readonly VITE_EXPERIMENTAL_SOLAR_OUTLINE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
