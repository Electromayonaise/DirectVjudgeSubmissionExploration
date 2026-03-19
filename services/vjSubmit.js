import axios from "axios"
import config from "../config/config.js"
import { loadSession, hasSession, cookieHeader, VJ_UA } from "./vjSession.js"
import { loginVJudge, verifyCFAccount } from "./vjAuth.js"

// ── Language map: CF language IDs → VJudge language IDs ──────────────────────
const VJ_LANGUAGE_MAP = { 54: 54, 74: 80, 71: 70, 73: 72, 60: 60, 65: 65 }

// ── Error marker so the frontend knows to trigger the cookie fallback UI ──────
export class BotAccountError extends Error {
  constructor(message) {
    super(message)
    this.name = "BotAccountError"
    this.requiresCookieAuth = true
  }
}

/**
 * Primary submit path.
 * - Contest submit (vjContestId + vjIndex present): uses method=1 (user's linked CF account on VJudge).
 *   VJudge requires method=1 for contest endpoints — the bot account (method=0) is rejected there.
 * - Global problem submit: uses method=0 (VJudge bot account), with rating-challenge fallback.
 */
export async function submitCF(contestId, index, code, languageId, handle, vjContestId, vjIndex) {
  const cookies = loadSession(handle)
  if (!cookies) throw new Error(`No VJudge session for ${handle}. Please log in first.`)

  const problemCode = `CodeForces-${contestId}${index}`
  const vjLang = VJ_LANGUAGE_MAP[Number(languageId)] ?? languageId
  const steps = []

  console.log("[VJ] submitCF problemCode:", problemCode, vjContestId ? `(contest ${vjContestId}/${vjIndex})` : "(global)")
  steps.push({ type: "info", text: `Submitting as ${handle}...` })

  // ── Contest path: VJudge requires method=1 for contest endpoints ──────────
  if (vjContestId && vjIndex) {
    const runId = await doSubmit(problemCode, vjLang, code, cookies, 1, vjContestId, vjIndex)
    steps.push({ type: "ok", text: "Submitted to contest successfully." })
    return { submissionId: String(runId), steps }
  }

  // ── Global problem path: bot account (method=0) + challenge check ─────────
  const runId = await doSubmit(problemCode, vjLang, code, cookies, 0, null, null)

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
  const clubRunId = await doSubmit(problemCode, vjLang, code, clubCookies, 4, null, null)
  steps.push({ type: "ok", text: "Submitted via shared account successfully." })
  return { submissionId: String(clubRunId), usedClubAccount: true, steps }
}

/**
 * Fallback submit path: verifies user's CF cookie via VJudge, then submits with method=1.
 * This bypasses the bot account restriction.
 *
 * @param {string} cfJsessionId - The JSESSIONID cookie value from the user's CF session
 */
