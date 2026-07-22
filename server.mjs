import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { Storage } from '@google-cloud/storage';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { extractText, getDocumentProxy } from 'unpdf';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = existsSync('/data') ? '/data' : __dirname;

/* Short SHA of the running build — shown in the top bar so we can see what's live.
   Railway injects RAILWAY_GIT_COMMIT_SHA; fall back to local git for dev. */
const GIT_COMMIT = (() => {
  const env = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || process.env.SOURCE_VERSION;
  if (env) return String(env).slice(0, 7);
  try { return execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); }
  catch { return 'dev'; }
})();
const app  = express();
const PORT = process.env.PORT || 3000;

/* ─────────────────────────────────────────────
   CREDENTIALS  (never hardcoded — env vars only)
───────────────────────────────────────────── */
const OPENAI_KEY        = process.env.OPENAI_API_KEY      || null;
const ANTHROPIC_KEY     = process.env.ANTHROPIC_API_KEY   || null;
const AHREFS_KEY        = process.env.AHREFS_API_KEY      || null;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const INDEXY_SYSTEM_PROMPT = `You are a senior SEO project manager reading a third-party SEO audit. Your ONLY job is to extract every single recommendation and turn it into an actionable to-do list. The client will never open the original files again — your output must contain everything.

**CRITICAL RULE: Do not summarise groups of rows. Do not write "10 pages need new titles". Instead, output one checkbox per page, per keyword, per URL — every row in every sheet becomes its own task. If the workbook has 60 rows, you output 60 tasks.**

## STEP 1 — Read executive summary
Note the overall strategic priorities and client name.

## STEP 2 — Read EVERY sheet in the workbook, row by row
Process each sheet completely before moving to the next. Common sheet names and what to extract:

**"Content Plan" / "Keyword Plan" / "Content Gap"** — Each row = one new page to create. For each row extract:
- Keyword / Parent Topic
- Recommended Title (exact text from the "Recommended Title" column — copy it verbatim)
- Intent, Priority, Difficulty, Traffic Potential if present
- Output as: - [ ] **Create new page** — Keyword: "[keyword]" | Title: "[Recommended Title]" | Priority: [High/Med/Low]

**"On-Page" / "Page Audit" / "Title & Meta"** — Each row = one existing page to fix. For each row extract:
- URL
- Current title → Suggested title (exact text, in quotes)
- Current meta → Suggested meta (exact text, in quotes)
- Any H1 change

**"Implementation Plan" / "Action Items"** — Each row = one task. Output verbatim.

**"Executive Summary"** — Extract strategic bullets as high-priority tasks if not already covered.

**All other sheets** — Scan for any row that implies an action and output it.

## STEP 3 — Read the PDF report
Extract every recommendation not already covered by the workbook. Merge duplicates.

## STEP 4 — For every on-page fix, write the exact copy
NEVER write vague tasks. Always show the literal text:
- Title: Current: "Old Title Here" → Suggested: "New Title Here | Brand"
- Meta: Suggested: "Exact meta description text here."
- H1: Suggested: "Exact heading text"

## IMPORTANT FORMATTING RULES

- Use - [ ] for every actionable task.
- NEVER use [square brackets] inside task text — use (parentheses) for placeholders. Square brackets break the checkbox system.
- Every row in the workbook = one table row. Do not group or summarise.
- Do not ask follow-up questions.

## OUTPUT FORMAT

**Audit Summary** — One line: client, audit date, agency, total task count.

**## 🔴 HIGH PRIORITY — Do These First**
Checkbox list. Write full current title → suggested title inline. Use (parentheses) for notes, never [brackets].

**## 🟡 MEDIUM PRIORITY — Plan These Next**
Checkbox list. Group by: Technical Fixes | Content Updates | Off-Page.

**## 🟢 LOW PRIORITY — Do Later / Monitor**
Checkbox list.

**## ⚠️ ON HOLD — Do Not Do Yet**
Bullet list with reason.

**## NEW CONTENT PAGES — Keywords to Create (from Content Plan)**
Every row from Content Plan sheet. Proper markdown table — no plain text pipes:

| Keyword | Parent Topic | Recommended Title | Intent | Priority | Difficulty | Traffic Potential |
|---------|--------------|-------------------|--------|----------|------------|-------------------|

**## EXISTING PAGES — On-Page Fixes Required**
Every row from on-page/audit sheet. Proper markdown table:

| URL | Current Title | Suggested Title | Target Keyword | Current Meta | Suggested Meta | Action |
|-----|---------------|-----------------|----------------|--------------|----------------|--------|

**## Data Caveats**
One paragraph.`;
const AUTH_USER         = process.env.AUTH_USER            || 'pablo';
const AUTH_PASS         = process.env.AUTH_PASS            || null;

/* ─────────────────────────────────────────────
   GOOGLE SEARCH CONSOLE  (OAuth 2.0)
   Requires: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_URL
───────────────────────────────────────────── */
const GSC_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || null;
const GSC_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || null;
const APP_URL           = process.env.APP_URL               || `http://localhost:${process.env.PORT || 3000}`;

/* ─────────────────────────────────────────────
   AGENCY ANALYTICS
   API: POST https://apirequest.app/query
   Auth: Basic base64(:<api_key>)
───────────────────────────────────────────── */
const AA_KEY  = process.env.AA_API_KEY || null;
const AA_BASE = 'https://apirequest.app/query';

/* ─────────────────────────────────────────────
   PAGE OPTIMIZER PRO
───────────────────────────────────────────── */
const POP_KEY  = process.env.POP_API_KEY || null;
const POP_BASE = 'https://app.pageoptimizer.pro/api';

/* ─────────────────────────────────────────────
   GOOGLE CLOUD STORAGE
───────────────────────────────────────────── */
const GCS_BUCKET = process.env.GCS_BUCKET_NAME || null;
let gcs = null;

