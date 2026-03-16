// ── Session persistence ───────────────────────────────────
function saveHandleLocally(handle) {
  try { localStorage.setItem("vj_handle", handle) } catch (_) {}
}
function loadHandleLocally() {
  try { return localStorage.getItem("vj_handle") } catch (_) { return null }
}
function clearHandleLocally() {
  try { localStorage.removeItem("vj_handle") } catch (_) {}
}

// ── State ────────────────────────────────────────────────
let currentHandle   = null
let pollInterval    = null
let currentMode     = "problem"
let contestData     = null
let activeProblem   = null
// Pending submit payload reused when the user provides their CF cookie
let pendingSubmit   = null

// ── Tabs ─────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById("pane-editor").classList.toggle("active", tab === "editor")
  document.getElementById("pane-editor").classList.toggle("hidden",  tab !== "editor")
  document.getElementById("pane-result").classList.toggle("active", tab === "result")
  document.getElementById("pane-result").classList.toggle("hidden",  tab !== "result")
  document.getElementById("tab-editor").classList.toggle("active", tab === "editor")
  document.getElementById("tab-result").classList.toggle("active", tab === "result")
}

// ── Status banner ─────────────────────────────────────────
function setStatus(msg, type = "info") {
  const el = document.getElementById("statusBanner")
  el.textContent = msg
  el.className = `status-banner ${type}`
  el.classList.remove("hidden")
}
function clearStatus() {
  document.getElementById("statusBanner").classList.add("hidden")
}
function setModalStatus(msg, type = "info") {
  const el = document.getElementById("modalStatus")
  el.textContent = msg
  el.className = `modal-status ${type}`
  el.classList.remove("hidden")
}

// ── Session UI ────────────────────────────────────────────
function setLoggedIn(handle) {
  currentHandle = handle
  saveHandleLocally(handle)
  document.getElementById("userHandle").textContent = handle
  document.getElementById("userChip").classList.remove("hidden")
  document.getElementById("loginBtn").classList.add("hidden")
  document.getElementById("connectBtn").classList.add("hidden")
  document.getElementById("submitBtn").classList.remove("hidden")
}

function setLoggedOut() {
  currentHandle = null
  document.getElementById("userChip").classList.add("hidden")
  document.getElementById("loginBtn").classList.remove("hidden")
  document.getElementById("connectBtn").classList.remove("hidden")
  document.getElementById("submitBtn").classList.add("hidden")
  clearStatus()
}

// ── VJudge Login Modal ────────────────────────────────────
function startLogin() {
  document.getElementById("loginModal").classList.remove("hidden")
  document.getElementById("vjHandle").focus()
  document.getElementById("modalStatus").classList.add("hidden")
  document.getElementById("modalLoginBtn").disabled = false
  document.getElementById("modalLoginBtn").textContent = "Connect"
}

function closeModal() {
  document.getElementById("loginModal").classList.add("hidden")
}

async function doLogin() {
  const handle   = document.getElementById("vjHandle").value.trim()
  const password = document.getElementById("vjPassword").value
  if (!handle || !password) { setModalStatus("Username and password are required.", "error"); return }

  const btn = document.getElementById("modalLoginBtn")
  btn.disabled = true
  btn.textContent = "Connecting..."
  setModalStatus("Authenticating with VJudge...", "info")

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle, password })
    })
    const data = await res.json()
    if (res.ok) {
      setModalStatus(`Connected as ${handle}`, "ok")
      setTimeout(() => {
        closeModal()
        setLoggedIn(handle)
        setStatus(`Session active — submitting as ${handle}`, "ok")
      }, 600)
    } else {
      setModalStatus(data.error || "Login failed.", "error")
      btn.disabled = false
      btn.textContent = "Connect"
    }
  } catch (err) {
    setModalStatus("Connection error: " + err.message, "error")
    btn.disabled = false
    btn.textContent = "Connect"
  }
}

async function logout() {
  if (currentHandle) await fetch(`/api/session/${currentHandle}`, { method: "DELETE" }).catch(() => {})
  clearHandleLocally()
  setLoggedOut()
}

// ── CF Cookie Modal ───────────────────────────────────────

function openCFCookieModal(botErrorMessage) {
  document.getElementById("cfCookieError").textContent = botErrorMessage
  document.getElementById("cfCookieStatus").classList.add("hidden")
  document.getElementById("cfJsessionId").value = ""
  document.getElementById("cfCookieSubmitBtn").disabled = false
  document.getElementById("cfCookieSubmitBtn").textContent = "Verify & Submit"
  document.getElementById("cfCookieModal").classList.remove("hidden")
  setTimeout(() => document.getElementById("cfJsessionId").focus(), 100)
}

