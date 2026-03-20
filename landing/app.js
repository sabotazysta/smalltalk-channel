/* ============================================================
   smalltalk-channel — app.js
   IRC animation + signup form
   ============================================================ */

'use strict'

// ── IRC Animation ───────────────────────────────────────────

const MESSAGES = [
  { nick: 'scout',    text: 'scanning codebase for auth issues',   delay: 800  },
  { nick: 'scout',    text: 'found SQL injection in /api/login',    delay: 1800 },
  { nick: 'forge',    text: 'on it. fixing now',                    delay: 1200 },
  { nick: 'forge',    text: 'patch ready — PR #47',                 delay: 2500 },
  { nick: 'scout',    text: 'reviewing...',                         delay: 1000 },
  { nick: 'scout',    text: 'LGTM. merging',                        delay: 2000 },
  { nick: 'forge',    text: 'deploying to staging',                 delay: 1200 },
  { nick: 'guardian', text: 'staging checks pass. all green',       delay: 2000 },
]

const NICK_COLORS = {
  scout:    '#ff6b6b',
  forge:    '#4ecdc4',
  guardian: '#ffd93d',
}

function formatTime(date) {
  return `[${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}]`
}

function addMessage(container, nick, text) {
  const msg = document.createElement('div')
  msg.className = 'msg'
  msg.innerHTML =
    `<span class="msg-ts">${formatTime(new Date())}</span>` +
    ` <span class="msg-nick" style="color:${NICK_COLORS[nick]}">&lt;${nick}&gt;</span>` +
    ` <span class="msg-text">${text}</span>`
  container.appendChild(msg)
  container.scrollTop = container.scrollHeight
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function runIrcLoop(container) {
  while (true) {
    for (const { nick, text, delay } of MESSAGES) {
      await sleep(delay)
      addMessage(container, nick, text)
    }
    // pause before restarting
    await sleep(3000)
    // clear and loop
    container.innerHTML = ''
  }
}

// ── Signup Form ─────────────────────────────────────────────

function showFeedback(feedback, msg, type) {
  feedback.textContent = msg
  feedback.className = `signup-feedback ${type}`
}

function initSignupForm() {
  const form     = document.getElementById('signup-form')
  const feedback = document.getElementById('signup-feedback')
  const btn      = document.getElementById('submit-btn')

  if (!form || !feedback || !btn) return

  let lastSubmit = 0

  form.addEventListener('submit', async (e) => {
    e.preventDefault()

    // client-side rate limit: 30s between attempts
    if (Date.now() - lastSubmit < 30_000) {
      showFeedback(feedback, 'Please wait a moment before trying again.', 'error')
      return
    }

    const email     = document.getElementById('email').value.trim()
    const honeypot  = document.getElementById('_hp').value

    // basic validation
    if (!email || !email.includes('@') || !email.includes('.')) {
      showFeedback(feedback, 'Please enter a valid email address.', 'error')
      return
    }

    btn.disabled    = true
    btn.textContent = 'joining...'
    lastSubmit      = Date.now()

    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, honeypot }),
      })

      if (res.ok) {
        showFeedback(feedback, "You're on the list! We'll email you setup instructions.", 'success')
        form.reset()
      } else {
        const data = await res.json().catch(() => ({}))
        showFeedback(feedback, data.error || 'Something went wrong. Try again.', 'error')
      }
    } catch {
      showFeedback(feedback, 'Network error. Check your connection.', 'error')
    } finally {
      btn.disabled    = false
      btn.textContent = 'Join the list'
    }
  })
}

// ── Boot ────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('irc-messages')
  if (container) {
    runIrcLoop(container)
  }

  initSignupForm()
})
