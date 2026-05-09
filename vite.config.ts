import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const projectRoot = path.dirname(fileURLToPath(import.meta.url))

/** Parse .env / .env.local (Neon often uses DATABASE_URL; Vite only auto-exposes VITE_*). */
function parseEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    if (!fs.existsSync(filePath)) return out
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq === -1) continue
      const k = t.slice(0, eq).trim()
      let v = t.slice(eq + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1)
      out[k] = v
    }
  } catch {
    /* ignore */
  }
  return out
}

function loadDotEnvFiles(): Record<string, string> {
  const a = parseEnvFile(path.join(projectRoot, '.env'))
  const b = parseEnvFile(path.join(projectRoot, '.env.local'))
  return { ...a, ...b }
}

/** Connection string for Neon: accept VITE_DATABASE_URL or plain DATABASE_URL (shell or .env). */
function resolveDatabaseUrl(mode: string): string {
  const fromProcess =
    (process.env.VITE_DATABASE_URL || '').trim() ||
    (process.env.DATABASE_URL || '').trim()
  if (fromProcess) return fromProcess
  const fromVite = (loadEnv(mode, projectRoot).VITE_DATABASE_URL || '').trim()
  if (fromVite) return fromVite
  const file = loadDotEnvFiles()
  return (
    (file.VITE_DATABASE_URL || '').trim() ||
    (file.DATABASE_URL || '').trim()
  )
}

export default defineConfig(({ mode }) => {
  const viteEnv = loadEnv(mode, projectRoot)
  const resolvedDbUrl = resolveDatabaseUrl(mode)

  if (process.env.VERCEL) {
    const db = (
      resolvedDbUrl ||
      (viteEnv.VITE_DATABASE_URL || process.env.VITE_DATABASE_URL || process.env.DATABASE_URL || '').trim()
    ).trim()
    const maps = (viteEnv.VITE_GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY || '').trim()
    if (!db) {
      console.warn(
        '[roofiq] No database URL for this Vercel cloud build. Use `DATABASE_URL` or `VITE_DATABASE_URL` (shell / Vercel env), or deploy with `npm run deploy:vercel` from a machine that has `.env`.'
      )
    }
    if (!maps) {
      console.warn(
        '[roofiq] VITE_GOOGLE_MAPS_API_KEY missing on this Vercel cloud build. Use local `npm run deploy:vercel` or set the variable on Vercel, then redeploy.'
      )
    }
  }

  return {
    plugins: [react()],
    envDir: projectRoot,
    define: {
      // Client bundle cannot read DATABASE_URL from import.meta.env; merge both names at build time.
      __ROOFIQ_DATABASE_URL__: JSON.stringify(resolvedDbUrl),
    },
  }
})