if (process.env.GCS_SERVICE_ACCOUNT_JSON && GCS_BUCKET) {
  try {
    const creds = JSON.parse(process.env.GCS_SERVICE_ACCOUNT_JSON);
    gcs = new Storage({ credentials: creds, projectId: creds.project_id });
    console.log(`[gcs] bucket: ${GCS_BUCKET}`);
  } catch (e) {
    console.warn('[gcs] Failed to parse GCS_SERVICE_ACCOUNT_JSON:', e.message);
  }
}

if (!AUTH_PASS) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: AUTH_PASS env var is required in production');
    process.exit(1);
  }
  console.warn('[auth] AUTH_PASS not set — all login attempts will fail until it is configured');
}

/* ─────────────────────────────────────────────
   SESSION STORE  (crypto-random tokens, persisted to disk
   so logins survive server restarts/redeploys)
───────────────────────────────────────────── */
const sessions = new Map();          // token → { expiresAt }
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;  // 30 days
const SESSIONS_FILE = join(DATA_DIR, '.sessions.json');

function loadSessions() {
  if (!existsSync(SESSIONS_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    for (const [token, s] of Object.entries(raw)) {
      if (s.expiresAt > now) sessions.set(token, s);
    }
  } catch (e) {
    console.warn('[session] Failed to load session store:', e.message);
  }
}

function saveSessions() {
  try {
    writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions)));
  } catch (e) {
    console.warn('[session] Failed to persist session store:', e.message);
  }
}

loadSessions();

/* ─────────────────────────────────────────────
   RANK TRACKER DATA  (clients/keywords + saved SEO
   reports — persisted server-side so it survives
   browser/device switches, not just localStorage)
───────────────────────────────────────────── */
const RANKDATA_FILE = join(DATA_DIR, '.rankdata.json');
const RANKDATA_DEFAULT = { rtData: { clients: [], activeClientId: null }, reports: {} };

function loadRankData() {
  if (!existsSync(RANKDATA_FILE)) return { ...RANKDATA_DEFAULT };
  try {
    const raw = JSON.parse(readFileSync(RANKDATA_FILE, 'utf8'));
    return {
      rtData:  raw.rtData  || RANKDATA_DEFAULT.rtData,
      reports: raw.reports || {},
    };
  } catch (e) {
    console.warn('[rankdata] Failed to load rank data store:', e.message);
    return { ...RANKDATA_DEFAULT };
  }
}

function saveRankData(data) {
  try {
    writeFileSync(RANKDATA_FILE, JSON.stringify(data));
  } catch (e) {
    console.warn('[rankdata] Failed to persist rank data store:', e.message);
  }
}

/* ─────────────────────────────────────────────
   WEEKLY CLIENT TASKS  (day-of-week → client
   schedule + per-client recurring task checklist)
───────────────────────────────────────────── */
const WEEKLYDATA_FILE = join(DATA_DIR, '.weeklydata.json');
const WEEKLYDATA_DEFAULT = {
  schedule: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
  tasks: {},
};

function loadWeeklyData() {
  if (!existsSync(WEEKLYDATA_FILE)) return { ...WEEKLYDATA_DEFAULT };
  try {
    const raw = JSON.parse(readFileSync(WEEKLYDATA_FILE, 'utf8'));
    return {
      schedule: { ...WEEKLYDATA_DEFAULT.schedule, ...(raw.schedule || {}) },
      tasks:    raw.tasks || {},
    };
  } catch (e) {
    console.warn('[weeklydata] Failed to load weekly data store:', e.message);
    return { ...WEEKLYDATA_DEFAULT };
  }
}

function saveWeeklyData(data) {
  try {
    writeFileSync(WEEKLYDATA_FILE, JSON.stringify(data));
  } catch (e) {
    console.warn('[weeklydata] Failed to persist weekly data store:', e.message);
  }
}

/* ─────────────────────────────────────────────
   GSC OAUTH TOKENS  (persisted so they survive restarts)
───────────────────────────────────────────── */
const GSC_TOKENS_FILE = join(DATA_DIR, '.gsc-tokens.json');
let gscTokens = null;

function loadGscTokens() {
  if (!existsSync(GSC_TOKENS_FILE)) return;
  try { gscTokens = JSON.parse(readFileSync(GSC_TOKENS_FILE, 'utf8')); }
  catch (e) { console.warn('[gsc] Failed to load tokens:', e.message); }
}

function saveGscTokens(tokens) {
  gscTokens = tokens;
  try { writeFileSync(GSC_TOKENS_FILE, JSON.stringify(tokens)); }
  catch (e) { console.warn('[gsc] Failed to save tokens:', e.message); }
}

async function gscRefreshAccessToken() {
  if (!gscTokens?.refresh_token || !GSC_CLIENT_ID) return false;
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: gscTokens.refresh_token,
        client_id:     GSC_CLIENT_ID,
        client_secret: GSC_CLIENT_SECRET,
      }),
    });
    const d = await r.json();
    if (!d.access_token) return false;
    saveGscTokens({ ...gscTokens, access_token: d.access_token, expiry_date: Date.now() + ((d.expires_in || 3600) * 1000) });
    return true;
  } catch (e) {
    console.warn('[gsc] Token refresh failed:', e.message);
    return false;
  }
}

