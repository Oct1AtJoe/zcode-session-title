// Scripted session naming for zcode-session-title.
//
// ZCode hook output has no sessionTitle field, so this hook writes the title
// straight into the session row of ZCode's SQLite session store, exactly like a
// manual rename does (title + title_source = 'custom'). Naming therefore does not
// depend on the conversation model.
//
//   hook:   runs on UserPromptSubmit, exits immediately. If the session has no
//           title in the plugin's format yet, it reserves a state file and spawns
//           a detached worker, then exits.
//   worker: asks the configured model for {type, topic}, writes "MMDD·类型·主题"
//           into the session row, stores the outcome in the state file.
//
// Config: ~/.zcode/session-title/config.json
//   { "baseUrl": "https://.../v1/messages", "apiKey": "...", "model": "claude-haiku-4-5", "timeoutMs": 12000 }
// Falls back to ~/.claude/plugins/claude-session-title/config.json when missing.
// apiKey may be "$ENV_NAME" to read an environment variable. Without config nothing happens.

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const TYPES = ['功能', '设计', '修复', '优化', '发布', '探索', '文档', '研究']
const ZCODE_HOME = join(homedir(), '.zcode')
const DB_PATH = join(ZCODE_HOME, 'cli', 'db', 'db.sqlite')
const INDEX_PATH = join(ZCODE_HOME, 'v2', 'tasks-index.sqlite')
const CONFIGS = [
  join(ZCODE_HOME, 'session-title', 'config.json'),
  join(homedir(), '.claude', 'plugins', 'claude-session-title', 'config.json'),
]
const STATE_DIR = join(tmpdir(), 'zcode-session-title')
const RESERVE_MS = 60_000
const TITLE_RE = new RegExp(`^\\d{4}·(?:${TYPES.join('|')})·`)

const KIND_HINT = '判定顺序：故障/报错 → 修复；明确新增能力 → 功能；只谈外观交互 → 设计；' +
  '只谈变快变好 → 优化；只谈提交上线 → 发布；只谈文档 → 文档；深度验证或选型 → 研究；其余 → 探索。'

function readStdin() {
  return new Promise((resolve) => {
    if (!process.stdin) return resolve('')
    let data = ''
    let done = false
    const finish = () => { if (!done) { done = true; resolve(data) } }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
    process.stdin.on('close', finish)
  })
}

/** MMDD in Asia/Shanghai from a fixed UTC+8 offset (no ICU dependency). */
function mmddShanghai(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(shifted.getUTCDate()).padStart(2, '0')
  return `${mm}${dd}`
}

function loadConfig() {
  for (const file of CONFIGS) {
    try {
      const c = JSON.parse(readFileSync(file, 'utf8'))
      const apiKey = String(c.apiKey ?? '').replace(/^\$(\w+)$/, (_, name) => process.env[name] ?? '')
      if (!c.baseUrl || !apiKey) continue
      return {
        baseUrl: c.baseUrl,
        apiKey,
        model: c.model || 'claude-haiku-4-5',
        // DeepSeek keeps thinking on by default, which makes replies slower and optional for naming.
        thinking: c.thinking === 'disabled' ? { type: 'disabled' } : undefined,
        timeoutMs: Number(c.timeoutMs) || 12_000,
      }
    } catch {}
  }
  return null
}

/** Read title/title_source for a session; null when unavailable. */
function readSession(id) {
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const row = db.prepare('select title, title_source from session where id = ?').get(id)
    db.close()
    return row ?? null
  } catch {
    return null
  }
}

/** Same write a manual rename performs; false on failure. */
function writeTitle(id, title) {
  let ok = false
  try {
    const db = new DatabaseSync(DB_PATH)
    db.exec('pragma busy_timeout = 3000')
    const info = db.prepare(
      "update session set title = ?, title_source = 'custom', time_title_updated = ? where id = ?",
    ).run(title, Date.now(), id)
    db.close()
    ok = info.changes > 0
  } catch {}
  // The desktop sidebar renders its own task index; a manual rename keeps both in sync.
  try {
    const db = new DatabaseSync(INDEX_PATH)
    db.exec('pragma busy_timeout = 3000')
    db.prepare('update tasks set title = ?, cli_title = ? where task_id = ?').run(title, title, id)
    db.close()
  } catch {}
  return ok
}

/** Ask the configured model for {type, topic}; null on any failure. */
async function askModel(prompt, cfg, budgetMs, date) {
  const system = 'You name chat sessions. Reply with one JSON object only: {"type":"...","topic":"..."}. ' +
    'type is one of ' + TYPES.join('/') + '. ' + KIND_HINT + ' ' +
    'topic is 2-7 Chinese characters naming what this user message is about, in Chinese even when the message ' +
    'is English or names a product; keep at most one widely known latin word, whole (Agent, API, VSCode); ' +
    'no paths, code snippets, file extensions, greetings, or empty words like 作用/更新/问题/东西/怎么办.'
  const messages = [{ role: 'user', content: String(prompt ?? '').slice(0, 2000) }]
  // A reply past the budget is asked again rather than clipped: the model knows which words matter,
  // a character cut does not. Only a still-long second reply reaches cleanTopic's trim.
  const SHORT = ' The topic was too long last time: at most 7 Chinese characters, or one latin word plus 4.'
  for (let attempt = 0; attempt < 2; attempt++) {
    const sys = attempt ? system + SHORT : system
    const text = await requestText({ model: cfg.model, max_tokens: 300, system: sys, messages, ...(cfg.thinking ? { thinking: cfg.thinking } : {}) }, cfg, budgetMs)
    const out = parseNaming(text)
    if (out && (attempt > 0 || [...out.topic].length <= MAX_TOPIC)) return `${date}·${out.type}·${out.topic}`
  }
  return null
}