function closeCFCookieModal() {
  document.getElementById("cfCookieModal").classList.add("hidden")
  pendingSubmit = null
}

function setCFCookieStatus(msg, type = "info") {
  const el = document.getElementById("cfCookieStatus")
  el.textContent = msg
  el.className = `modal-status ${type}`
  el.classList.remove("hidden")
}

async function submitWithCFCookie() {
  if (!pendingSubmit) return

  const cfJsessionId = document.getElementById("cfJsessionId").value.trim()
  if (!cfJsessionId) {
    setCFCookieStatus("Please paste your JSESSIONID value.", "error")
    return
  }

  const btn = document.getElementById("cfCookieSubmitBtn")
  btn.disabled = true
  btn.textContent = "Verifying..."
  setCFCookieStatus("Verifying your Codeforces account...", "info")

  // Reset result pane
  document.getElementById("submitSteps").innerHTML = ""
  document.getElementById("submitSteps").classList.remove("hidden")
  document.getElementById("verdictCard").innerHTML = `
    <div class="verdict-spinner"><div class="spinner"></div><span>Verifying CF account...</span></div>
  `
  document.getElementById("verdictMeta").classList.add("hidden")
  document.getElementById("cfLink").classList.add("hidden")

  try {
    const res = await fetch("/api/submit/cf-cookie", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...pendingSubmit, cfJsessionId })
    })
    const data = await res.json()

    if (data.steps?.length) renderSubmitSteps(data.steps)

    if (!res.ok) {
      setCFCookieStatus(data.error || "Submission failed.", "error")
      btn.disabled = false
      btn.textContent = "Verify & Submit"

      document.getElementById("verdictCard").innerHTML =
        `<div class="verdict-text red">${data.error}</div>`

      if (res.status === 401) {
        closeCFCookieModal()
        setLoggedOut()
        setStatus("Session expired. Please log in again.", "error")
      }
      return
    }

    // Success — close modal, start polling
    closeCFCookieModal()
    clearStatus()
    startVerdictPolling(data.submissionId)
  } catch (err) {
    setCFCookieStatus("Network error: " + err.message, "error")
    btn.disabled = false
    btn.textContent = "Verify & Submit"
  }
}

// ── Input detection ───────────────────────────────────────
async function loadInput() {
  const raw = document.getElementById("problemInput").value.trim()
  if (!raw) return
  if (/^\d+$/.test(raw)) {
    await loadContest(raw)
  } else {
    currentMode   = "problem"
    contestData   = null
    activeProblem = null
    document.getElementById("contestPanel").classList.add("hidden")
    await loadProblem(raw)
  }
}

// ── Problem loading ───────────────────────────────────────
async function loadProblem(problemId) {
  const container = document.getElementById("problemContainer")
  container.innerHTML = `<div class="empty-state"><p style="color:var(--muted)">Loading...</p></div>`

  try {
    const [problemRes] = await Promise.all([fetch(`/api/problem/${problemId}`), loadLanguages()])
    const data = await problemRes.json()
    if (!problemRes.ok) throw new Error(data.error || "Failed to load problem")

    activeProblem = { ...activeProblem, contestId: data.contestId, index: data.index }

    const tagsHtml = data.tags.map(t => `<span class="tag">${t}</span>`).join("")
    container.innerHTML = `
      <div class="problem-header">
        <div class="problem-title">${data.title}</div>
        <div class="problem-meta">
          <div><b>Contest</b> ${data.contestName}</div>
          <div><b>Difficulty</b> ${data.rating}</div>
          <div class="tags">${tagsHtml}</div>
        </div>
      </div>
      <div class="cf-statement">${data.statement}</div>
      <div class="problem-link" style="margin-top:24px">
        <a href="${data.link}" target="_blank">View on Codeforces ↗</a>
      </div>
    `
    if (window.MathJax?.typesetPromise) MathJax.typesetPromise([container]).catch(console.error)
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p style="color:var(--red)">${err.message}</p></div>`
  }
}

// ── Contest loading ───────────────────────────────────────
async function loadContest(contestId) {
  currentMode   = "contest"
  activeProblem = null

  const contestPanel     = document.getElementById("contestPanel")
  const problemContainer = document.getElementById("problemContainer")

  contestPanel.classList.remove("hidden")
  contestPanel.innerHTML = `<div class="empty-state"><p style="color:var(--muted)">Loading contest...</p></div>`
  problemContainer.innerHTML = `<div class="empty-state"><p style="color:var(--muted)">Select a problem from the list</p></div>`

  await loadLanguages()

  try {
    const res  = await fetch(`/api/contest/${contestId}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || "Failed to load contest")
    contestData = data
    renderContestPanel(data)
  } catch (err) {
    contestPanel.innerHTML = `<div class="empty-state"><p style="color:var(--red)">${err.message}</p></div>`
  }
}

