import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const projectRoot = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  const viteEnv = loadEnv(mode, projectRoot)

  if (process.env.VERCEL) {
    const db = (viteEnv.VITE_DATABASE_URL || process.env.VITE_DATABASE_URL || '').trim()
    const maps = (viteEnv.VITE_GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY || '').trim()
    if (!db) {
      console.warn(
        '[roofiq] VITE_DATABASE_URL missing on this Vercel cloud build. Either add it under Project → Environment Variables, or deploy from your laptop with `npm run deploy:vercel` so local `.env` is used at build time.'
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
  }
})
