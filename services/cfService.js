import axios from "axios"
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs"
import { fileURLToPath } from "url"
import path from "path"
import crypto from "crypto"
import config from "../config/config.js"

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

function saveSession(handle, cookies) {
  writeFileSync(sessionPath(handle), encrypt(JSON.stringify({ cookies, savedAt: Date.now() })), "utf8")
  console.log(`[VJ] Session saved for ${handle} (${cookies.length} cookies).`)
}

function loadSession(handle) {
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

function cookieHeader(cookies) { return cookies.map(c => `${c.name}=${c.value}`).join("; ") }

function parseSetCookies(headers) {
  return (headers["set-cookie"] || []).map(line => {
    const [pair] = line.split(";")
    const eq = pair.indexOf("=")
    if (eq === -1) return null
    return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() }
  }).filter(Boolean)
}

function mergeCookies(base, updates) {
  const map = new Map(base.map(c => [c.name, c.value]))
  updates.forEach(c => map.set(c.name, c.value))
  return Array.from(map.entries()).map(([name, value]) => ({ name, value }))
}

const VJ_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36"

export async function loginCF(vjHandle, vjPassword) {
  console.log(`[VJ] Logging in as ${vjHandle}...`)

  const initRes = await axios.get("https://vjudge.net/", {
    headers: { "User-Agent": VJ_UA, "Accept": "text/html" },
    maxRedirects: 5, timeout: 15000,
  })
  const initCookies = parseSetCookies(initRes.headers)

  const params = new URLSearchParams()
  params.append("username", vjHandle)
  params.append("password", vjPassword)

  const loginRes = await axios.post("https://vjudge.net/user/login", params.toString(), {
    headers: {
      "User-Agent": VJ_UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": "https://vjudge.net/",
      "Origin": "https://vjudge.net",
      "Cookie": cookieHeader(initCookies),
    },
    maxRedirects: 0, validateStatus: s => s < 500, timeout: 15000,
  })

  const body = typeof loginRes.data === "string" ? loginRes.data : JSON.stringify(loginRes.data)
  console.log(`[VJ] Login response: "${body}"`)

  if (!body.toLowerCase().includes("success")) throw new Error("Invalid username or password.")

  const merged = mergeCookies(initCookies, parseSetCookies(loginRes.headers))

  const checkRes = await axios.get("https://vjudge.net/user/checkLogInStatus", {
    headers: { "User-Agent": VJ_UA, "X-Requested-With": "XMLHttpRequest", "Cookie": cookieHeader(merged) },
    validateStatus: s => s < 500, timeout: 10000,
  })

  const checkBody = checkRes.data
  console.log(`[VJ] checkLogInStatus:`, checkBody)

  if (!checkBody || checkBody === false || checkBody === "false" || checkBody === "") {
    throw new Error("Invalid username or password.")
  }

  saveSession(vjHandle, merged)
  console.log(`[VJ] Login verified for ${vjHandle}.`)
  return { success: true, cookieCount: merged.length }
}

const VJ_LANGUAGE_MAP = { 54: 54, 74: 80, 71: 70, 73: 72, 60: 60, 65: 65 }

export async function submitCF(contestId, index, code, languageId, handle) {
  const cookies = loadSession(handle)
  if (!cookies) throw new Error(`No VJudge session for ${handle}. Please log in first.`)

  const problemCode = `CodeForces-${contestId}${index}`
  const vjLang = VJ_LANGUAGE_MAP[Number(languageId)] ?? languageId
  const steps = []

  steps.push({ type: "info", text: `Submitting as ${handle}...` })
  const runId = await doSubmit(problemCode, vjLang, code, cookies, 0)

  steps.push({ type: "info", text: "Checking for rating restrictions..." })
  const challenge = await pollForChallenge(runId)

  if (!challenge) return { submissionId: String(runId), steps }

  steps.push({ type: "warn", text: `${handle} does not have Pupil rank — cannot submit directly.` })

  const clubCookies = await getClubSession()
  if (!clubCookies) {
    steps.push({ type: "error", text: "No shared club account configured. Contact your instructor." })
    return { submissionId: String(runId), challengeEncountered: true, steps }
  }

  steps.push({ type: "info", text: "Retrying with shared club account..." })
  const clubRunId = await doSubmit(problemCode, vjLang, code, clubCookies, 4)
  steps.push({ type: "ok", text: "Submitted via shared account successfully." })
  return { submissionId: String(clubRunId), usedClubAccount: true, steps }
}

