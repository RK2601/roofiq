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
        '[roofiq] VITE_DATABASE_URL is missing for this Vercel build. Add it in Vercel → Project → Settings → Environment Variables (Production + Preview), enable it for Builds, then redeploy.'
      )
    }
    if (!maps) {
      console.warn(
        '[roofiq] VITE_GOOGLE_MAPS_API_KEY is missing for this Vercel build. Maps will not work until it is set and you redeploy.'
      )
    }
  }

  return {
    plugins: [react()],
    envDir: projectRoot,
  }
})