async function gscApiFetch(url, options = {}) {
  if (!gscTokens?.access_token) return null;
  if ((gscTokens.expiry_date || 0) < Date.now() + 30000) {
    const ok = await gscRefreshAccessToken();
    if (!ok) return null;
  }
  return fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${gscTokens.access_token}`, ...(options.headers || {}) },
  });
}

loadGscTokens();

/* ─────────────────────────────────────────────
   ACTIVITY LOG  (task status change history)
───────────────────────────────────────────── */
const ACTLOG_FILE = join(DATA_DIR, '.activitylog.json');
const ACTLOG_MAX  = 2000;
let   activityLog = [];

function loadActivityLog() {
  if (!existsSync(ACTLOG_FILE)) return;
  try { activityLog = JSON.parse(readFileSync(ACTLOG_FILE, 'utf8')) || []; }
  catch (e) { console.warn('[actlog] load error:', e.message); }
}
function saveActivityLog() {
  try { writeFileSync(ACTLOG_FILE, JSON.stringify(activityLog)); }
  catch (e) { console.warn('[actlog] save error:', e.message); }
}
loadActivityLog();

function createSession() {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL });
  saveSessions();
  return token;
}

function isValidSession(token) {
  const s = sessions.get(token);
  if (!s) return false;
  if (s.expiresAt < Date.now()) { sessions.delete(token); return false; }
  return true;
}

/* ─────────────────────────────────────────────
   CSRF  (single-use tokens, 15-min TTL)
───────────────────────────────────────────── */
const csrfTokens = new Map();        // token → expiresAt

function createCsrf() {
  const token = randomBytes(16).toString('hex');
  csrfTokens.set(token, Date.now() + 15 * 60 * 1000);
  return token;
}

function consumeCsrf(token) {
  const exp = csrfTokens.get(token);
  if (!exp || exp < Date.now()) return false;
  csrfTokens.delete(token);          // single-use — delete immediately
  return true;
}

/* ─────────────────────────────────────────────
   BRUTE-FORCE PROTECTION  (5 attempts → 15 min lockout)
───────────────────────────────────────────── */
const loginAttempts = new Map();     // ip → { count, lockUntil }
const MAX_ATTEMPTS  = 5;
const LOCKOUT_MS    = 15 * 60 * 1000;

function getIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || '0.0.0.0';
}

function isLockedOut(ip) {
  const r = loginAttempts.get(ip);
  if (!r) return false;
  if (r.lockUntil > Date.now()) return true;
  loginAttempts.delete(ip);
  return false;
}

function recordFailedLogin(ip) {
  const r = loginAttempts.get(ip) || { count: 0, lockUntil: 0 };
  r.count++;
  if (r.count >= MAX_ATTEMPTS) r.lockUntil = Date.now() + LOCKOUT_MS;
  loginAttempts.set(ip, r);
}

/* ─────────────────────────────────────────────
   API RATE LIMITING  (40 req/min per session)
───────────────────────────────────────────── */
const apiWindows = new Map();        // token → [timestamps]
const API_WINDOW = 60_000;
const API_LIMIT  = 40;

function isApiRateLimited(token) {
  const now  = Date.now();
  const hits = (apiWindows.get(token) || []).filter(t => now - t < API_WINDOW);
  if (hits.length >= API_LIMIT) return true;
  hits.push(now);
  apiWindows.set(token, hits);
  return false;
}

/* ─────────────────────────────────────────────
   PERIODIC CLEANUP  (prevent memory growth)
───────────────────────────────────────────── */
setInterval(() => {
  const now = Date.now();
  const sessionsSizeBefore = sessions.size;
  for (const [k, v] of sessions)      if (v.expiresAt < now) sessions.delete(k);
  for (const [k, v] of csrfTokens)    if (v < now) csrfTokens.delete(k);
  for (const [k, v] of loginAttempts) if (v.lockUntil && v.lockUntil < now - LOCKOUT_MS) loginAttempts.delete(k);
  if (sessions.size   > 500) sessions.clear();
  if (apiWindows.size > 500) apiWindows.clear();
  if (sessions.size !== sessionsSizeBefore) saveSessions();
}, 60 * 60 * 1000).unref();

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const [k, ...v] = part.split('=');
    if (k) out[k.trim()] = decodeURIComponent(v.join('=').trim());
  });
  return out;
}

function sanitizeBody(obj, depth = 0) {
  if (depth > 4 || typeof obj !== 'object' || obj === null) return obj;
  // Preserve arrays — Object.entries on an array produces {0:…,1:…} which breaks API consumers
  if (Array.isArray(obj)) return obj.map(item => sanitizeBody(item, depth + 1));
  const BANNED = new Set(['__proto__', 'constructor', 'prototype']);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (BANNED.has(k)) continue;
    out[k] = sanitizeBody(v, depth + 1);
  }
  return out;
}

function isValidApiKeyFormat(key) {
  return !key || /^sk-[A-Za-z0-9\-_.]{20,}$/.test(key);
}

function isSecureRequest(req) {
  return req.headers['x-forwarded-proto'] === 'https' || req.secure;
}

/* ─────────────────────────────────────────────
   LOGIN PAGE
───────────────────────────────────────────── */
function loginPage(opts = {}) {
  const { error = false, locked = false, csrf = '' } = opts;
  const msg = locked
    ? 'Too many failed attempts. Please wait 15 minutes before trying again.'
    : error ? 'Invalid username or password.' : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LLAMASEO — Sign In</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@800&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',system-ui,sans-serif;background:#F0F2F7;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border:1px solid #E2E6EF;border-radius:16px;padding:44px 40px;width:100%;max-width:380px;box-shadow:0 4px 32px rgba(67,97,238,.1)}
.brand{display:flex;align-items:center;gap:11px;margin-bottom:32px}
.lm{width:40px;height:40px;background:linear-gradient(135deg,#4361EE,#4CC9F0);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:0 4px 14px rgba(67,97,238,.3);flex-shrink:0}
.bn{font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:#1A1D2E;line-height:1.2}
.bs{font-size:11px;color:#9BA3BF;text-transform:uppercase;letter-spacing:.06em}
h2{font-size:22px;font-weight:700;color:#1A1D2E;margin-bottom:6px}
.hint{font-size:13px;color:#5A6080;margin-bottom:28px}
.err{background:rgba(229,56,59,.08);border:1px solid rgba(229,56,59,.25);border-radius:8px;padding:10px 14px;font-size:13px;color:#E5383B;margin-bottom:20px}
.f{margin-bottom:18px}
label{display:block;font-size:11px;font-weight:600;color:#5A6080;text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px}
input[type=text],input[type=password]{width:100%;padding:10px 14px;border:1px solid #E2E6EF;border-radius:9px;font-size:14px;color:#1A1D2E;background:#F8F9FC;outline:none;transition:border-color .18s,box-shadow .18s;font-family:inherit}
input:focus{border-color:#4361EE;box-shadow:0 0 0 3px rgba(67,97,238,.1);background:#fff}
button{width:100%;padding:12px;background:#4361EE;color:#fff;border:none;border-radius:9px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:0 4px 16px rgba(67,97,238,.3);transition:all .18s;margin-top:4px}
button:hover:not(:disabled){background:#3451d1;box-shadow:0 6px 22px rgba(67,97,238,.4)}
button:disabled{opacity:.45;cursor:not-allowed}
</style>
</head>
<body>
<div class="card">
  <div class="brand" style="justify-content:center">
    <img src="/logo.jpg" alt="LLAMASEO" style="height:64px;width:auto">
  </div>
  <h2>Welcome back</h2>
  <p class="hint">Enter your credentials to access the dashboard.</p>
  ${msg ? `<div class="err">${msg}</div>` : ''}
  <form method="POST" action="/login" autocomplete="on">
    <input type="hidden" name="_csrf" value="${csrf}">
    <div class="f">
      <label for="u">Username</label>
      <input type="text" id="u" name="username" autocomplete="username" required${locked ? ' disabled' : ''} autofocus>
    </div>
    <div class="f">
      <label for="p">Password</label>
      <input type="password" id="p" name="password" autocomplete="current-password" required${locked ? ' disabled' : ''}>
    </div>
    <button type="submit"${locked ? ' disabled' : ''}>Sign In</button>
  </form>
</div>
</body>
</html>`;
}

