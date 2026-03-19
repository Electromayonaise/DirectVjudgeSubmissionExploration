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

// These are VJudge's own language IDs for the CodeForces OJ — fixed, do not vary per problem.
app.get("/api/languages", (req, res) => {
  res.json([
    { id: 54,  name: "GNU C++17 7.3.0"                },
    { id: 89,  name: "GNU C++20 13.2 (64bit, winlibs)" },
    { id: 91,  name: "GNU C++23 14.2 (64bit, msys2)"  },
    { id: 43,  name: "GNU GCC C11 5.1.0"              },
    { id: 31,  name: "Python 3.13.2"                  },
    { id: 70,  name: "PyPy 3.10 (7.3.15, 64bit)"      },
    { id: 40,  name: "PyPy 2.7.13 (7.3.0)"            },
    { id: 41,  name: "PyPy 3.6.9 (7.3.0)"             },
    { id: 21,  name: "Python 2.7.18"                  },
    { id: 87,  name: "Java 21 64bit"                  },
    { id: 36,  name: "Java 8 32bit"                   },
    { id: 99,  name: "Kotlin 2.2.0"                   },
    { id: 88,  name: "Kotlin 1.9.21"                  },
    { id: 83,  name: "Kotlin 1.7.20"                  },
    { id: 75,  name: "Rust 1.89.0 (2021)"             },
    { id: 98,  name: "Rust 1.89.0 (2024)"             },
    { id: 42,  name: "Go 1.22.2"                      },
    { id: 34,  name: "JavaScript V8 4.8.0"            },
    { id: 55,  name: "Node.js 15.8.0 (64bit)"         },
    { id: 79,  name: "C# 10, .NET SDK 6.0"            },
    { id: 77,  name: "C# .NET SDK 9"                  },
    { id: 65,  name: "C# 8, .NET Core 3.1"            },
    { id: 9,   name: "C# Mono 6.8"                    },
    { id: 97,  name: "F# 9, .NET SDK 9"               },
    { id: 12,  name: "Haskell GHC 8.10.1"             },
    { id: 20,  name: "Scala 2.12.8"                   },
    { id: 67,  name: "Ruby 3.2.2"                     },
    { id: 6,   name: "PHP 8.1.7"                      },
    { id: 13,  name: "Perl 5.20.1"                    },
    { id: 19,  name: "OCaml 4.02.1"                   },
    { id: 4,   name: "Free Pascal 3.2.2"               },
    { id: 51,  name: "PascalABC.NET 3.8.3"            },
    { id: 3,   name: "Delphi 7"                       },
    { id: 28,  name: "D DMD32 v2.105.0"               },
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