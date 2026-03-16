import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs"
import { fileURLToPath } from "url"
import path from "path"
import crypto from "crypto"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SESSIONS_DIR = path.join(__dirname, "../sessions")

if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true })

const KEY = crypto.scryptSync(process.env.SESSION_SECRET || "cf-club-secret-2024", "cf-salt", 32)

function encrypt(text) {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv("aes-256-cbc", KEY, iv)
  return iv.toString("hex") + ":" + Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("hex")
}

function decrypt(text) {
  const [ivHex, encHex] = text.split(":")
  const decipher = crypto.createDecipheriv("aes-256-cbc", KEY, Buffer.from(ivHex, "hex"))
  return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]).toString("utf8")
}

function sessionPath(handle) { return path.join(SESSIONS_DIR, `${handle.toLowerCase()}.json`) }

export function saveSession(handle, cookies) {
  writeFileSync(sessionPath(handle), encrypt(JSON.stringify({ cookies, savedAt: Date.now() })), "utf8")
  console.log(`[VJ] Session saved for ${handle} (${cookies.length} cookies).`)
}

export function loadSession(handle) {
  const p = sessionPath(handle)
  if (!existsSync(p)) return null
  try { return JSON.parse(decrypt(readFileSync(p, "utf8"))).cookies }
  catch (err) { console.warn(`[VJ] Could not read session for ${handle}:`, err.message); return null }
}

export function hasSession(handle) { return existsSync(sessionPath(handle)) }

export function clearSession(handle) {
  const p = sessionPath(handle)
  if (existsSync(p)) { unlinkSync(p); return true }
  return false
}

export function cookieHeader(cookies) { return cookies.map(c => `${c.name}=${c.value}`).join("; ") }

export function parseSetCookies(headers) {
  return (headers["set-cookie"] || []).map(line => {
    const [pair] = line.split(";")
    const eq = pair.indexOf("=")
    if (eq === -1) return null
    return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() }
  }).filter(Boolean)
}

export function mergeCookies(base, updates) {
  const map = new Map(base.map(c => [c.name, c.value]))
  updates.forEach(c => map.set(c.name, c.value))
  return Array.from(map.entries()).map(([name, value]) => ({ name, value }))
}

export const VJ_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36"