/* ─────────────────────────────────────────────
   MIDDLEWARE STACK
───────────────────────────────────────────── */
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

/* Security headers — applied to every response */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",   // needed for existing onclick attrs; tighten later
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' https://api.openai.com https://app.pageoptimizer.pro",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  if (isSecureRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

/* Auth guard — everything except /login requires a valid session */
app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/logo.jpg' || req.path === '/xlsx.min.js') return next();
  if (isValidSession(parseCookies(req).sm_auth)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: { message: 'Session expired — please reload the page and sign in again.' } });
  }
  res.redirect('/login');
});

/* Static files served only to authenticated users */
app.use(express.static(join(__dirname, 'public')));

/* ─────────────────────────────────────────────
   LOGIN / LOGOUT
───────────────────────────────────────────── */
app.get('/login', (req, res) => {
  if (isValidSession(parseCookies(req).sm_auth)) return res.redirect('/');
  res.send(loginPage({ csrf: createCsrf() }));
});

app.post('/login', (req, res) => {
  const ip = getIp(req);

  if (isLockedOut(ip)) {
    return res.status(429).send(loginPage({ locked: true, csrf: createCsrf() }));
  }

  const { username = '', password = '', _csrf = '' } = req.body;

  if (!consumeCsrf(_csrf)) {
    return res.status(403).send(loginPage({ error: true, csrf: createCsrf() }));
  }

  if (!AUTH_PASS || username !== AUTH_USER || password !== AUTH_PASS) {
    recordFailedLogin(ip);
    return res.status(401).send(
      loginPage({ error: true, locked: isLockedOut(ip), csrf: createCsrf() })
    );
  }

  loginAttempts.delete(ip);
  const token  = createSession();
  const secure = isSecureRequest(req);
  res.setHeader('Set-Cookie',
    `sm_auth=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 60 * 60}${secure ? '; Secure' : ''}`
  );
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  const token = parseCookies(req).sm_auth;
  if (token) { sessions.delete(token); saveSessions(); }   // server-side invalidation
  res.setHeader('Set-Cookie', 'sm_auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.redirect('/login');
});

/* ─────────────────────────────────────────────
   API MIDDLEWARE  (rate limit + sanitise + key check)
───────────────────────────────────────────── */
function apiGuard(req, res, next) {
  const token = parseCookies(req).sm_auth;
  if (isApiRateLimited(token)) {
    return res.status(429).json({ error: { message: 'Rate limit exceeded — wait a moment and try again.' } });
  }
  const clientKey = req.headers['x-client-key'];
  if (clientKey && !isValidApiKeyFormat(clientKey)) {
    return res.status(400).json({ error: { message: 'Invalid API key format.' } });
  }
  if (typeof req.body === 'object' && req.body !== null) {
    req.body = sanitizeBody(req.body);
  }
  next();
}

/* ─────────────────────────────────────────────
   OPENAI PROXY ROUTES
───────────────────────────────────────────── */
async function proxyOpenAI(url, req, res) {
  const key = OPENAI_KEY || req.headers['x-client-key'];
  if (!key) return res.status(401).json({ error: { message: 'No API key configured.' } });
  try {
    const up = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(req.body),
    });
    res.status(up.status).json(await up.json());
  } catch {
    res.status(502).json({ error: { message: 'Upstream request failed. Try again.' } });
  }
}

app.get('/api/config', (req, res) => res.json({
  hasServerKey: !!OPENAI_KEY,
  hasGcs:       !!(gcs && GCS_BUCKET),
  hasAA:        !!AA_KEY,
  hasPop:       !!POP_KEY,
  commit:       GIT_COMMIT,
}));

/* ─────────────────────────────────────────────
   RANK TRACKER DATA API
   Full-replace GET/POST, mirroring localStorage.setItem
   semantics — client sends the whole object each save.
───────────────────────────────────────────── */
app.get('/api/rankdata', apiGuard, (req, res) => {
  res.json(loadRankData());
});