async function doSubmit(problemCode, vjLang, code, cookies, method) {
  const params = new URLSearchParams()
  params.append("method", String(method))
  params.append("language", String(vjLang))
  params.append("open", "1")
  params.append("source", code)

  const res = await axios.post(`https://vjudge.net/problem/submit/${problemCode}`, params.toString(), {
    headers: {
      "User-Agent": VJ_UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": `https://vjudge.net/problem/${problemCode}`,
      "Origin": "https://vjudge.net",
      "Accept": "*/*",
      "Cookie": cookieHeader(cookies),
    },
    validateStatus: s => s < 500, timeout: 20000,
  })

  if (res.status === 401 || res.status === 403) throw new Error("VJudge session expired. Please log in again.")

  const data = res.data
  if (data?.runId) return data.runId

  const msg = data?.error || (typeof data === "string" ? data : JSON.stringify(data))
  if (String(msg).toLowerCase().includes("login")) throw new Error("VJudge session expired. Please log in again.")
  throw new Error(`VJudge submit error: ${msg}`)
}

async function pollForChallenge(runId) {
  for (let i = 0; i < 6; i++) {
    await sleep(2000)
    try {
      const res = await axios.get(`https://vjudge.net/solution/data/${runId}`, {
        headers: { "User-Agent": VJ_UA, "Accept": "application/json" },
        timeout: 8000, validateStatus: s => s < 500,
      })
      const statusCanonical = res.data?.statusCanonical || res.data?.status || ""
      console.log(`[VJ] pollForChallenge[${i+1}] runId=${runId} status="${statusCanonical}"`)
      if (statusCanonical === "Challenge Encountered") return true
      if (statusCanonical && statusCanonical !== "Pending" && statusCanonical !== "Judging") return false
    } catch (e) { console.warn(`[VJ] pollForChallenge error: ${e.message}`) }
  }
  return false
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function getClubSession() {
  const club = config.club
  if (!club?.vjHandle || !club?.vjPassword) return null
  const CLUB_HANDLE = club.vjHandle.toLowerCase()
  if (hasSession(CLUB_HANDLE)) {
    const cookies = loadSession(CLUB_HANDLE)
    if (cookies) return cookies
  }
  try {
    await loginCF(club.vjHandle, club.vjPassword)
    return loadSession(CLUB_HANDLE)
  } catch (err) {
    console.error(`[VJ] Club account login failed: ${err.message}`)
    return null
  }
}

export async function getSubmissionStatus(submissionId) {
  const res = await axios.get(`https://vjudge.net/solution/data/${submissionId}`, {
    headers: { "User-Agent": VJ_UA, "Accept": "application/json", "Referer": "https://vjudge.net/" },
    timeout: 10000, validateStatus: s => s < 500,
  })

  if (res.status === 404) return { id: submissionId, verdict: "PENDING", verdictText: "Waiting for judge...", judging: true }

  const d = res.data
  console.log(`[VJ] solution/data/${submissionId}:`, JSON.stringify(d))

  const statusCanonical = d?.statusCanonical ?? d?.status ?? ""
  const statusType      = d?.statusType ?? d?.type ?? -1
  const judging = new Set(["Pending", "Judging"]).has(statusCanonical) || (statusCanonical === "" && statusType <= 1)

  const verdictMap = {
    "Accepted":             { verdict: "OK",        text: "Accepted",              color: "green" },
    "Wrong Answer":         { verdict: "WA",         text: "Wrong Answer",          color: "red"   },
    "Time Limit Exceeded":  { verdict: "TLE",        text: "Time Limit Exceeded",   color: "red"   },
    "Memory Limit Exceeded":{ verdict: "MLE",        text: "Memory Limit Exceeded", color: "red"   },
    "Runtime Error":        { verdict: "RE",         text: "Runtime Error",         color: "red"   },
    "Compilation Error":    { verdict: "CE",         text: "Compilation Error",     color: "red"   },
    "Pending":              { verdict: "PENDING",    text: "Pending...",            color: "amber" },
    "Judging":              { verdict: "JUDGING",    text: "Judging...",            color: "amber" },
    "Challenge Encountered":{ verdict: "CHALLENGE",  text: "Challenge Encountered", color: "amber" },
    "SUBMIT_FAILED_TEMP":   { verdict: "FAILED",     text: "Submit failed (temp)",  color: "red"   },
  }

  const mapped = verdictMap[statusCanonical] || { verdict: statusCanonical || "UNKNOWN", text: statusCanonical || "Unknown status", color: "amber" }

  return {
    id: submissionId, verdict: mapped.verdict, verdictText: mapped.text,
    color: mapped.color, judging,
    passedTests: d?.passedTestCount ?? null,
    timeMs:   d?.time   != null ? Number(d.time)                      : null,
    memoryKb: d?.memory != null ? Math.round(Number(d.memory) / 1024) : null,
    language: d?.language ?? null,
    problem:  d?.problemId ?? null,
    _raw: d,
  }
}

export async function getContestProblems(contestId) {
  const res = await axios.get(`https://vjudge.net/contest/${contestId}`, {
    headers: {
      "User-Agent": VJ_UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    timeout: 15000, validateStatus: () => true,
  })

  console.log(`[VJ] contest/${contestId} status=${res.status}`)
  if (res.status === 404) throw new Error(`Contest ${contestId} not found on VJudge.`)
  if (res.status >= 400) throw new Error(`VJudge returned ${res.status} for contest ${contestId}.`)

  const html = typeof res.data === "string" ? res.data : ""
  if (!html) throw new Error("Empty response from VJudge.")

  const m = html.match(/<textarea[^>]*name="dataJson"[^>]*>([\s\S]*?)<\/textarea>/)
  if (!m) throw new Error(`Contest ${contestId} not found or is private.`)

  let data
  try { data = JSON.parse(m[1]) }
  catch (e) { throw new Error(`Failed to parse contest data: ${e.message}`) }

  if (!Array.isArray(data.problems) || !data.problems.length) {
    throw new Error(`No problems found in contest ${contestId}.`)
  }

  // VJudge no incluye el código de CF (e.g. "1234A") en el dataJson.
  // Lo resolvemos por título exacto contra la API pública de Codeforces.
  let cfLookup = {}
  if (data.problems.some(p => p.oj === "CodeForces")) {
    try {
      const cfRes = await axios.get("https://codeforces.com/api/problemset.problems", {
        timeout: 10000, validateStatus: s => s < 500,
      })
      if (cfRes.data?.status === "OK") {
        for (const p of cfRes.data.result.problems) {
          cfLookup[p.name] = { contestId: p.contestId, index: p.index }
        }
      }
    } catch (e) { console.warn("[VJ] Could not fetch CF problemset:", e.message) }
  }

  return {
    id:    contestId,
    title: data.title || `Contest ${contestId}`,
    problems: data.problems.map((p, i) => {
      const index = p.num || String.fromCharCode(65 + i)
      if (p.oj === "CodeForces") {
        const cf = cfLookup[p.title]
        if (cf) return {
          index, oj: "CodeForces",
          code:   `${cf.contestId}${cf.index}`,
          title:  p.title,
          vjCode: `CodeForces-${cf.contestId}${cf.index}`,
        }
      }
      return { index, oj: p.oj, code: null, title: p.title, vjCode: null }
    }),
  }
}