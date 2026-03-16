import express from "express"
import cors from "cors"
import bodyParser from "body-parser"
import config from "./config/config.js"

import { fetchProblem } from "./services/problemService.js"
import { getContestProblems } from "./services/contestService.js"
import { loginVJudge } from "./services/vjAuth.js"
import { submitCF, submitCFWithCookie, BotAccountError } from "./services/vjSubmit.js"
import { hasSession, clearSession } from "./services/vjSession.js"
import { getSubmissionStatus } from "./services/vjVerdict.js"

const app = express()

app.use(cors())
app.use(bodyParser.json())
app.use(express.static("public"))

// ── Problem ───────────────────────────────────────────────────────────────────

app.get("/api/problem/:problemId", async (req, res) => {
  try {
    res.json(await fetchProblem(req.params.problemId))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// ── Languages ─────────────────────────────────────────────────────────────────

app.get("/api/languages", (req, res) => {
  res.json([
    { id: 54, name: "GNU C++17" },
    { id: 74, name: "GNU C++20" },
    { id: 71, name: "Python 3"  },
    { id: 73, name: "PyPy 3"    },
    { id: 60, name: "Java 11"   },
  ])
})

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post("/api/login", async (req, res) => {
  try {
    const { handle, password } = req.body
    if (!handle || !password) return res.status(400).json({ error: "handle and password required" })
    res.json({ success: true, ...(await loginVJudge(handle, password)) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

app.get("/api/session/:handle", (req, res) => {
  res.json({ handle: req.params.handle, active: hasSession(req.params.handle) })
})

app.delete("/api/session/:handle", (req, res) => {
  res.json({ handle: req.params.handle, deleted: clearSession(req.params.handle) })
})

// ── Submit (bot account) ──────────────────────────────────────────────────────

app.post("/api/submit", async (req, res) => {
  try {
    const { handle, contestId, index, code, languageId, vjContestId, vjIndex } = req.body
    if (!handle) return res.status(400).json({ error: "handle required" })

    const result = await submitCF(contestId, index, code, languageId, handle, vjContestId, vjIndex)
    res.json({ ...result, success: true })
  } catch (err) {
    console.error(err)

    if (err instanceof BotAccountError) {
      // Tell the frontend to show the CF cookie fallback UI
      return res.status(422).json({
        error: err.message,
        requiresCookieAuth: true,
      })
    }

    const expired = err.message.includes("expired") || err.message.includes("log in")
    res.status(expired ? 401 : 500).json({ error: err.message, sessionExpired: expired })
  }
})

// ── Submit (CF cookie fallback) ───────────────────────────────────────────────

app.post("/api/submit/cf-cookie", async (req, res) => {
  try {
    const { handle, cfJsessionId, contestId, index, code, languageId, vjContestId, vjIndex } = req.body
    if (!handle)       return res.status(400).json({ error: "handle required" })
    if (!cfJsessionId) return res.status(400).json({ error: "cfJsessionId required" })

    const result = await submitCFWithCookie(
      contestId, index, code, languageId, handle, cfJsessionId, vjContestId, vjIndex
    )
    res.json({ ...result, success: true })
  } catch (err) {
    console.error(err)
    const expired = err.message.includes("expired") || err.message.includes("log in")
    res.status(expired ? 401 : 500).json({ error: err.message, sessionExpired: expired })
  }
})

// ── Verdict ───────────────────────────────────────────────────────────────────

app.get("/api/verdict/:submissionId", async (req, res) => {
  try {
    res.json(await getSubmissionStatus(req.params.submissionId))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Contest ───────────────────────────────────────────────────────────────────

app.get("/api/contest/:contestId", async (req, res) => {
  try {
    res.json(await getContestProblems(req.params.contestId))
  } catch (err) {
    console.error(err.message)
    res.status(500).json({ error: err.message })
  }
})

app.listen(config.server.port, () => {
  console.log("Server running on port", config.server.port)
})