/**
 * cfService.js
 *
 * Submit a Codeforces via VJudge (My Account mode).
 * Flujo:
 *   1. loginVJ(vjUser, vjPass)  →  obtiene JSESSIONID de VJudge via axios puro
 *   2. submitVJ(...)            →  POST /problem/submit/CodeForces-{id} con la sesión
 *   3. getSubmissionStatus(id)  →  GET /solution/data/{runId}  (polling)
 *
 * Sin Playwright, sin Chrome, sin dependencias de browser.
 */

import axios from "axios"
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs"
import { fileURLToPath } from "url"
import path from "path"
import crypto from "crypto"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SESSIONS_DIR = path.join(__dirname, "../sessions")

if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true })

// ---------------------------------------------------------------------------
// Session encryption (misma lógica que antes)
// ---------------------------------------------------------------------------

const KEY = crypto.scryptSync(
  process.env.SESSION_SECRET || "cf-club-secret-2024", "cf-salt", 32
)

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

function sessionPath(handle) {
  return path.join(SESSIONS_DIR, `${handle.toLowerCase()}.json`)
}

function saveSession(handle, cookies) {
  const payload = { cookies, savedAt: Date.now() }
  writeFileSync(sessionPath(handle), encrypt(JSON.stringify(payload)), "utf8")
  console.log(`[VJ] Session saved for ${handle} (${cookies.length} cookies).`)
}

function loadSession(handle) {
  const p = sessionPath(handle)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(decrypt(readFileSync(p, "utf8"))).cookies
  } catch (err) {
    console.warn(`[VJ] Could not read session for ${handle}:`, err.message)
    return null
  }
}

export function hasSession(handle) { return existsSync(sessionPath(handle)) }

export function clearSession(handle) {
  const p = sessionPath(handle)
  if (existsSync(p)) { unlinkSync(p); return true }
  return false
}

// ---------------------------------------------------------------------------
// Helpers de cookies
// ---------------------------------------------------------------------------

/**
 * Convierte el array de cookies guardado en un string para el header Cookie.
 * Formato esperado: [{ name, value }, ...]
 */
function cookieHeader(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join("; ")
}

/**
 * Parsea las cabeceras Set-Cookie de una respuesta axios y devuelve
 * un array de objetos { name, value }.
 */
function parseSetCookies(headers) {
  const raw = headers["set-cookie"] || []
  return raw.map(line => {
    const [pair] = line.split(";")
    const eq = pair.indexOf("=")
    if (eq === -1) return null
    return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() }
  }).filter(Boolean)
}

// ---------------------------------------------------------------------------
// loginVJ — axios puro, sin browser
// ---------------------------------------------------------------------------

export async function loginCF(vjHandle, vjPassword) {
  console.log(`[VJ] Logging in as ${vjHandle}...`)

  // Paso 1: GET a la home para obtener la cookie de sesión inicial (JSESSIONID vacío)
  const initRes = await axios.get("https://vjudge.net/user/login", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    maxRedirects: 5,
    timeout: 15000,
  })

  const initCookies = parseSetCookies(initRes.headers)
  const initCookieHeader = cookieHeader(initCookies)

  // Paso 2: POST de credenciales
  const params = new URLSearchParams()
  params.append("username", vjHandle)
  params.append("password", vjPassword)

  const loginRes = await axios.post("https://vjudge.net/user/login", params.toString(), {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": "https://vjudge.net/",
      "Origin": "https://vjudge.net",
      "Cookie": initCookieHeader,
    },
    maxRedirects: 0,
    validateStatus: s => s < 500,
    timeout: 15000,
  })

  // VJudge devuelve "success" en el body si el login fue exitoso
  const body = loginRes.data
  if (typeof body === "string" && body.toLowerCase().includes("success")) {
    // OK
  } else if (typeof body === "object" && body.error) {
    throw new Error(`VJudge login failed: ${body.error}`)
  } else if (typeof body === "string" && (body.toLowerCase().includes("err") || body.toLowerCase().includes("invalid"))) {
    throw new Error(`VJudge login failed: ${body}`)
  }

  // Combinar cookies iniciales + las nuevas del login
  const loginCookies = parseSetCookies(loginRes.headers)
  const merged = mergeCookies(initCookies, loginCookies)

  if (!merged.length) throw new Error("No cookies obtained after VJudge login")

  // Verificar que realmente obtuvimos un JSESSIONID válido
  const jsession = merged.find(c => c.name === "JSESSIONID")
  if (!jsession) throw new Error("No JSESSIONID in VJudge response — login may have failed")

  saveSession(vjHandle, merged)
  console.log(`[VJ] Login OK for ${vjHandle}. Cookies: ${merged.map(c => c.name).join(", ")}`)
  return { success: true, cookieCount: merged.length }
}

/** Merge: las cookies nuevas sobreescriben las viejas del mismo nombre */
function mergeCookies(base, updates) {
  const map = new Map(base.map(c => [c.name, c.value]))
  updates.forEach(c => map.set(c.name, c.value))
  return Array.from(map.entries()).map(([name, value]) => ({ name, value }))
}

// ---------------------------------------------------------------------------
// submitVJ — POST /problem/submit/CodeForces-{contestId}{index}
// ---------------------------------------------------------------------------

