import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import type { Plugin } from 'vite'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { runOpenAiProxy } from './api/openaiProxyCore'

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

/** OpenAI key for server-side proxy only (never VITE_* — do not embed in the client bundle). */
function resolveOpenAiKey(mode: string): string {
  const fromProcess =
    (process.env.OPENAI_API_KEY || '').trim() ||
    (process.env.OPENAI_KEY || '').trim()
  if (fromProcess) return fromProcess
  const envAll = loadEnv(mode, projectRoot, '')
  const fromViteLoad =
    (envAll.OPENAI_API_KEY || '').trim() ||
    (envAll.OPENAI_KEY || '').trim()
  if (fromViteLoad) return fromViteLoad
  const file = loadDotEnvFiles()
  return (
    (file.OPENAI_API_KEY || '').trim() ||
    (file.OPENAI_KEY || '').trim() ||
    (file.VITE_OPENAI_API_KEY || '').trim()
  )
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

const STATIC_MAP_URL_RE = /^https:\/\/maps\.googleapis\.com\/maps\/api\/(staticmap|streetview)\?/
const SOLAR_URL_RE = /^https:\/\/(solar|storage)\.googleapis\.com\//

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

/** Dev: same-origin proxy for Replicate API so AI Depth Analysis works with `npm run dev` + `.env`. */
function replicateProxyDevPlugin(): Plugin {
  return {
    name: 'roofiq-proxy-replicate',
    configureServer(server) {
      server.middlewares.use('/api/proxy-replicate', async (req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          return res.end()
        }
        if (req.method !== 'GET' && req.method !== 'POST') return next()

        const file = loadDotEnvFiles()
        const apiKey = (
          (process.env.REPLICATE_API_TOKEN || '').trim() ||
          (file.REPLICATE_API_TOKEN || '').trim()
        )
        if (!apiKey) {
          res.statusCode = 503
          return res.end('REPLICATE_API_TOKEN not configured in environment')
        }

        try {
          const host = req.headers.host || 'localhost'
          const pathParam = new URL(req.url || '', `http://${host}`).searchParams.get('path') || ''
          const upstreamUrl = `https://api.replicate.com/v1/${pathParam.replace(/^\//, '')}`

          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('error', () => { res.statusCode = 400; res.end('bad request') })
          req.on('end', async () => {
            try {
              const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
              const upstream = await fetch(upstreamUrl, {
                method: req.method,
                headers: {
                  'Authorization': `Token ${apiKey}`,
                  'Content-Type': 'application/json',
                },
                body: body && body.length > 0 ? body : undefined,
              })
              res.statusCode = upstream.status
              res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json')
              const buf = Buffer.from(await upstream.arrayBuffer())
              return res.end(buf)
            } catch {
              res.statusCode = 502
              return res.end('upstream fetch failed')
            }
          })
        } catch {
          res.statusCode = 502
          return res.end('proxy error')
        }
      })
    },
  }
}

/** Dev: GET `/api/ai-health` — same as Vercel function for OpenAI/Gemini config probe. */
function aiHealthDevPlugin(mode: string): Plugin {
  return {
    name: 'roofiq-ai-health',
    configureServer(server) {
      server.middlewares.use('/api/ai-health', (req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          return res.end()
        }
        if (req.method !== 'GET') return next()
        const openai = !!resolveOpenAiKey(mode)
        const gemini = !!resolveGeminiKey(mode)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ openai, gemini, preferOpenAi: openai }))
      })
    },
  }
}

/** Dev: same-origin POST `/api/proxy-openai` so Gemini fallback works with `npm run dev` + `.env`. */
function openaiProxyDevPlugin(mode: string): Plugin {
  return {
    name: 'roofiq-proxy-openai',
    configureServer(server) {
      server.middlewares.use('/api/proxy-openai', async (req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          return res.end()
        }
        if (req.method !== 'POST') return next()

        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('error', () => {
          res.statusCode = 400
          res.end('bad request')
        })
        req.on('end', async () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8')
            const body = raw ? (JSON.parse(raw) as unknown) : {}
            const key = resolveOpenAiKey(mode)
            const out = await runOpenAiProxy(key, body)
            res.statusCode = out.status
            res.setHeader('Content-Type', out.contentType)
            return res.end(out.body)
          } catch {
            res.statusCode = 502
            res.setHeader('Content-Type', 'application/json')
            return res.end(JSON.stringify({ error: 'proxy error' }))
          }
        })
      })
    },
  }
}

/** Dev: proxy /api/roof-net → Python child process (Shapely). */
function roofNetDevPlugin(): Plugin {
  return {
    name: 'roofiq-roof-net',
    configureServer(server) {
      server.middlewares.use('/api/roof-net', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')
        if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end() }
        if (req.method !== 'POST') { res.statusCode = 405; return res.end('{}') }

        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          const scriptPath = path.join(projectRoot, 'api', 'roof_net_dev.py')
          const py = spawn('python3', [scriptPath])
          let out = '', err = ''
          py.stdout.on('data', (d: Buffer) => { out += d.toString() })
          py.stderr.on('data', (d: Buffer) => { err += d.toString() })
          py.on('close', (code) => {
            if (code === 0 && out) {
              res.statusCode = 200
              res.end(out)
            } else {
              res.statusCode = 500
              res.end(JSON.stringify({ sharedEdges: [], error: err || 'python exited ' + code }))
            }
          })
          py.stdin.write(Buffer.concat(chunks))
          py.stdin.end()
        })
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const viteEnv = loadEnv(mode, projectRoot)
  const resolvedDbUrl = resolveDatabaseUrl(mode)
  const resolvedGeminiKey = resolveGeminiKey(mode)
  const resolvedOpenAiKey = resolveOpenAiKey(mode)

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
    if (!resolvedOpenAiKey) {
      console.warn(
        '[roofiq] No OpenAI API key for server proxy. Set `OPENAI_API_KEY` (not only VITE_OPENAI_API_KEY) on Vercel, then redeploy.'
      )
    }
  }

  return {
    plugins: [react(), staticMapProxyDevPlugin(), solarProxyDevPlugin(), aiHealthDevPlugin(mode), openaiProxyDevPlugin(mode), replicateProxyDevPlugin(), roofNetDevPlugin()],
    envDir: projectRoot,
    define: {
      __ROOFIQ_DATABASE_URL__: JSON.stringify(resolvedDbUrl),
      __ROOFIQ_GEMINI_API_KEY__: JSON.stringify(resolvedGeminiKey),
      __ROOFIQ_OPENAI_CONFIGURED__: JSON.stringify(!!resolvedOpenAiKey),
    },
  }
})