function renderContestPanel(data) {
  const panel = document.getElementById("contestPanel")
  panel.dataset.contestId = String(data.id)
  panel.innerHTML = `
    <div class="contest-header">
      <div class="contest-title">${data.title}</div>
      <div class="contest-subtitle">VJudge Contest #${data.id} · ${data.problems.length} problems</div>
    </div>
    <div class="contest-problem-list">
      ${data.problems.map((p, i) => `
        <button class="contest-problem-row" data-vjcode="${p.vjCode || ''}" data-vjindex="${p.index}" onclick="selectContestProblem(event)">
          <span class="contest-problem-index">${p.index}</span>
          <span class="contest-problem-title">${p.title}</span>
          <span class="contest-problem-oj">${p.oj}</span>
        </button>
      `).join("")}
    </div>
  `
}

async function selectContestProblem(e) {
  const btn         = e.currentTarget
  const vjCode      = btn.dataset.vjcode
  const vjIndex     = btn.dataset.vjindex
  const vjContestId = document.getElementById("contestPanel").dataset.contestId

  document.querySelectorAll(".contest-problem-row").forEach(r => r.classList.remove("selected"))
  btn.classList.add("selected")

  if (!vjCode) {
    activeProblem = null
    document.getElementById("problemContainer").innerHTML = `
      <div class="empty-state"><p style="color:var(--muted)">No preview available for this problem.</p></div>
    `
    return
  }

  const match = vjCode.match(/CodeForces-(\d+)([A-Z0-9]+)/i)
  if (match) {
    activeProblem = {
      contestId:    match[1],
      index:        match[2],
      vjContestId:  vjContestId || null,
      vjIndex:      vjIndex     || null,
    }
    await loadProblem(`${match[1]}${match[2]}`)
  } else {
    activeProblem = null
    document.getElementById("problemContainer").innerHTML = `
      <div class="empty-state"><p style="color:var(--muted)">Preview only available for Codeforces problems.</p></div>
    `
  }
}

// ── Languages ─────────────────────────────────────────────
async function loadLanguages() {
  const res   = await fetch("/api/languages")
  const langs = await res.json()
  const select = document.getElementById("language")
  select.innerHTML = ""
  langs.forEach(lang => {
    const opt = document.createElement("option")
    opt.value = lang.id
    opt.textContent = lang.name
    select.appendChild(opt)
  })
}

// ── Verdict polling ───────────────────────────────────────
function startVerdictPolling(submissionId) {
  if (pollInterval) clearInterval(pollInterval)

  document.getElementById("tab-result").disabled = false
  document.getElementById("verdictCard").innerHTML = `
    <div class="verdict-spinner"><div class="spinner"></div><span>Judging submission #${submissionId}...</span></div>
  `
  document.getElementById("verdictMeta").classList.add("hidden")
  document.getElementById("cfLink").classList.add("hidden")

  const poll = async () => {
    try {
      const res  = await fetch(`/api/verdict/${submissionId}`)
      const data = await res.json()
      renderVerdict(data)
      if (!data.judging) clearInterval(pollInterval)
    } catch (_) {}
  }

  poll()
  pollInterval = setInterval(poll, 2500)
}

function renderVerdict(data) {
  const card = document.getElementById("verdictCard")
  const meta = document.getElementById("verdictMeta")
  const link = document.getElementById("cfLink")

  if (data.judging) {
    card.innerHTML = `
      <div class="verdict-spinner"><div class="spinner"></div><span>Judging... (test ${data.passedTests ?? 0})</span></div>
    `
    return
  }

  card.innerHTML = `
    <div class="verdict-text ${data.color}">${data.verdictText}</div>
    <div class="verdict-id">Submission #${data.id}</div>
  `

  if (data.timeMs != null || data.memoryKb != null) {
    meta.classList.remove("hidden")
    meta.innerHTML = `
      ${data.timeMs   != null ? `<div class="verdict-stat"><div class="verdict-stat-label">Time</div><div class="verdict-stat-value">${data.timeMs} ms</div></div>` : ""}
      ${data.memoryKb != null ? `<div class="verdict-stat"><div class="verdict-stat-label">Memory</div><div class="verdict-stat-value">${data.memoryKb} KB</div></div>` : ""}
    `
  }

  link.href = `https://vjudge.net/solution/${data.id}`
  link.classList.remove("hidden")
}