app.post('/api/rankdata', apiGuard, (req, res) => {
  const { rtData, reports } = req.body || {};
  if (!rtData || typeof rtData !== 'object') {
    return res.status(400).json({ error: { message: 'Missing rtData in request body.' } });
  }
  saveRankData({ rtData, reports: (reports && typeof reports === 'object') ? reports : {} });
  res.json({ ok: true });
});

/* ─────────────────────────────────────────────
   AUDIT DATA  (Indexy — per-client to-do list + checked state)
───────────────────────────────────────────── */
const AUDITDATA_FILE = join(DATA_DIR, '.auditdata.json');
function loadAuditData() {
  if (!existsSync(AUDITDATA_FILE)) return {};
  try { return JSON.parse(readFileSync(AUDITDATA_FILE, 'utf8')); }
  catch { return {}; }
}
function saveAuditData(data) {
  try { writeFileSync(AUDITDATA_FILE, JSON.stringify(data)); }
  catch (e) { console.warn('[auditdata] Failed to persist:', e.message); }
}

app.get('/api/auditdata', apiGuard, (req, res) => res.json(loadAuditData()));

app.post('/api/auditdata', apiGuard, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: { message: 'Invalid body.' } });
  const existing = loadAuditData();
  saveAuditData({ ...existing, ...body });
  res.json({ ok: true });
});

app.get('/api/weeklydata', apiGuard, (req, res) => {
  res.json(loadWeeklyData());
});

app.post('/api/weeklydata', apiGuard, (req, res) => {
  const { schedule, tasks } = req.body || {};
  if (!schedule || typeof schedule !== 'object') {
    return res.status(400).json({ error: { message: 'Missing schedule in request body.' } });
  }
  saveWeeklyData({ schedule, tasks: (tasks && typeof tasks === 'object') ? tasks : {} });
  res.json({ ok: true });
});

