import axios from "axios"
import { VJ_UA } from "./vjSession.js"

const VERDICT_MAP = {
  "Accepted":             { verdict: "OK",        text: "Accepted",              color: "green" },
  "AC":                   { verdict: "OK",        text: "Accepted",              color: "green" },
  "Wrong Answer":         { verdict: "WA",        text: "Wrong Answer",          color: "red"   },
  "WA":                   { verdict: "WA",        text: "Wrong Answer",          color: "red"   },
  "Time Limit Exceeded":  { verdict: "TLE",       text: "Time Limit Exceeded",   color: "red"   },
  "TLE":                  { verdict: "TLE",       text: "Time Limit Exceeded",   color: "red"   },
  "Memory Limit Exceeded":{ verdict: "MLE",       text: "Memory Limit Exceeded", color: "red"   },
  "MLE":                  { verdict: "MLE",       text: "Memory Limit Exceeded", color: "red"   },
  "Runtime Error":        { verdict: "RE",        text: "Runtime Error",         color: "red"   },
  "RE":                   { verdict: "RE",        text: "Runtime Error",         color: "red"   },
  "Compilation Error":    { verdict: "CE",        text: "Compilation Error",     color: "red"   },
  "CE":                   { verdict: "CE",        text: "Compilation Error",     color: "red"   },
  "Pending":              { verdict: "PENDING",   text: "Pending...",            color: "amber" },
  "PENDING":              { verdict: "PENDING",   text: "Pending...",            color: "amber" },
  "Judging":              { verdict: "JUDGING",   text: "Judging...",            color: "amber" },
  "Challenge Encountered":{ verdict: "CHALLENGE", text: "Challenge Encountered", color: "amber" },
  "SUBMIT_FAILED_TEMP":   { verdict: "FAILED",    text: "Submit failed (temp)",  color: "red"   },
}

export async function getSubmissionStatus(submissionId) {
  const res = await axios.get(`https://vjudge.net/solution/data/${submissionId}`, {
    headers: { "User-Agent": VJ_UA, "Accept": "application/json", "Referer": "https://vjudge.net/" },
    timeout: 10000, validateStatus: s => s < 500,
  })

  if (res.status === 404) {
    return { id: submissionId, verdict: "PENDING", verdictText: "Waiting for judge...", judging: true }
  }

  const d = res.data
  console.log(`[VJ] solution/data/${submissionId}:`, JSON.stringify(d))

  const statusCanonical = d?.statusCanonical ?? d?.status ?? ""
  const processing      = d?.processing === true

  const judging = processing ||
    statusCanonical === "Pending"  ||
    statusCanonical === "PENDING"  ||
    statusCanonical === "Judging"

  const mapped = VERDICT_MAP[statusCanonical] || {
    verdict: statusCanonical || "UNKNOWN",
    text:    statusCanonical || "Unknown status",
    color:   "amber",
  }

  return {
    id:          submissionId,
    verdict:     mapped.verdict,
    verdictText: mapped.text,
    color:       mapped.color,
    judging,
    passedTests: d?.passedTestCount ?? null,
    timeMs:      d?.time   != null ? Number(d.time)                      : null,
    memoryKb:    d?.memory != null ? Math.round(Number(d.memory) / 1024) : null,
    language:    d?.language  ?? null,
    problem:     d?.problemId ?? null,
    _raw: d,
  }
}