// ── Submit (bot account — primary path) ───────────────────
async function submitSolution() {
  if (!currentHandle) { startLogin(); return }
  if (!activeProblem) { setStatus("Load a problem first.", "error"); return }

  const code       = document.getElementById("code").value.trim()
  const languageId = document.getElementById("language").value
  if (!code) { setStatus("Paste your solution first.", "error"); return }

  const { contestId, index } = activeProblem
  const btn = document.getElementById("submitBtn")
  btn.disabled = true
  btn.textContent = "Submitting..."
  setStatus("Submitting via VJudge...", "info")

  document.getElementById("tab-result").disabled = false
  switchTab("result")
  document.getElementById("verdictCard").innerHTML = `
    <div class="verdict-spinner"><div class="spinner"></div><span>Sending submission...</span></div>
  `
  document.getElementById("verdictMeta").classList.add("hidden")
  document.getElementById("cfLink").classList.add("hidden")
  document.getElementById("submitSteps").innerHTML = ""
  document.getElementById("submitSteps").classList.remove("hidden")

  // Save full payload so we can reuse it in the cookie fallback
  pendingSubmit = {
    handle:      currentHandle,
    contestId,
    index,
    code,
    languageId,
    vjContestId: activeProblem.vjContestId || null,
    vjIndex:     activeProblem.vjIndex     || null,
  }

  try {
    const res = await fetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pendingSubmit)
    })
    const data = await res.json()

    if (data.steps?.length) renderSubmitSteps(data.steps)

    if (!res.ok) {
      if (res.status === 401) {
        setLoggedOut()
        setStatus("Session expired. Please log in again.", "error")
        pendingSubmit = null

      } else if (res.status === 422 && data.requiresCookieAuth) {
        // Bot account rejected — ask user for CF cookie
        setStatus("VJudge bot unavailable — enter your CF cookie to continue.", "warn")
        document.getElementById("verdictCard").innerHTML = `
          <div class="verdict-text amber">Bot account unavailable</div>
          <div class="verdict-id" style="margin-top:8px">Enter your CF session cookie to submit directly.</div>
        `
        openCFCookieModal(data.error)

      } else {
        setStatus("Error: " + data.error, "error")
        document.getElementById("verdictCard").innerHTML = `<div class="verdict-text red">${data.error}</div>`
        pendingSubmit = null
      }
      return
    }

    if (data.challengeEncountered) {
      document.getElementById("verdictCard").innerHTML = `<div class="verdict-text red">Submit blocked</div>`
      setStatus("Cannot submit — see details in Result tab.", "error")
      pendingSubmit = null
      return
    }

    pendingSubmit = null
    clearStatus()
    startVerdictPolling(data.submissionId)
  } catch (err) {
    setStatus("Network error: " + err.message, "error")
    pendingSubmit = null
  } finally {
    btn.disabled = false
    btn.textContent = "Submit Solution"
  }
}

function renderSubmitSteps(steps) {
  const icons = { info: "→", warn: "⚠", error: "✕", ok: "✓" }
  document.getElementById("submitSteps").innerHTML = steps.map(s => `
    <div class="submit-step submit-step--${s.type}">
      <span class="submit-step-icon">${icons[s.type] || "·"}</span>
      <span>${s.text}</span>
    </div>
  `).join("")
}

// ── Init ─────────────────────────────────────────────────
async function init() {
  await loadLanguages()
  const saved = loadHandleLocally()
  if (saved) {
    try {
      const res  = await fetch(`/api/session/${saved}`)
      const data = await res.json()
      if (data.active) {
        setLoggedIn(saved)
        setStatus(`Session restored — submitting as ${saved}`, "ok")
        setTimeout(clearStatus, 3000)
      } else {
        clearHandleLocally()
      }
    } catch (_) { clearHandleLocally() }
  }
}

document.getElementById("problemInput").addEventListener("keydown", e => {
  if (e.key === "Enter") loadInput()
})
document.getElementById("loginModal").addEventListener("click", e => {
  if (e.target === e.currentTarget) closeModal()
})
document.getElementById("cfCookieModal").addEventListener("click", e => {
  if (e.target === e.currentTarget) closeCFCookieModal()
})
document.getElementById("vjPassword").addEventListener("keydown", e => {
  if (e.key === "Enter") doLogin()
})
document.getElementById("cfJsessionId").addEventListener("keydown", e => {
  if (e.key === "Enter") submitWithCFCookie()
})

init()