/** POST to the configured endpoint and return its text blocks; '' on any failure. */
async function requestText(body, cfg, budgetMs) {
  try {
    const res = await fetch(cfg.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(budgetMs),
    })
    if (!res.ok) return ''
    const data = await res.json()
    return (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  } catch {
    return ''
  }
}

function parseNaming(text) {
  const json = String(text).match(/\{[^{}]*\}/)
  if (!json) return null
  let out
  try { out = JSON.parse(json[0]) } catch { return null }
  const type = TYPES.includes(out.type) ? out.type : null
  const topic = cleanTopic(String(out.topic ?? ''))
  return type && topic ? { type, topic } : null
}

/**
 * The model already answers short; this is the only length rule, so nothing truncates twice.
 * Under MAX_TOPIC code points the topic is returned untouched (Agent模式区别 stays whole).
 * Past it the cut never lands inside a latin word or a number, and a dangling particle is dropped.
 */
const MAX_TOPIC = 14
function cleanTopic(raw) {
  const s = String(raw ?? '').replace(/[^\p{L}\p{N}]/gu, '')
  const chars = [...s]
  if (chars.length < 2) return null
  if (chars.length <= MAX_TOPIC) return s
  const sameWord = (a, b) =>
    (/[A-Za-z]/.test(a) && /[A-Za-z]/.test(b)) || (/[0-9]/.test(a) && /[0-9]/.test(b))
  let cut = MAX_TOPIC
  while (cut > 1 && sameWord(chars[cut - 1], chars[cut])) cut--
  // One latin identifier longer than the budget (ClaudeCodeAgent...) is cut after a whole word, not mid-word.
  if (cut <= 1) cut = Math.min([...(s.match(/^[A-Za-z0-9]+/)?.[0] ?? s)], MAX_TOPIC).length
  let topic = chars.slice(0, cut).join('')
  // Chinese words come in pairs: an odd trailing run (Windows更新说) is one cut too many.
  const isCjk = (c) => /[\u4e00-\u9fff]/.test(c)
  const cjk = [...topic].filter(isCjk).length
  if (cjk >= 3 && cjk % 2 === 1 && isCjk([...topic].pop())) topic = [...topic].slice(0, -1).join('')
  topic = topic.replace(/[的了与和及之]$/, '')
  return [...topic].length >= 2 ? topic : null
}

const stateFile = (id) => join(STATE_DIR, `${id.replace(/[^\w-]/g, '')}.json`)
function readState(id) {
  try { return JSON.parse(readFileSync(stateFile(id), 'utf8')) } catch { return null }
}
function writeState(id, state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const tmp = stateFile(id) + '.' + randomUUID()
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, stateFile(id))
  } catch {}
}

/** Why this session should not be named right now, or null when it can be. */
function skipReason(id) {
  const row = readSession(id)
  if (!row) return 'no-session-row'
  if (TITLE_RE.test(row.title ?? '')) return 'already-named'
  // A custom title that is not this plugin's format is a manual rename; leave it alone.
  if (row.title_source === 'custom') return 'user-renamed'
  return null
}

/** The detached worker: ask once, write the title, store the outcome, exit. */
async function runWorker(id, cfg) {
  const state = readState(id)
  if (!state?.prompt) return
  let title = null
  try { title = await askModel(state.prompt, cfg, Math.max(cfg.timeoutMs, 30_000), state.date) } catch {}
  if (title && !skipReason(id)) writeTitle(id, title)
  writeState(id, { ...state, result: title, at: Date.now() })
}

const mode = process.argv[2]

if (mode === 'worker') {
  // With no stdin the event loop is empty until fetch starts; timer keeps Node from exiting early.
  const keepAlive = setInterval(() => {}, 60_000)
  const workerCfg = loadConfig()
  if (workerCfg) await runWorker(process.argv[3], workerCfg)
  clearInterval(keepAlive)
  process.exit(0)
}

// Hooks receive their input on stdin.
let raw = ''
try { raw = await readStdin() } catch {}
let input = {}
try {
  input = JSON.parse(raw)
} catch {
  process.exit(0)
}
if (!input || typeof input !== 'object') process.exit(0)

const id = String(input.session_id ?? '')
if (!id || !existsSync(DB_PATH)) process.exit(0)
if (!loadConfig()) process.exit(0)
if (skipReason(id)) process.exit(0)

// Reserve synchronously so a second prompt in the same minute does not start another run.
const prev = readState(id)
if (prev && prev.at && Date.now() - prev.at < RESERVE_MS) process.exit(0)

const prompt = String(input.prompt ?? input.prompt_text ?? '')
if (!prompt.trim()) process.exit(0)

const state = { prompt, date: mmddShanghai(), at: Date.now(), result: null }
writeState(id, state)
try {
  const worker = spawn(process.execPath, [process.argv[1], 'worker', id], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  })
  worker.unref()
} catch {}
process.exit(0)
