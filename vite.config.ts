import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
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

/** Gemini / Google AI Studio keys use several names; only VITE_GOOGLE_AI_KEY is auto-exposed by Vite. */
function resolveGeminiKey(mode: string): string {
  const fromProcess =
    (process.env.VITE_GOOGLE_AI_KEY || '').trim() ||
    (process.env.GEMINI_API_KEY || '').trim() ||
    (process.env.GOOGLE_GENERATIVE_AI_API_KEY || '').trim()
  if (fromProcess) return fromProcess
  const fromVite = (loadEnv(mode, projectRoot).VITE_GOOGLE_AI_KEY || '').trim()
  if (fromVite) return fromVite
  const file = loadDotEnvFiles()
  return (
    (file.VITE_GOOGLE_AI_KEY || '').trim() ||
    (file.GEMINI_API_KEY || '').trim() ||
    (file.GOOGLE_GENERATIVE_AI_API_KEY || '').trim()
  )
}

const STATIC_MAP_URL_RE = /^https:\/\/maps\.googleapis\.com\/maps\/api\/staticmap\?/
const SOLAR_URL_RE = /^https:\/\/solar\.googleapis\.com\//

/** Dev-only: same-origin proxy so `fetch(staticMapUrl)` works (Google often omits browser CORS on Static Maps). */
function staticMapProxyDevPlugin(): Plugin {
  return {
    name: 'roofiq-proxy-static-map',
    configureServer(server) {
      server.middlewares.use('/api/proxy-static-map', async (req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          return res.end()
        }
        if (req.method !== 'GET') return next()
        try {
          const host = req.headers.host || 'localhost'
          const target = new URL(req.url || '', `http://${host}`).searchParams.get('u')
          if (!target || !STATIC_MAP_URL_RE.test(target)) {
            res.statusCode = 400
            return res.end('bad request')
          }
          const upstream = await fetch(target)
          res.statusCode = upstream.status
          res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/png')
          const buf = Buffer.from(await upstream.arrayBuffer())
          return res.end(buf)
        } catch {
          res.statusCode = 502
          return res.end('proxy error')
        }
      })
    },
  }
}

/** Dev-only: proxy for Google Solar API (handles CORS in local dev). */
function solarProxyDevPlugin(): Plugin {
  return {
    name: 'roofiq-proxy-solar',
    configureServer(server) {
      server.middlewares.use('/api/proxy-solar', async (req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          return res.end()
        }
        if (req.method !== 'GET') return next()
        try {
          const host = req.headers.host || 'localhost'
          const target = new URL(req.url || '', `http://${host}`).searchParams.get('u')
          if (!target || !SOLAR_URL_RE.test(target)) {
            res.statusCode = 400
            return res.end('bad request')
          }
          const upstream = await fetch(target)
          res.statusCode = upstream.status
          res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json')
          const buf = Buffer.from(await upstream.arrayBuffer())
          return res.end(buf)
        } catch {
          res.statusCode = 502
          return res.end('proxy error')
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const viteEnv = loadEnv(mode, projectRoot)
  const resolvedDbUrl = resolveDatabaseUrl(mode)
  const resolvedGeminiKey = resolveGeminiKey(mode)

  if (process.env.VERCEL) {
    const db = (
      resolvedDbUrl ||
      (viteEnv.VITE_DATABASE_URL || process.env.VITE_DATABASE_URL || process.env.DATABASE_URL || '').trim()
    ).trim()
    const maps = (viteEnv.VITE_GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY || '').trim()
    const gemini = resolvedGeminiKey.trim()
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
    if (!gemini) {
      console.warn(
        '[roofiq] No Gemini API key for this build. Set `VITE_GOOGLE_AI_KEY` or `GEMINI_API_KEY` in Vercel (or local .env), then redeploy.'
      )
    }
  }

  return {
    plugins: [react(), staticMapProxyDevPlugin(), solarProxyDevPlugin()],
    envDir: projectRoot,
    define: {
      __ROOFIQ_DATABASE_URL__: JSON.stringify(resolvedDbUrl),
      __ROOFIQ_GEMINI_API_KEY__: JSON.stringify(resolvedGeminiKey),
    },
  }
})
