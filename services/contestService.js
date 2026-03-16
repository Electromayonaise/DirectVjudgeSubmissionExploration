import axios from "axios"
import { VJ_UA } from "./vjSession.js"

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