// Mapa de languageId de CF → languageId de VJudge para Codeforces
// Fuente: menú de lenguajes de VJudge en /problem/CodeForces-*
const VJ_LANGUAGE_MAP = {
  54:  54,   // GNU C++17 7.3.0
  74:  80,   // GNU C++20
  71:  70,   // Python 3
  73:  72,   // PyPy 3
  60:  60,   // Java 11
  65:  65,   // GNU C++17 (64)
}

export async function submitCF(contestId, index, code, languageId, handle) {
  const cookies = loadSession(handle)
  if (!cookies) throw new Error(`No VJudge session for ${handle}. Please log in first.`)

  const problemCode = `CodeForces-${contestId}${index}`
  const vjLang = VJ_LANGUAGE_MAP[Number(languageId)] ?? languageId

  console.log(`[VJ] Submitting ${problemCode} for ${handle}, lang=${vjLang}...`)

  const params = new URLSearchParams()
  params.append("method", "0")          // 0 = My Account
  params.append("language", String(vjLang))
  params.append("open", "1")
  params.append("source", code)

  const res = await axios.post(
    `https://vjudge.net/problem/submit/${problemCode}`,
    params.toString(),
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": `https://vjudge.net/problem/${problemCode}`,
        "Origin": "https://vjudge.net",
        "Accept": "*/*",
        "Cookie": cookieHeader(cookies),
      },
      validateStatus: s => s < 500,
      timeout: 20000,
    }
  )

  if (res.status === 401 || res.status === 403) {
    clearSession(handle)
    throw new Error(`VJudge session for ${handle} expired. Please log in again.`)
  }

  const data = res.data

  // Respuesta esperada: { "runId": 12345678 }
  if (data && data.runId) {
    console.log(`[VJ] Submit OK. runId: ${data.runId}`)
    return { submissionId: String(data.runId) }
  }

  // Si VJudge devuelve un error en texto
  if (typeof data === "string" || data?.error) {
    const msg = data?.error || data
    if (msg.toString().toLowerCase().includes("login")) {
      clearSession(handle)
      throw new Error(`VJudge session expired. Please log in again.`)
    }
    throw new Error(`VJudge submit error: ${msg}`)
  }

  throw new Error(`Unexpected VJudge response: ${JSON.stringify(data)}`)
}

// ---------------------------------------------------------------------------
// getSubmissionStatus — GET /solution/data/{runId}
// ---------------------------------------------------------------------------

export async function getSubmissionStatus(submissionId) {
  const res = await axios.get(
    `https://vjudge.net/solution/data/${submissionId}`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Referer": "https://vjudge.net/",
      },
      timeout: 10000,
      validateStatus: s => s < 500,
    }
  )

  if (res.status === 404) {
    return { id: submissionId, verdict: "PENDING", verdictText: "Waiting for judge...", judging: true }
  }

  const d = res.data

  // VJudge devuelve un objeto con campos: statusType, statusCanonical, time, memory, language, etc.
  // statusType: 0=Pending, 1=Judging, 2=Accepted, 4=WrongAnswer, etc.
  // Usamos statusCanonical que es el string legible

  const statusCanonical = d.statusCanonical || d.status || ""
  const statusType      = d.statusType ?? -1

  const judging = statusType === 0 || statusType === 1 ||
                  statusCanonical === "Pending" || statusCanonical === "Judging"

  const verdictMap = {
    "Accepted":             { verdict: "OK",                     text: "Accepted",              color: "green" },
    "Wrong Answer":         { verdict: "WRONG_ANSWER",           text: "Wrong Answer",          color: "red"   },
    "Time Limit Exceeded":  { verdict: "TIME_LIMIT_EXCEEDED",    text: "Time Limit Exceeded",   color: "red"   },
    "Memory Limit Exceeded":{ verdict: "MEMORY_LIMIT_EXCEEDED",  text: "Memory Limit Exceeded", color: "red"   },
    "Runtime Error":        { verdict: "RUNTIME_ERROR",          text: "Runtime Error",         color: "red"   },
    "Compilation Error":    { verdict: "COMPILATION_ERROR",      text: "Compilation Error",     color: "red"   },
    "Pending":              { verdict: "PENDING",                text: "Pending...",            color: "amber" },
    "Judging":              { verdict: "TESTING",                text: "Judging...",            color: "amber" },
    "Challenge Encountered":{ verdict: "CHALLENGE",              text: "Challenge Encountered", color: "amber" },
  }

  const mapped = verdictMap[statusCanonical] || { verdict: statusCanonical, text: statusCanonical || "Pending...", color: "amber" }

  return {
    id:          submissionId,
    verdict:     mapped.verdict,
    verdictText: mapped.text,
    color:       mapped.color,
    judging,
    passedTests: d.passedTestCount ?? null,
    timeMs:      d.time   != null ? Number(d.time)                     : null,
    memoryKb:    d.memory != null ? Math.round(Number(d.memory) / 1024) : null,
    language:    d.language ?? null,
    // Para armar el link a CF necesitamos el problemId — VJudge lo incluye en run info
    problem:     d.problemId ?? null,
  }
}