/* ─────────────────────────────────────────────
   PAGE OPTIMIZER PRO PROXY
   POST routes inject apiKey from server env.
   GET routes (polling) forward as-is.
───────────────────────────────────────────── */
/* Public POP locations list — no auth needed, cache in memory */
let popLocationsCache = null;
app.get('/api/pop-locations', apiGuard, async (_req, res) => {
  if (popLocationsCache) return res.json(popLocationsCache);
  try {
    const r = await fetch(`${POP_BASE}/google-search-locations/`);
    popLocationsCache = await r.json();
    res.json(popLocationsCache);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* Public POP languages list — case-sensitive values POP accepts, cache in memory */
let popLanguagesCache = null;
app.get('/api/pop-languages', apiGuard, async (_req, res) => {
  if (popLanguagesCache) return res.json(popLanguagesCache);
  try {
    const r = await fetch(`${POP_BASE}/available-languages/`);
    popLanguagesCache = await r.json();
    res.json(popLanguagesCache);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.use('/api/pop', apiGuard, async (req, res) => {
  if (!POP_KEY) return res.status(503).json({ error: { message: 'POP_API_KEY not configured on this server.' } });
  const popPath = req.path.replace(/^\//, '');
  let url = `${POP_BASE}/${popPath}`;
  try {
    let opts = { method: req.method, headers: { 'Content-Type': 'application/json' } };
    if (req.method === 'POST') {
      // Inject server API key; remove any client-supplied key to prevent leakage in logs
      const { apiKey: _dropped, ...rest } = sanitizeBody(req.body) || {};
      opts.body = JSON.stringify({ ...rest, apiKey: POP_KEY });
    } else {
      // GET polling endpoints require apiKey as a query parameter
      const u = new URL(url);
      u.searchParams.set('apiKey', POP_KEY);
      url = u.toString();
    }
    const r = await fetch(url, opts);
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(502).json({ error: { message: e.message } });
  }
});

/* ─────────────────────────────────────────────
   AGENCY ANALYTICS PROXY
   Forwards the client's POST body to apirequest.app/query
   with Basic auth (base64(:<key>)).
───────────────────────────────────────────── */
app.post('/api/aa', apiGuard, async (req, res) => {
  if (!AA_KEY) return res.status(503).json({ error: { message: 'AA_API_KEY not configured on this server.' } });
  const b64 = Buffer.from(`:${AA_KEY}`).toString('base64');
  try {
    const r = await fetch(AA_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${b64}` },
      body: JSON.stringify(req.body),
    });
    const text = await r.text();
    try {
      res.status(r.status).json(JSON.parse(text));
    } catch {
      res.status(502).json({ error: { message: `AA returned HTTP ${r.status} (non-JSON). Check your API key.` } });
    }
  } catch (e) {
    res.status(502).json({ error: { message: e.message } });
  }
});

app.post('/api/openai/text',   apiGuard, (req, res) => proxyOpenAI('https://api.openai.com/v1/responses', req, res));
app.post('/api/openai/images', apiGuard, (req, res) => proxyOpenAI('https://api.openai.com/v1/images/generations', req, res));
app.post('/api/openai/chat',   apiGuard, (req, res) => proxyOpenAI('https://api.openai.com/v1/chat/completions', req, res));

app.post('/api/indexy/extract', apiGuard, upload.fields([{ name: 'pdf', maxCount: 1 }, { name: 'xlsx', maxCount: 1 }]), async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: { message: 'ANTHROPIC_API_KEY not configured on server.' } });
  const pdfFile  = req.files?.pdf?.[0];
  const xlsxFile = req.files?.xlsx?.[0];
  if (!pdfFile && !xlsxFile) return res.status(400).json({ error: { message: 'Upload at least one file.' } });
  try {
    let pdfText = '';
    if (pdfFile) {
      const pdf = await getDocumentProxy(new Uint8Array(pdfFile.buffer));
      const { text } = await extractText(pdf, { mergePages: true });
      pdfText = text;
    }
    let xlsxText = '';
    if (xlsxFile) {
      const wb = XLSX.read(xlsxFile.buffer, { type: 'buffer' });
      xlsxText = wb.SheetNames.map(name => {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
        return `=== Sheet: ${name} ===\n${csv}`;
      }).join('\n\n');
    }
    const userMessage = [
      pdfText  && `AUDIT REPORT (PDF):\n${pdfText}`,
      xlsxText && `WORKBOOK (XLSX):\n${xlsxText}`,
    ].filter(Boolean).join('\n\n---\n\n');
    const up = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model:      'claude-haiku-4-5',
        max_tokens: 8192,
        system:     INDEXY_SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: userMessage }],
      }),
    });
    res.status(up.status).json(await up.json());
  } catch (e) {
    res.status(502).json({ error: { message: e.message } });
  }
});

/* ─────────────────────────────────────────────
   AHREFS API PROXY
───────────────────────────────────────────── */
app.post('/api/ahrefs', apiGuard, async (req, res) => {
  if (!AHREFS_KEY) return res.status(503).json({ error: 'AHREFS_API_KEY not configured on server.' });
  const { endpoint, params = {} } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  try {
    const u = new URL(`https://api.ahrefs.com/v3/${endpoint.replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
    }
    const r = await fetch(u.href, {
      headers: { 'Authorization': `Bearer ${AHREFS_KEY}`, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    try { res.status(r.status).json(JSON.parse(text)); }
    catch { res.status(r.status).json({ error: text }); }
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/ahrefs/ai', apiGuard, async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured.' });
  const { domain, data } = req.body || {};
  if (!domain || !data) return res.status(400).json({ error: 'domain and data required' });
  const system = `You are a senior SEO strategist analyzing Ahrefs data for a website. Give actionable, specific recommendations an SEO expert would act on — not generic advice. Structure your response with clear sections. Use markdown.`;
  const userMsg = `Analyze this Ahrefs data for ${domain} and provide a comprehensive SEO strategy with specific action items:\n\n${JSON.stringify(data, null, 2)}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 8192, system, messages: [{ role: 'user', content: userMsg }] }),
    });
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/claude/chat', apiGuard, async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: { message: 'ANTHROPIC_API_KEY not configured on server.' } });
  try {
    const up = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify(req.body),
    });
    res.status(up.status).json(await up.json());
  } catch {
    res.status(502).json({ error: { message: 'Upstream request failed. Try again.' } });
  }
});

/* ─────────────────────────────────────────────
   ALT TEXT GENERATOR  — crawl site + Claude
───────────────────────────────────────────── */
const ALT_TEXT_SYSTEM_PROMPT = `You are an SEO specialist generating image alt text for a website.

For each image provided, write a concise (under 125 characters), descriptive alt text that:
- Describes what the image shows based on the filename and page context
- Naturally includes the primary keyword from the page title/H1
- Includes brand name or city/location where relevant
- Never starts with "image of", "photo of", or "picture of"
- For logos: use "{Brand} logo" format
- For decorative spacers, icons, or tracking pixels: return ""

Return ONLY a valid JSON array — no text before or after. Each object:
{"src":"<exact src from input>","page":"<page url>","currentAlt":"<current alt>","issue":"<Missing|Vague|Too long|OK>","recommended":"<your alt text>"}`;

async function crawlForImages(startUrl, maxPages) {
  let base;
  try { base = new URL(startUrl); } catch { throw new Error('Invalid URL'); }
  const visited    = new Set();
  const queue      = [base.href];
  const images     = [];
  const debugPages = [];
  const TIMEOUT    = 8000;
  const UA         = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  while (queue.length && visited.size < maxPages) {
    const pageUrl = queue.shift();
    if (visited.has(pageUrl)) continue;
    visited.add(pageUrl);

    let html = '';
    let pageStatus = 'ok';
    try {
      const r = await fetch(pageUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(TIMEOUT),
        redirect: 'follow',
      });
      if (!r.ok) { pageStatus = `http_${r.status}`; debugPages.push({ url: pageUrl, status: pageStatus, imgs: 0 }); continue; }
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('html')) { pageStatus = `non_html_${ct}`; debugPages.push({ url: pageUrl, status: pageStatus, imgs: 0 }); continue; }
      html = await r.text();
      // Update base to final URL after redirects (handles http→https, www redirects)
      if (visited.size === 1) {
        try { base = new URL(r.url); } catch {}
      }
    } catch (e) { debugPages.push({ url: pageUrl, status: `fetch_error: ${e.message}`, imgs: 0 }); continue; }

    const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || '';
    const h1    = html.match(/<h1[^>]*>([^<]*)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g,'').trim() || '';

    let pageImgCount = 0;
    const imgRe = /<img([^>\/]+)\/?>/gi;
    let m;
    while ((m = imgRe.exec(html)) !== null) {
      const attrs = m[1];
      const src   = attrs.match(/\bdata-lazy-src=["']([^"']+)["']/i)?.[1]
                 || attrs.match(/\bdata-src=["']([^"']+)["']/i)?.[1]
                 || attrs.match(/\bdata-original=["']([^"']+)["']/i)?.[1]
                 || attrs.match(/\bsrc=["']([^"']+)["']/i)?.[1]
                 || '';
      if (!src || src.startsWith('data:') || /\.(svg|ico|gif)$/i.test(src)) continue;
      if (/\bwidth=["']?[12]["']?/i.test(attrs) || /\bheight=["']?[12]["']?/i.test(attrs)) continue;

      const altM = attrs.match(/\balt=["']([^"']*)["']/i);
      const alt  = altM ? altM[1].trim() : null;
      let absUrl;
      try { absUrl = new URL(src, pageUrl).href; } catch { continue; }

      // Classify: missing, vague (no spaces = probably filename), too long, or OK
      const isFilename = alt && /^[\w.\-]+$/.test(alt); // no spaces = just a filename slug
      const issue = alt === null           ? 'Missing'
                  : alt === ''             ? 'Missing'
                  : isFilename             ? 'Vague'
                  : alt.length < 10        ? 'Vague'
                  : alt.length > 125       ? 'Too long'
                  : 'OK';
      if (issue === 'OK') continue;

      pageImgCount++;
      images.push({ page: pageUrl, pageTitle: title, h1, src: absUrl, currentAlt: alt ?? '(missing)', issue });
    }
    debugPages.push({ url: pageUrl, status: 'ok', imgs: pageImgCount });

    // Enqueue internal links
    if (visited.size < maxPages) {
      const linkRe = /href=["']([^"'#?][^"']*?)["']/gi;
      while ((m = linkRe.exec(html)) !== null) {
        try {
          const abs = new URL(m[1], pageUrl);
          if (abs.hostname === base.hostname && !visited.has(abs.href) && !queue.includes(abs.href)) {
            queue.push(abs.href);
          }
        } catch { /* skip */ }
      }
    }
  }
  return { images, debugPages };
}

app.post('/api/alttext/scrape', apiGuard, async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: { message: 'ANTHROPIC_API_KEY not configured.' } });
  const { url, maxPages = 5, clientName = '' } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: { message: 'Valid http/https URL required.' } });

  try {
    const { images, debugPages } = await crawlForImages(url, Math.min(parseInt(maxPages) || 5, 10));

    if (!images.length) {
      return res.json({ images: [], debug: debugPages });
    }

    // Cap at 60 images to stay within Haiku token budget
    const batch = images.slice(0, 60);
    const imgList = batch.map((img, i) =>
      `${i + 1}. src="${img.src}" | page="${img.page}" | pageTitle="${img.pageTitle}" | h1="${img.h1}" | currentAlt="${img.currentAlt}" | issue="${img.issue}" | brand="${clientName}"`
    ).join('\n');

    const up = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 8192,
        system: ALT_TEXT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Generate alt text for these ${batch.length} images:\n\n${imgList}` }],
      }),
    });
    const data = await up.json();
    const text = data.content?.find(b => b.type === 'text')?.text || '[]';

    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = []; }
    res.json({ images: parsed, debug: debugPages, totalFound: images.length });
  } catch (e) {
    res.status(502).json({ error: { message: e.message } });
  }
});

/* Push alt text to WordPress via REST API */
app.post('/api/alttext/push-wp', apiGuard, async (req, res) => {
  const { siteUrl, username, appPassword, images } = req.body || {};
  if (!siteUrl || !username || !appPassword || !Array.isArray(images)) {
    return res.status(400).json({ error: { message: 'siteUrl, username, appPassword and images required.' } });
  }

  const base64  = Buffer.from(`${username}:${appPassword}`).toString('base64');
  const headers = { 'Authorization': `Basic ${base64}`, 'Content-Type': 'application/json' };
  const apiBase = siteUrl.replace(/\/$/, '') + '/wp-json/wp/v2';
  const results = [];

  for (const img of images) {
    if (!img.src || !img.recommended) { results.push({ src: img.src, status: 'skipped' }); continue; }

    const filename = img.src.split('/').pop()?.split('?')[0] || '';
    const searchTerm = filename.replace(/[-_.]/g, ' ').replace(/\.[^.]+$/, '');

    try {
      // Search media library by filename
      const searchUrl = `${apiBase}/media?search=${encodeURIComponent(searchTerm)}&per_page=20&_fields=id,source_url,alt_text`;
      const srRes = await fetch(searchUrl, { headers, signal: AbortSignal.timeout(8000) });
      if (!srRes.ok) { results.push({ src: img.src, status: 'error', detail: `WP API ${srRes.status}` }); continue; }

      const media = await srRes.json();
      // Match by source_url ending (ignore CDN domain differences)
      const match = media.find(m => {
        const mFile = m.source_url?.split('/').pop()?.split('?')[0];
        return mFile === filename;
      });

      if (!match) { results.push({ src: img.src, status: 'not_found', filename }); continue; }

      // Update alt text
      const patchRes = await fetch(`${apiBase}/media/${match.id}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ alt_text: img.recommended }),
        signal: AbortSignal.timeout(8000),
      });
      if (!patchRes.ok) { results.push({ src: img.src, status: 'error', detail: `PATCH ${patchRes.status}` }); continue; }

      results.push({ src: img.src, status: 'updated', id: match.id });
    } catch (e) {
      results.push({ src: img.src, status: 'error', detail: e.message });
    }
  }

  res.json({ results });
});

/* ─────────────────────────────────────────────
   FETCH EXISTING PAGE CONTENT
───────────────────────────────────────────── */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&[a-z]{2,6};/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

app.post('/api/fetch-page', apiGuard, async (req, res) => {
  const { url } = req.body || {};
  if (!url || !/^https?:\/\//i.test(String(url))) {
    return res.status(400).json({ error: 'Valid http/https URL required' });
  }

  // 1. Direct fetch — only accept if meaningful text extracted (skips JS-rendered SPAs)
  try {
    const r = await fetch(String(url), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) {
      const text = htmlToText(await r.text());
      if (text.length > 200) {
        return res.json({ text: text.slice(0, 12000), words: text.split(/\s+/).length, source: 'direct' });
      }
      // Text too short → JS-rendered page, fall through to Jina
    }
  } catch(_) { /* fall through to Jina */ }

  // 2. Jina AI Reader fallback (free, no key, handles JS + bot protection)
  try {
    const jinaUrl = `https://r.jina.ai/${encodeURIComponent(String(url))}`;
    const r = await fetch(jinaUrl, {
      headers: { 'Accept': 'text/plain', 'X-No-Cache': 'true' },
      signal: AbortSignal.timeout(20000),
    });
    if (r.ok) {
      const text = (await r.text()).replace(/\s{2,}/g, ' ').trim();
      return res.json({ text: text.slice(0, 12000), words: text.split(/\s+/).length, source: 'jina' });
    }
    throw new Error(`Jina returned ${r.status}`);
  } catch(e) {
    return res.status(502).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────────
   GCS FOLDER CREATION
───────────────────────────────────────────── */
app.post('/api/gcs/create-folder', apiGuard, async (req, res) => {
  if (!gcs || !GCS_BUCKET) {
    return res.status(503).json({ error: { message: 'GCS not configured on this server.' } });
  }

  const { slug } = sanitizeBody(req.body);
  if (!slug || typeof slug !== 'string') {
    return res.status(400).json({ error: { message: 'slug is required.' } });
  }

  // GCS object name rules: lowercase, letters, numbers, hyphens, max 63 chars
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9\-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  if (!safeSlug) {
    return res.status(400).json({ error: { message: 'Could not derive a valid folder name from slug.' } });
  }

  try {
    const bucket = gcs.bucket(GCS_BUCKET);

    // Create a placeholder object so the folder exists and is publicly readable
    const file = bucket.file(`${safeSlug}/.keep`);
    await file.save('', {
      contentType: 'text/plain',
      predefinedAcl: 'publicRead',
    });

    const url = `https://storage.googleapis.com/${GCS_BUCKET}/${safeSlug}/`;
    res.json({ url, bucket: GCS_BUCKET, folder: safeSlug });
  } catch (e) {
    console.error('[gcs create-folder]', e.message);
    res.status(500).json({ error: { message: `GCS error: ${e.message}` } });
  }
});

/* ─────────────────────────────────────────────
   ACTIVITY LOG ROUTES
───────────────────────────────────────────── */

app.get('/api/activitylog', apiGuard, (req, res) => {
  res.json({ entries: activityLog });
});

app.post('/api/activitylog', apiGuard, (req, res) => {
  const { entries } = req.body || {};
  if (!Array.isArray(entries) || !entries.length)
    return res.status(400).json({ error: 'entries array required' });
  activityLog = [...entries, ...activityLog].slice(0, ACTLOG_MAX);
  saveActivityLog();
  res.json({ ok: true, total: activityLog.length });
});

/* ─────────────────────────────────────────────
   GOOGLE SEARCH CONSOLE API ROUTES
───────────────────────────────────────────── */

app.get('/api/gsc/status', apiGuard, (req, res) => {
  res.json({
    configured: !!(GSC_CLIENT_ID && GSC_CLIENT_SECRET),
    connected:  !!(gscTokens?.refresh_token),
  });
});

app.get('/api/gsc/auth', apiGuard, (req, res) => {
  if (!GSC_CLIENT_ID || !GSC_CLIENT_SECRET)
    return res.status(503).json({ error: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured on server.' });
  const params = new URLSearchParams({
    client_id:     GSC_CLIENT_ID,
    redirect_uri:  `${APP_URL}/api/gsc/callback`,
    response_type: 'code',
    scope:         'https://www.googleapis.com/auth/webmasters.readonly',
    access_type:   'offline',
    prompt:        'consent',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/api/gsc/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`Google OAuth error: ${String(error)}`);
  if (!code)  return res.status(400).send('Missing authorization code');
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     GSC_CLIENT_ID,
        client_secret: GSC_CLIENT_SECRET,
        redirect_uri:  `${APP_URL}/api/gsc/callback`,
        grant_type:    'authorization_code',
      }),
    });
    const d = await r.json();
    if (!d.access_token) {
      console.error('[gsc] callback token error:', JSON.stringify(d));
      return res.status(400).send('Token exchange failed: ' + (d.error_description || d.error || 'unknown'));
    }
    saveGscTokens({
      access_token:  d.access_token,
      refresh_token: d.refresh_token || gscTokens?.refresh_token || null,
      expiry_date:   Date.now() + ((d.expires_in || 3600) * 1000),
    });
    console.log('[gsc] OAuth connected successfully');
    res.redirect('/');
  } catch (e) {
    console.error('[gsc] callback error:', e.message);
    res.status(500).send('OAuth error: ' + e.message);
  }
});

app.post('/api/gsc/disconnect', apiGuard, (req, res) => {
  gscTokens = null;
  try { if (existsSync(GSC_TOKENS_FILE)) rmSync(GSC_TOKENS_FILE); } catch (_) {}
  res.json({ ok: true });
});

app.get('/api/gsc/sites', apiGuard, async (req, res) => {
  if (!gscTokens?.refresh_token) return res.status(401).json({ error: 'Not connected to Google Search Console' });
  try {
    const r = await gscApiFetch('https://www.googleapis.com/webmasters/v3/sites');
    if (!r) return res.status(401).json({ error: 'Token expired — please reconnect' });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    res.json({ sites: (d.siteEntry || []).map(s => ({ url: s.siteUrl, level: s.permissionLevel })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/gsc/queries', apiGuard, async (req, res) => {
  if (!gscTokens?.refresh_token) return res.status(401).json({ error: 'Not connected to Google Search Console' });
  const { siteUrl, startDate, endDate, rowLimit = 500 } = req.body || {};
  if (!siteUrl || !startDate || !endDate) return res.status(400).json({ error: 'Missing params: siteUrl, startDate, endDate' });
  try {
    const encodedSite = encodeURIComponent(siteUrl);
    const r = await gscApiFetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodedSite}/searchAnalytics/query`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ startDate, endDate, dimensions: ['query'], rowLimit: Math.min(Number(rowLimit) || 500, 1000) }),
      }
    );
    if (!r) return res.status(401).json({ error: 'Token expired — please reconnect' });
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    res.json({ rows: d.rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────────
   SPA FALLBACK
───────────────────────────────────────────── */
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`LLAMASEO :${PORT} | key=${OPENAI_KEY ? 'server' : 'client'} | auth=${AUTH_PASS ? 'enabled' : 'DISABLED'}`);
});