export async function submitCFWithCookie(contestId, index, code, languageId, handle, cfJsessionId, vjContestId, vjIndex) {
  const cookies = loadSession(handle)
  if (!cookies) throw new Error(`No VJudge session for ${handle}. Please log in first.`)

  const problemCode = `CodeForces-${contestId}${index}`
  const vjLang = VJ_LANGUAGE_MAP[Number(languageId)] ?? languageId
  const steps = []

  steps.push({ type: "info", text: "Verifying your Codeforces account via VJudge..." })

  const { cfHandle } = await verifyCFAccount(cookies, cfJsessionId)
  steps.push({ type: "ok", text: `CF account verified: ${cfHandle}` })

  steps.push({ type: "info", text: "Submitting with your CF credentials..." })

  // method=1 tells VJudge to use the user's linked CF account (not the bot)
  const runId = await doSubmit(problemCode, vjLang, code, cookies, 1, vjContestId, vjIndex)
  steps.push({ type: "ok", text: "Submitted successfully via your CF account." })

  return { submissionId: String(runId), steps }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function doSubmit(problemCode, vjLang, code, cookies, method, vjContestId, vjIndex) {
  const params = new URLSearchParams()
  params.append("language", String(vjLang))
  params.append("open", "1")
  params.append("source", code)
  params.append("method", String(method))

  let url, referer
  if (vjContestId && vjIndex) {
    url     = `https://vjudge.net/contest/submit/${vjContestId}/${vjIndex}`
    referer = `https://vjudge.net/contest/${vjContestId}`
    params.append("password", "")
    params.append("version", "3b4")
  } else {
    url     = `https://vjudge.net/problem/submit/${problemCode}`
    referer = `https://vjudge.net/problem/${problemCode}`
  }

  const res = await axios.post(url, params.toString(), {
    headers: {
      "User-Agent": VJ_UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": referer,
      "Origin": "https://vjudge.net",
      "Accept": "*/*",
      "Cookie": cookieHeader(cookies),
    },
    validateStatus: () => true,
    timeout: 20000,
  })

  console.log(`[VJ] doSubmit ${url} → status=${res.status}`)

  if (res.status === 401 || res.status === 403) {
    throw new Error("VJudge session expired. Please log in again.")
  }

  const data = res.data

  if (typeof data === "string" && data.includes("<!DOCTYPE")) {
    // For contest submits, never fall back silently to the global problem endpoint.
    // If the contest endpoint returns HTML it means the session is broken or the
    // contest/index is wrong — surface that as an actionable error.
    if (vjContestId && vjIndex) {
      throw new Error(`VJudge returned an error page for contest submit (${vjContestId}/${vjIndex}). Check your session.`)
    }
    throw new Error("VJudge returned an error page. Check your session or problem ID.")
  }

  if (data?.runId) return data.runId

  const msg = data?.error || (typeof data === "string" ? data : JSON.stringify(data))
  const msgStr = String(msg)

  if (msgStr.toLowerCase().includes("login")) throw new Error("VJudge session expired. Please log in again.")

  // Detect bot account rejection → signal frontend to ask for cookie
  if (
    msgStr.toLowerCase().includes("bot account") ||
    msgStr.toLowerCase().includes("doesn't support submitting") ||
    msgStr.toLowerCase().includes("no verified remote account")
  ) {
    throw new BotAccountError(`VJudge bot account not available for this OJ: ${msgStr}`)
  }

  throw new Error(`VJudge submit error: ${msgStr}`)
}

async function pollForChallenge(runId) {
  const ATTEMPTS = 6
  const DELAY_MS = 1500

  for (let i = 0; i < ATTEMPTS; i++) {
    await sleep(DELAY_MS)
    try {
      const res = await axios.get(`https://vjudge.net/solution/data/${runId}`, {
        headers: { "User-Agent": VJ_UA, "Accept": "application/json" },
        timeout: 8000, validateStatus: s => s < 500,
      })
      const d = res.data
      const statusCanonical = d?.statusCanonical || d?.status || ""
      const processing      = d?.processing === true
      console.log(`[VJ] pollForChallenge[${i+1}] runId=${runId} status="${statusCanonical}" processing=${processing}`)
      if (statusCanonical === "Challenge Encountered") return true
      const isPending = processing || !statusCanonical ||
        statusCanonical === "Pending" || statusCanonical === "PENDING" || statusCanonical === "Judging"
      if (!isPending) return false
    } catch (e) { console.warn(`[VJ] pollForChallenge error: ${e.message}`) }
  }
  return false
}

async function getClubSession() {
  const club = config.club
  if (!club?.vjHandle || !club?.vjPassword) return null
  const CLUB_HANDLE = club.vjHandle.toLowerCase()
  if (hasSession(CLUB_HANDLE)) {
    const cookies = loadSession(CLUB_HANDLE)
    if (cookies) return cookies
  }
  try {
    await loginVJudge(club.vjHandle, club.vjPassword)
    return loadSession(CLUB_HANDLE)
  } catch (err) {
    console.error(`[VJ] Club account login failed: ${err.message}`)
    return null
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }