import axios from "axios"
import { saveSession, loadSession, cookieHeader, parseSetCookies, mergeCookies, VJ_UA } from "./vjSession.js"

/**
 * Log in to VJudge with username/password.
 * Persists the session for future requests.
 */
export async function loginVJudge(vjHandle, vjPassword) {
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

/**
 * Link a Codeforces account to the active VJudge session using the CF JSESSIONID cookie.
 *
 * VJudge's verifyAccount expects:
 *   POST /user/verifyAccount
 *   Content-Type: application/json
 *   Body: { "oj": "CodeForces", "proof": [{ "name": "JSESSIONID", "value": "<cf_cookie>" }] }
 *
 * @param {Array}  vjCookies    - Active VJudge session cookies
 * @param {string} cfJsessionId - The JSESSIONID value from the user's Codeforces session
 * @returns {{ success: boolean, cfHandle: string }}
 */
export async function verifyCFAccount(vjCookies, cfJsessionId) {
  // Step 1: Unlink any previously linked CF account (ignore errors — may not have one)
  try {
    await axios.post(
      "https://vjudge.net/user/unverifyAccount",
      new URLSearchParams({ oj: "CodeForces" }).toString(),
      {
        headers: {
          "User-Agent": VJ_UA,
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          "Referer": "https://vjudge.net/",
          "Origin": "https://vjudge.net",
          "Cookie": cookieHeader(vjCookies),
        },
        validateStatus: () => true,
        timeout: 10000,
      }
    )
    console.log("[VJ] unverifyAccount done.")
  } catch (e) {
    console.warn("[VJ] unverifyAccount failed (non-fatal):", e.message)
  }

  // Step 2: Link the new CF account via JSESSIONID proof
  const body = JSON.stringify({
    oj: "CodeForces",
    proof: [{ name: "JSESSIONID", value: cfJsessionId }],
  })

  const res = await axios.post("https://vjudge.net/user/verifyAccount", body, {
    headers: {
      "User-Agent": VJ_UA,
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": "https://vjudge.net/",
      "Origin": "https://vjudge.net",
      "Cookie": cookieHeader(vjCookies),
    },
    validateStatus: s => s < 500,
    timeout: 15000,
  })

  const data = res.data
  console.log("[VJ] verifyAccount response:", JSON.stringify(data))

  if (!data?.success) {
    const msg = data?.msg || data?.message || "Could not verify Codeforces account."
    throw new Error(`CF account verification failed: ${msg}`)
  }

  // Extract CF handle from accountDisplay HTML: <a href='...profile/HANDLE'>HANDLE</a>
  const cfHandle = String(data.accountDisplay || "")
    .replace(/<[^>]+>/g, "")
    .trim() || "unknown"

  return { success: true, cfHandle }
}