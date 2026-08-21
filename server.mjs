import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'fs';
import { deflateRawSync } from 'zlib';
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
/* Optional fetch proxy for client sites whose firewall challenges datacenter IPs
   (SiteGround Anti-Bot, Sucuri, Cloudflare). A URL template containing {url};
   the encoded target. Only used after a direct fetch comes back as a challenge,
   because these services bill per request. Example:
   https://app.scrapingbee.com/api/v1/?api_key=KEY&url={url} */
const SCHEMA_FETCH_PROXY = process.env.SCHEMA_FETCH_PROXY || null;

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
   EXTENSION PAIRING TOKENS

   The browser extension cannot use the session cookie: sm_auth is
   SameSite=Lax, so it is not sent on a cross-site request from an extension
   origin. It authenticates with a bearer token instead.

   These grant access to /api/ext/* and nothing else. That scope is the whole
   point — a token lives in extension storage on a laptop, so it must never be
   able to reach the rest of the app.
───────────────────────────────────────────── */
const EXTTOKENS_FILE = join(DATA_DIR, '.exttokens.json');
function loadExtTokens() {
  if (!existsSync(EXTTOKENS_FILE)) return {};
  try { return JSON.parse(readFileSync(EXTTOKENS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveExtTokens(data) {
  try { writeFileSync(EXTTOKENS_FILE, JSON.stringify(data)); }
  catch (e) { console.warn('[exttokens] Failed to persist:', e.message); }
}

function createExtToken(label) {
  const token = randomBytes(32).toString('hex');
  const all = loadExtTokens();
  all[token] = { label: String(label || 'Chrome extension').slice(0, 60), createdAt: Date.now(), lastUsedAt: null };
  saveExtTokens(all);
  return token;
}

function extTokenFromRequest(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+([a-f0-9]{64})$/i);
  return m ? m[1].toLowerCase() : '';
}

function isValidExtToken(req) {
  const token = extTokenFromRequest(req);
  if (!token) return false;
  const all = loadExtTokens();
  if (!all[token]) return false;
  // Last-used is what makes an unrecognised token in the list identifiable
  all[token].lastUsedAt = Date.now();
  saveExtTokens(all);
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
/* These two carry whole-site schema payloads and must be mounted BEFORE the
   general parser: body-parser skips a request that is already parsed, so a
   larger limit declared on the route itself never runs and the request dies on
   the 512kb default — after the user has waited out a full crawl. */
app.use('/api/schemadata',         express.json({ limit: '8mb' }));
app.use('/api/ext/schema/report',  express.json({ limit: '8mb' }));
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

/* Auth guard — everything except /login requires a valid session.
   /preview/* is exempt on purpose: POP's crawler is unauthenticated and has to be
   able to read a generated article in order to score it. Access is gated by a
   128-bit unguessable id that expires after PREVIEW_TTL_MS. */
app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/logo.jpg' || req.path === '/xlsx.min.js') return next();
  if (req.path.startsWith('/preview/')) return next();
  if (isValidSession(parseCookies(req).sm_auth)) return next();
  // The extension's bearer token opens /api/ext/* only. This gate runs before
  // every route, so without the exemption the handlers would never be reached.
  if (req.path.startsWith('/api/ext/') && isValidExtToken(req)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: { message: 'Session expired — please reload the page and sign in again.' } });
  }
  res.redirect('/login');
});

/* ─────────────────────────────────────────────
   EXTENSION DOWNLOAD

   Chrome refuses to install a .crx from outside the Web Store, so the artifact
   that is actually useful is a zip the user unpacks and loads. There is no zip
   library among the dependencies and Node ships no zip writer, so here is a
   minimal one — the format is short and the alternative is a dependency carried
   for eight small text files.
───────────────────────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* Store-or-deflate zip of { name → Buffer }. Everything is a small text file,
   so no zip64 and no directory entries are needed. */
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  // A fixed timestamp keeps the download byte-identical between requests
  const dosTime = 0, dosDate = 0x2821;   // 2000-01-01

  for (const [name, raw] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(raw, { level: 9 });
    // Only claim compression when it actually helped
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12); cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cdBuf, end]);
}

/* Everything under the extension directory, recursively, as [zipPath, Buffer].

   Recursive on purpose: the extension is flat today, but the moment someone
   adds icons/ Chrome would reject the unpacked folder for a missing icon while
   the download itself looked perfectly fine. Zip paths always use forward
   slashes regardless of platform. */
function listExtensionFiles(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;              // .DS_Store and friends
    const full = join(dir, name);
    const rel  = prefix ? `${prefix}/${name}` : name;
    const st   = statSync(full);
    if (st.isDirectory())   out.push(...listExtensionFiles(full, rel));
    else if (st.isFile())   out.push([rel, readFileSync(full)]);
  }
  return out;
}

app.get('/api/extension.zip', apiGuard, (req, res) => {
  const dir = join(__dirname, 'extension');
  try {
    // Listed from disk rather than hardcoded, so a file added to the extension
    // ships without anyone remembering to update this.
    const files = listExtensionFiles(dir);
    if (!files.length) throw new Error('no files found');

    const zip = makeZip(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="llamaseo-extension-${GIT_COMMIT}.zip"`);
    res.setHeader('Content-Length', zip.length);
    res.send(zip);
  } catch (e) {
    res.status(500).json({ error: { message: `Could not build the extension download: ${e.message}` } });
  }
});

/* The console collector is the extension's collector plus an auto-run call.
   Serving it from the one file means the console path and the extension can
   never drift apart. */
app.get('/schema-report.js', (req, res) => {
  try {
    const src = readFileSync(join(__dirname, 'extension', 'collector.js'), 'utf8');
    res.type('application/javascript').send(`${src}\n__llamaseoCollectSchema({ download: true });\n`);
  } catch (e) {
    res.status(500).type('text/plain').send(`Could not read the collector: ${e.message}`);
  }
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
  hasAhrefs:    !!AHREFS_KEY,
  commit:       GIT_COMMIT,
  // Whether the JSON data files survive a redeploy. False means DATA_DIR fell
  // back to the app directory, which the platform rebuilds on every deploy —
  // and the activity log, weekly data, audit data and GSC tokens are all
  // server-only, so they are lost each time with no client copy to restore from.
  dataDir:           DATA_DIR,
  persistentStorage: DATA_DIR === '/data',
  activityLogEntries: activityLog.length,
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

/* ─────────────────────────────────────────────
   SCHEMA DATA  (per-client crawl result + generated JSON-LD)
   Same full-replace-by-key shape as /api/auditdata. A crawl plus an AI pass
   takes minutes, so the result has to outlive a tab switch.
───────────────────────────────────────────── */
const SCHEMADATA_FILE = join(DATA_DIR, '.schemadata.json');
function loadSchemaData() {
  if (!existsSync(SCHEMADATA_FILE)) return {};
  try { return JSON.parse(readFileSync(SCHEMADATA_FILE, 'utf8')); }
  catch { return {}; }
}
function saveSchemaData(data) {
  try { writeFileSync(SCHEMADATA_FILE, JSON.stringify(data)); }
  catch (e) { console.warn('[schemadata] Failed to persist:', e.message); }
}

app.get('/api/schemadata', apiGuard, (req, res) => res.json(loadSchemaData()));

/* A 100-page crawl plus 60 generated @graph blocks runs well past the 512kb
   global JSON limit, and a 413 here silently discards a multi-minute crawl and
   a paid AI run — so this one route gets a larger body. */
app.post('/api/schemadata', apiGuard, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: { message: 'Invalid body.' } });
  saveSchemaData({ ...loadSchemaData(), ...body });
  res.json({ ok: true });
});

/* ─────────────────────────────────────────────
   GSC AI REPORTS  (per site + period: audit markdown + ticked to-dos)
   Same full-replace-by-key shape as /api/auditdata.
───────────────────────────────────────────── */
const GSCREPORTS_FILE = join(DATA_DIR, '.gscreports.json');
function loadGscReports() {
  if (!existsSync(GSCREPORTS_FILE)) return {};
  try { return JSON.parse(readFileSync(GSCREPORTS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveGscReports(data) {
  try { writeFileSync(GSCREPORTS_FILE, JSON.stringify(data)); }
  catch (e) { console.warn('[gscreports] Failed to persist:', e.message); }
}

app.get('/api/gscreports', apiGuard, (req, res) => res.json(loadGscReports()));

app.post('/api/gscreports', apiGuard, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: { message: 'Invalid body.' } });
  saveGscReports({ ...loadGscReports(), ...body });
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

/* ─────────────────────────────────────────────
   ARTICLE PREVIEW — temporary public pages for POP re-scoring

   POP scores a live URL, not a blob of text, so to get a real POP score for a
   freshly generated article we host it briefly at an unguessable URL and point
   POP's crawler at it. Kept in memory (single Railway instance) and expired
   aggressively — these are throwaway pages, never user data.
───────────────────────────────────────────── */
const PREVIEW_TTL_MS = 2 * 60 * 60 * 1000;   // 2h — POP finishes a report in minutes
const PREVIEW_MAX    = 50;
const previews = new Map();                   // id → { body, title, expiresAt }

function prunePreviews() {
  const now = Date.now();
  for (const [id, p] of previews) if (p.expiresAt <= now) previews.delete(id);
  // hard cap as a second line of defence against unbounded growth
  while (previews.size > PREVIEW_MAX) previews.delete(previews.keys().next().value);
}

const escHtml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* The client sends markdown, not HTML, and the page is rendered here from a
   fixed tag set. The preview is served from our own origin, so accepting raw
   HTML would be a stored-XSS hole — this way nothing in the article can become
   markup. POP only needs the h1/h2/p structure anyway. */
function renderPreviewHtml(markdown) {
  return String(markdown).split(/\n{2,}/).map(block => {
    const b = block.trim();
    if (!b) return '';
    const h = b.match(/^(#{1,3})\s+(.*)$/s);
    if (h) {
      const lvl = h[1].length;
      return `<h${lvl}>${escHtml(h[2].replace(/\n/g, ' ').trim())}</h${lvl}>`;
    }
    // Real lists stay lists — POP reads per-tag counts, so flattening a bullet
    // block into one paragraph would misrepresent the page it is scoring.
    const rows = b.split('\n').map(r => r.trim()).filter(Boolean);
    if (rows.length && rows.every(r => /^[-*•]\s+/.test(r))) {
      return `<ul>${rows.map(r => `<li>${escHtml(r.replace(/^[-*•]\s+/, ''))}</li>`).join('')}</ul>`;
    }
    return `<p>${escHtml(b.replace(/\n/g, ' '))}</p>`;
  }).filter(Boolean).join('\n');
}

app.post('/api/preview', apiGuard, (req, res) => {
  const { markdown = '', title = 'Article' } = req.body || {};
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return res.status(400).json({ error: { message: 'markdown is required' } });
  }
  if (markdown.length > 200_000) {
    return res.status(413).json({ error: { message: 'Article too large to preview' } });
  }
  prunePreviews();
  const id = randomBytes(16).toString('hex');
  previews.set(id, {
    body: renderPreviewHtml(markdown),
    title: String(title).slice(0, 200),
    expiresAt: Date.now() + PREVIEW_TTL_MS,
  });

  const proto = isSecureRequest(req) ? 'https' : 'http';
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  res.json({ id, url: `${proto}://${host}/preview/${id}`, expiresIn: PREVIEW_TTL_MS });
});

app.get('/preview/:id', (req, res) => {
  prunePreviews();
  const p = previews.get(req.params.id);
  if (!p) return res.status(404).type('html').send('<h1>Preview expired</h1>');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<title>${escHtml(p.title)}</title></head>` +
    `<body>\n${p.body}\n</body></html>`
  );
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

/* Technical-audit prompt. Unlike the strategy prompt (which reasons over link and
   keyword data), this one reads Ahrefs Site Audit crawl issues, so it has to
   prioritise by how many URLs an issue actually touches. The "write the finished
   text" rule mirrors the GSC audit prompt in app.js — a recommendation the reader
   still has to write themselves is not one they can act on. */
const AHREFS_TECHNICAL_PROMPT = `You are a senior technical SEO auditing a website's Ahrefs Site Audit crawl results.

Work only from the crawl data given. Never invent issues that are not in it.

Prioritise by impact × reach: an issue affecting 400 URLs outranks one affecting 3, unless the smaller one blocks indexing. Errors outrank warnings outrank notices.

For each recommendation give:
- **Problem** — what the crawl found, with the affected URL count
- **Why it matters** — the concrete ranking or crawl consequence, not theory
- **Fix** — the specific change, at the template or CMS level where the issue repeats across many URLs
- **Effort** — Low / Medium / High

When the fix is a piece of text the reader would otherwise have to write themselves — a title tag, a meta description, an H1, alt text — write the finished text for them in a fenced block tagged \`paste\`, labelled, directly after the recommendation.

Group under: ## 🔴 CRITICAL, ## 🟡 IMPORTANT, ## 🟢 NICE TO HAVE. Use markdown. Skip any group with nothing in it.`;

const AHREFS_STRATEGY_PROMPT = `You are a senior SEO strategist analyzing Ahrefs data for a website. Give actionable, specific recommendations an SEO expert would act on — not generic advice. Structure your response with clear sections. Use markdown.`;

app.post('/api/ahrefs/ai', apiGuard, async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured.' });
  const { domain, data, mode = 'strategy' } = req.body || {};
  if (!domain || !data) return res.status(400).json({ error: 'domain and data required' });
  const technical = mode === 'technical';
  const system = technical ? AHREFS_TECHNICAL_PROMPT : AHREFS_STRATEGY_PROMPT;
  const userMsg = technical
    ? `Analyze this Ahrefs Site Audit crawl data for ${domain} and give prioritised technical SEO recommendations:\n\n${JSON.stringify(data, null, 2)}`
    : `Analyze this Ahrefs data for ${domain} and provide a comprehensive SEO strategy with specific action items:\n\n${JSON.stringify(data, null, 2)}`;
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

Also recommend an SEO filename for each image:
- Lowercase, words separated by hyphens, no spaces or underscores
- Lead with the primary keyword, then brand or city where relevant
- Keep the original file extension exactly as it appears in the src
- No stopword padding ("the", "a", "of") and no dates or camera codes
- Maximum 60 characters including the extension
- For decorative images (those getting "" alt text): return ""

Return ONLY a valid JSON array — no text before or after. Each object:
{"src":"<exact src from input>","page":"<page url>","currentAlt":"<current alt>","issue":"<Missing|Vague|Too long|OK>","recommended":"<your alt text>","recommendedFilename":"<your filename>"}`;

/* Grade one alt attribute. `null` means the attribute was absent entirely; ''
   means it was present but empty — both are equally missing to a screen reader.
   Shared by the crawler path and the Ahrefs Site Audit path so the two agree. */
function classifyAlt(alt) {
  const isFilename = alt && /^[\w.\-]+$/.test(alt); // no spaces = just a filename slug
  return alt === null     ? 'Missing'
       : alt === ''       ? 'Missing'
       : isFilename       ? 'Vague'
       : alt.length < 10  ? 'Vague'
       : alt.length > 125 ? 'Too long'
       : 'OK';
}

/* Ask Claude for alt text + filename recommendations. Capped at 60 images to stay
   inside the Haiku token budget; callers report `totalFound` so the UI can say how
   many were left out. */
async function recommendAltText(images, clientName = '') {
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
  try { return JSON.parse(text); } catch { return []; }
}

async function crawlForImages(startUrl, maxPages, pastedUrls) {
  let base;
  try { base = new URL(startUrl); } catch { throw new Error('Invalid URL'); }
  const visited    = new Set();
  // Same rule as the schema scan: an explicit page list from the client record
  // replaces discovery outright, so a site whose links cannot be followed is
  // still auditable.
  const pasted     = Array.isArray(pastedUrls)
    ? pastedUrls.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, maxPages)
    : [];
  const fromPasted = pasted.length > 0;
  const queue      = fromPasted ? [...pasted] : [base.href];
  const images     = [];
  const debugPages = [];
  const TIMEOUT    = 8000;
  const UA         = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  // A pasted list raises the cap well past the old 10, and 8s per page serially
  // will outrun the platform's request timeout without a budget — the same
  // reason crawlForSchema has one.
  const deadline = Date.now() + 240000;

  while (queue.length && visited.size < maxPages) {
    if (Date.now() > deadline) break;
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
    // Attributes may contain slashes — src="/img/x.jpg" and src="https://…" both
    // do — so the character class must exclude only '>', not '/'.
    const imgRe = /<img\b([^>]*?)\/?>/gi;
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

      const issue = classifyAlt(alt);
      if (issue === 'OK') continue;

      pageImgCount++;
      images.push({ page: pageUrl, pageTitle: title, h1, src: absUrl, currentAlt: alt ?? '(missing)', issue });
    }
    debugPages.push({ url: pageUrl, status: 'ok', imgs: pageImgCount });

    // Enqueue internal links
    if (!fromPasted && visited.size < maxPages) {
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
  const { url, maxPages = 5, clientName = '', pageUrls = [] } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: { message: 'Valid http/https URL required.' } });

  try {
    // A pasted list lifts the 10-page discovery cap — the user has told us
    // exactly which pages exist, so there is nothing to bound. Count the list
    // the same way the crawler filters it, or an all-invalid list would set a
    // 100-page cap and silently turn into a homepage crawl.
    const usable = Array.isArray(pageUrls)
      ? pageUrls.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u))
      : [];
    const cap = usable.length ? Math.min(usable.length, 100) : Math.min(parseInt(maxPages) || 5, 10);
    const { images, debugPages } = await crawlForImages(url, cap, usable);

    if (!images.length) {
      return res.json({ images: [], debug: debugPages });
    }

    const parsed = await recommendAltText(images, clientName);
    res.json({ images: parsed, debug: debugPages, totalFound: images.length, usedPastedList: usable.length > 0, pagesScanned: cap });
  } catch (e) {
    res.status(502).json({ error: { message: e.message } });
  }
});

/* Recommend alt text for images discovered elsewhere — currently the Ahrefs Site
   Audit page-explorer, which reports every page Ahrefs crawled rather than the ten
   the built-in crawler can reach. Callers supply the raw src/alt pairs; grading and
   the OK-filter happen here so both paths apply identical rules. */
app.post('/api/alttext/recommend', apiGuard, async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: { message: 'ANTHROPIC_API_KEY not configured.' } });
  const { pages, clientName = '' } = req.body || {};
  if (!Array.isArray(pages)) return res.status(400).json({ error: { message: 'pages array required.' } });

  const images = [];
  for (const p of pages) {
    if (!Array.isArray(p?.images)) continue;
    for (const img of p.images) {
      if (!img?.src || /^data:/i.test(img.src) || /\.(svg|ico|gif)(\?|$)/i.test(img.src)) continue;
      // An absent alt attribute must stay null — '' is a deliberate decorative marker
      const alt   = img.alt === undefined || img.alt === null ? null : String(img.alt).trim();
      const issue = classifyAlt(alt);
      if (issue === 'OK') continue;
      images.push({
        page: p.url || '', pageTitle: p.title || '', h1: p.h1 || '',
        src: img.src, currentAlt: alt ?? '(missing)', issue,
      });
    }
  }

  if (!images.length) return res.json({ images: [], totalFound: 0 });

  try {
    const parsed = await recommendAltText(images, clientName);
    res.json({ images: parsed, totalFound: images.length });
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
   SCHEMA AUDIT  — crawl site for JSON-LD + Claude recommendations
───────────────────────────────────────────── */
const SCHEMA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* www-insensitive hostname, matching what ahrefsBareHost does on the client. */
function bareHost(urlOrHost) {
  const s = String(urlOrHost || '').trim();
  try { return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return s.toLowerCase().replace(/^www\./, ''); }
}

/* A firewall challenge is the dangerous failure, because it does not look like
   one: SiteGround, Sucuri and Cloudflare answer 200 with content-type text/html, so
   response passes every check the crawler makes while carrying no markup and no
   links. Parsed as a page it reports "this site has no structured data", which
   is worse than an error — it would have you add schema that already exists.

   Returns null for a normal page, or { reason, ip } when the response is an
   interposed challenge rather than the site. */
function detectBlockedResponse(html, finalUrl, { expectHtml = true } = {}) {
  const full = String(html || '');
  const head = full.slice(0, 4000);
  const lower = head.toLowerCase();

  // A document that parses as a sitemap is the sitemap, whatever words appear in
  // its URLs — otherwise a site listing /blog/sucuri-vs-wordfence/ discards its
  // own sitemap as a challenge.
  if (!expectHtml && /<urlset|<sitemapindex|<loc>/i.test(head)) return null;

  // SiteGround puts the blocked IP in its redirect target, which is the single most
  // useful thing we can report — it names exactly what to whitelist. It may land
  // in the body or, after a redirect, only in the final URL.
  const ip = (head.match(/ipr:(\d{1,3}(?:\.\d{1,3}){3})/)
           || String(finalUrl || '').match(/ipr:(\d{1,3}(?:\.\d{1,3}){3})/))?.[1] || '';

  /* Two tiers, because the two kinds of evidence are not equally trustworthy.

     Structural tokens are machine identifiers that do not occur in English, so
     they can fire on any page regardless of size. Note there is deliberately no
     size cap here: real Cloudflare interstitials ship a lot of JS and routinely
     exceed any threshold worth setting. */
  // sgcaptcha is SiteGround's Anti-Bot AI (sg = SiteGround), not Sucuri — it is
  // hosting-level, so it appears on sites with no security plugin at all and the
  // fix is with the host rather than anything on the site.
  if (/sgcaptcha/i.test(head))                              return { reason: 'SiteGround Anti-Bot challenge', ip, vendor: 'siteground' };
  if (/cloudproxy|sucuri\.net|sucuri_cloudproxy/i.test(head))
                                                            return { reason: 'Sucuri firewall challenge', ip, vendor: 'sucuri' };
  if (/cf-chl|challenge-platform|__cf_chl|cdn-cgi\/challenge/i.test(head))
                                                            return { reason: 'Cloudflare challenge', ip };
  if (/_incap_|distil_r_|incapsula/i.test(head))             return { reason: 'Imperva/Incapsula challenge', ip };

  /* Prose phrases are the untrustworthy tier — "Access Denied" is also a normal
     article title. They only count on a page with essentially no content, which
     is what every challenge is and what no real article is. */
  const textLen = full.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
  if (textLen < 500 &&
      /checking your browser|robot challenge|attention required|access denied|are you a human|enable javascript to continue|verifying you are human/i.test(lower)) {
    return { reason: 'Bot challenge page', ip };
  }

  // The generic interstitial shape: a body that only bounces the browser
  // somewhere else. A real page does not consist solely of a meta refresh.
  const body = full.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || '';
  if (/<meta[^>]+http-equiv=["']?refresh/i.test(head) && body.replace(/<[^>]+>/g, '').trim().length < 40) {
    return { reason: 'Redirect interstitial, not the page', ip };
  }

  /* Deliberately no "empty shell" rule. A client-rendered SPA ships exactly that
     — a small index.html with no h1/p/a — and failing the whole scan on it would
     turn an unprotected client site into a phantom firewall report. An empty
     response is instead visible through the `bytes` field in diagnostics. */
  return null;
}

/* The challenge usually names the IP it blocked, but not every variant does —
   and "whitelist the IP" is useless advice without one. Fall back to asking what
   this server's outbound address actually is. Cached: it does not change between
   requests, and this must never become a per-page lookup. */
let egressIpCache = null;
async function schemaEgressIp() {
  if (egressIpCache !== null) return egressIpCache;
  for (const svc of ['https://api.ipify.org', 'https://icanhazip.com']) {
    try {
      const r = await fetch(svc, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) continue;
      const ip = (await r.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { egressIpCache = ip; return ip; }
    } catch { /* try the next service */ }
  }
  egressIpCache = '';        // asked and failed — do not ask again this process
  return '';
}

/* Fetch HTML, retrying through the configured proxy when the direct response
   turns out to be a firewall challenge. Returns the body plus how it was got, so
   the caller can still report a block when no proxy is configured. */
async function schemaFetchHtml(url, timeout) {
  const opts = {
    headers: { 'User-Agent': SCHEMA_UA, 'Accept': 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  };
  const r = await fetch(url, opts);
  const contentType = r.headers.get('content-type') || '';
  const finalUrl = r.url;

  // Content type first: a non-HTML body is never worth downloading, detecting on,
  // or paying a proxy to retry — the caller only rejects it afterwards anyway.
  if (!contentType.includes('html')) return { ok: r.ok, status: r.status, contentType, html: '', finalUrl, blocked: null, via: 'direct' };

  const html = await r.text();
  // Read the body even on 4xx/5xx. Cloudflare's managed challenge answers 403
  // and most host-level block pages are 403 or 503, so returning early on !ok would
  // miss precisely the challenges this exists to catch.
  const hit = detectBlockedResponse(html, finalUrl);
  if (!hit) return { ok: r.ok, status: r.status, html, contentType, finalUrl, blocked: null, via: 'direct' };
  if (!SCHEMA_FETCH_PROXY) return { ok: r.ok, status: r.status, html, contentType, finalUrl, blocked: hit, via: 'direct' };

  // Direct fetch was challenged and a proxy is configured — retry through it
  try {
    const proxied = SCHEMA_FETCH_PROXY.includes('{url}')
      ? SCHEMA_FETCH_PROXY.replace('{url}', encodeURIComponent(url))
      : SCHEMA_FETCH_PROXY + encodeURIComponent(url);
    const pr = await fetch(proxied, { signal: AbortSignal.timeout(timeout * 3) });
    if (pr.ok) {
      const phtml = await pr.text();
      const phit = detectBlockedResponse(phtml, url);
      if (!phit) return { ok: true, status: 200, html: phtml, contentType: 'text/html', finalUrl: url, blocked: null, via: 'proxy' };
    }
  } catch { /* fall through to reporting the original block */ }
  return { ok: r.ok, status: r.status, html, contentType, finalUrl, blocked: hit, via: 'direct' };
}

/* Every @type in a parsed JSON-LD block. The shape is wildly inconsistent in the
   wild — a bare object, a top-level array, an @graph, nested nodes, and @type
   itself may be a string or an array — so walk the whole tree rather than
   guessing at a depth. */
function collectSchemaTypes(node, out = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectSchemaTypes(n, out, depth + 1);
    return out;
  }
  const t = node['@type'];
  if (typeof t === 'string') out.add(t);
  else if (Array.isArray(t)) t.filter(x => typeof x === 'string').forEach(x => out.add(x));
  for (const [k, v] of Object.entries(node)) {
    if (k === '@type' || !v || typeof v !== 'object') continue;
    collectSchemaTypes(v, out, depth + 1);
  }
  return out;
}

/* Signals the recommender needs to decide which types a page actually earns.
   Deliberately conservative — these gate whether Claude is allowed to emit
   FAQPage, AggregateRating, Offer etc., so a false positive invents markup. */
function extractSchemaSignals(html, text) {
  // Questions must come from headings — scraping every "?" in the body text
  // turns two rhetorical CTAs into an FAQPage. Loose body-text questions are
  // only trusted on a page that also carries an explicit FAQ heading.
  const hasFaqHeading = /<h[1-4][^>]*>[^<]*\b(faq|faqs|frequently asked|common questions)\b/i.test(html);
  const headingQs = [...html.matchAll(/<h[2-5][^>]*>\s*([^<]{10,160}\?)\s*<\/h[2-5]>/gi)].map(m => m[1].trim());
  // Body scraping is a last resort — it re-reads the headings it already found
  // with the surrounding copy glued on. Only reach for it when the headings
  // alone did not yield a real FAQ.
  const bodyQs    = (hasFaqHeading && headingQs.length < 2)
    ? (text.match(/[^.?!]{15,140}\?/g) || []).map(q => q.trim())
    : [];
  const questions = [...new Set([...headingQs, ...bodyQs])].slice(0, 8);

  // Capture the actual value alongside the boolean. A bare `hasAddress:true`
  // tells the model something is there but not what, which forces it to invent
  // the very facts the prompt forbids — so every gate ships its evidence.
  const phone   = html.match(/tel:([+\d\-().\s]{7,20})/i)?.[1]?.trim()
               || text.match(/(\(\d{3}\)\s*\d{3}[-.\s]?\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4}\b)/)?.[1] || '';
  const address = html.match(/<address[^>]*>([\s\S]{5,200}?)<\/address>/i)?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim()
               || text.match(/\b\d{1,5}\s+[A-Z][a-z]+\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Way|Lane|Ln)\b[^.]{0,60}/)?.[0]?.trim() || '';
  // Only trust a rating that sits in review wording *nearby* — the word
  // "reviews" elsewhere on the page is not evidence that "4 out of 5 dentists
  // agree" is an aggregateRating. Two guards: the number must not be followed by
  // a noun ("out of 5 dentists"), and review wording must sit within ~60 chars.
  const ratingRaw = text.match(/\b([1-5](?:\.\d)?)\s*(?:\/|out of)\s*5\b/);
  let rating = '';
  if (ratingRaw) {
    const at     = ratingRaw.index ?? 0;
    const window = text.slice(Math.max(0, at - 30), at + ratingRaw[0].length + 30);
    if (/\b(review|reviews|rating|rated|stars?|testimonial|score|average)\b/i.test(window)) rating = ratingRaw[1];
  }
  // Likewise a currency amount only counts as a price next to price wording —
  // "Save $500" on an article otherwise produced a spurious Offer.
  const priceRaw  = text.match(/(?:\$|USD|CAD|£|€)\s?\d[\d,]*(?:\.\d{2})?/);
  const price     = (priceRaw && /\b(price|pricing|cost|costs|from|starting at|per month|\/mo|fee)\b/i.test(text)) ? priceRaw[0] : '';
  const date    = html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1]
               || text.match(/\b(?:published|posted|updated)\s+(?:on\s+)?([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i)?.[1] || '';
  // A bare "by" alternation matched footer credits ("Designed by Acme Studios")
  // and named the web agency as the article's author.
  const author  = html.match(/rel=["']author["'][^>]*>([^<]{2,60})</i)?.[1]?.trim()
               || html.match(/class=["'][^"']*author[^"']*["'][^>]*>([^<]{2,60})</i)?.[1]?.trim()
               || text.match(/\b(?:written by|author:)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/i)?.[1] || '';
  const hours   = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s*[-–—:]\s*/i.test(text) && /\b\d{1,2}\s*(am|pm)\b/i.test(text)
                  ? (text.match(/\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*[^.]{0,80}\b\d{1,2}\s*(?:am|pm)\b/i)?.[0] || '') : '';

  return {
    hasFaqHeading,
    questions,
    hasBreadcrumb:   /class=["'][^"']*breadcrumb/i.test(html) || /aria-label=["']breadcrumb/i.test(html),
    hasAddress:      !!address,   address,
    hasPhone:        !!phone,     phone,
    hasHours:        !!hours,     hours,
    hasReviews:      !!rating,    rating,
    hasPrice:        !!price,     price,
    // "Step 1" headings only. A bare numbered heading is usually a listicle
    // ("3. Pick a dentist"), and HowTo on a listicle is a rich-result rejection.
    hasSteps:        /<h[2-4][^>]*>\s*step\s*\d/i.test(html),
    hasDate:         !!date,      date,
    hasAuthor:       !!author,    author,
    wordCount:       text ? text.split(/\s+/).filter(Boolean).length : 0,
  };
}

/* Strip tags for signal matching only. Unlike htmlToText() below this is never
   used on the JSON-LD path — that reads the raw html, because htmlToText drops
   every <script> and would delete the markup we came for. */
function schemaPlainText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function parsePageSchema(html, pageUrl) {
  const blocks      = [];
  const parseErrors = [];
  const types       = new Set();

  // Track properties, not just types. An Article's author slot cannot be judged
  // from the presence of an Organization node — Yoast emits one as `publisher`
  // on every post, which would report an author-less BlogPosting as complete.
  const props = { author: false, publisher: false, breadcrumbItems: false };
  const walkProps = (n, d = 0) => {
    if (!n || typeof n !== 'object' || d > 12) return;
    if (Array.isArray(n)) { n.forEach(x => walkProps(x, d + 1)); return; }
    if (n.author)                      props.author = true;
    if (n.publisher)                   props.publisher = true;
    if (Array.isArray(n.itemListElement) && n.itemListElement.length) props.breadcrumbItems = true;
    for (const v of Object.values(n)) if (v && typeof v === 'object') walkProps(v, d + 1);
  };

  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    // Strip the CDATA and HTML-comment wrappers CMSs put around JSON-LD. Yoast
    // and friends emit the JS-comment-prefixed form (`//<![CDATA[` … `//]]>`)
    // and the block-comment form (`/* <![CDATA[ */`), so the marker cannot be
    // assumed to sit at the very start of the line.
    const raw = m[1]
      .replace(/^\s*(?:\/\/|\/\*)?\s*<!\[CDATA\[\s*(?:\*\/)?/, '')
      .replace(/(?:\/\/|\/\*)?\s*\]\]>\s*(?:\*\/)?\s*$/, '')
      .replace(/^\s*<!--/, '')
      .replace(/-->\s*$/, '')
      .trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      collectSchemaTypes(parsed, types);
      walkProps(parsed);
      blocks.push(parsed);
    } catch (e) {
      // A malformed block is a finding, not something to swallow — Google drops
      // the whole script tag when it will not parse.
      parseErrors.push({ snippet: raw.slice(0, 200), message: e.message });
    }
  }

  const text = schemaPlainText(html);
  const attr = (rx) => html.match(rx)?.[1]?.trim() || '';

  return {
    url:       pageUrl,
    title:     attr(/<title[^>]*>([^<]+)<\/title>/i),
    h1:        html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, '').trim() || '',
    metaDesc:  attr(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i),
    canonical: attr(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i),
    ogType:    attr(/<meta[^>]+property=["']og:type["'][^>]+content=["']([^"']*)["']/i),
    types:     [...types],
    props,
    blocks,
    parseErrors,
    signals:   extractSchemaSignals(html, text),
  };
}

/* Seed the crawl from sitemap.xml — a schema audit wants the whole site, and
   link-following from the homepage misses anything not linked from the nav.
   Follows one level of sitemap-index nesting; falls back to BFS when absent. */
async function schemaSitemapUrls(origin, limit, explicitSitemap) {
  const urls = [];
  const seen = new Set();
  const queue = [];
  // Every candidate records what it actually returned. Swallowing these made
  // "no sitemap exists" indistinguishable from "every sitemap was blocked",
  // which is exactly the ambiguity that made this bug hard to see.
  const attempts = [];
  let blocked = null;

  // An explicit sitemap from the client record wins — some sites keep it
  // somewhere the conventional guesses will never find.
  if (explicitSitemap) queue.push(explicitSitemap);
  // robots.txt is the site telling us where its sitemap is, which beats guessing
  try {
    const rb = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': SCHEMA_UA }, signal: AbortSignal.timeout(6000), redirect: 'follow' });
    const rbText = rb.ok ? await rb.text() : '';
    const hit = rb.ok ? detectBlockedResponse(rbText, `${origin}/robots.txt`, { expectHtml: false }) : null;
    if (hit) { blocked = blocked || hit; attempts.push({ url: `${origin}/robots.txt`, outcome: 'blocked' }); }
    else if (!rb.ok) attempts.push({ url: `${origin}/robots.txt`, outcome: `http_${rb.status}` });
    else {
      const found = [...rbText.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map(m => m[1].trim());
      found.forEach(u => queue.push(u));
      attempts.push({ url: `${origin}/robots.txt`, outcome: found.length ? `declared_${found.length}` : 'no_sitemap_directive' });
    }
  } catch (e) { attempts.push({ url: `${origin}/robots.txt`, outcome: `fetch_error: ${e.message}` }); }

  queue.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`, `${origin}/sitemap-index.xml`);
  let indexFollowed = 0;

  while (queue.length && urls.length < limit) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    let xml;
    try {
      const r = await fetch(sm, { headers: { 'User-Agent': SCHEMA_UA }, signal: AbortSignal.timeout(8000), redirect: 'follow' });
      if (!r.ok) { attempts.push({ url: sm, outcome: `http_${r.status}` }); continue; }
      xml = await r.text();
    } catch (e) { attempts.push({ url: sm, outcome: `fetch_error: ${e.message}` }); continue; }

    // A challenge served in place of the sitemap is not "no sitemap"
    const hit = detectBlockedResponse(xml, sm, { expectHtml: false });
    if (hit) { blocked = blocked || hit; attempts.push({ url: sm, outcome: 'blocked' }); continue; }

    const isIndex = /<sitemapindex/i.test(xml);
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(x => x[1]);
    if (!locs.length) { attempts.push({ url: sm, outcome: /<\?xml|<urlset|<sitemapindex/i.test(xml) ? 'no_locs' : 'not_xml' }); continue; }
    attempts.push({ url: sm, outcome: isIndex ? `index_${locs.length}` : `urls_${locs.length}` });
    if (isIndex) {
      // robots.txt may name several indexes, and a Yoast index fans out to
      // post-/page-/local- children, so a single-index cap was too tight. Bound
      // the total documents fetched instead of the nesting depth.
      if (++indexFollowed > 4) continue;
      for (const l of locs.slice(0, 25)) if (!seen.has(l)) queue.push(l);
    } else {
      // Compare bare hosts. The UI hands us a www-stripped domain (ahrefsBareHost)
      // while the sitemap lists canonical www URLs, so an exact match would throw
      // away every entry and silently drop the crawl back to homepage BFS.
      const host = bareHost(origin);
      for (const l of locs) {
        if (urls.length >= limit) break;
        if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|xml|kml|txt|json|css|js)$/i.test(l)) continue;
        // A sitemap can list anything; without this the crawl follows whatever
        // host it names, which the BFS path already refuses to do.
        try { if (bareHost(l) !== host) continue; } catch { continue; }
        if (!urls.includes(l)) urls.push(l);
      }
    }
  }
  return { urls, attempts, blocked };
}

async function crawlForSchema(startUrl, maxPages, explicitSitemap, pastedUrls) {
  let base;
  try { base = new URL(startUrl); } catch { throw new Error('Invalid URL'); }

  const pages      = [];
  const debugPages = [];
  const visited    = new Set();
  const TIMEOUT    = 10000;
  let truncated = false;

  // Sitemap first, homepage-BFS as the fallback / top-up
  let queue = [];
  let sitemapError = '';
  let sitemapAttempts = [];
  // Kept apart on purpose: a blocked sitemap while every page reads fine is not
  // "some pages were blocked", and reporting it as such on a fully successful
  // scan would cry wolf.
  let discoveryBlocked = null;
  let pageBlocked = null;
  // A pasted list is an explicit statement of what the site is, so it wins
  // outright — no sitemap lookup, no link-following, and no homepage seeded in
  // that the user did not ask for.
  const HARD_CAP = 500;
  const pastedAll = Array.isArray(pastedUrls)
    ? pastedUrls.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u))
    : [];
  const pasted = pastedAll.slice(0, HARD_CAP);
  const fromPasted = pasted.length > 0;

  if (fromPasted) {
    queue = [...pasted];
    // The page dropdown bounds *discovery*; an explicit list is not a discovery
    // guess, so scanning 25 of 200 pasted URLs while reporting success would be
    // a silent loss. The list itself is the limit.
    maxPages = pasted.length;
    if (pastedAll.length > HARD_CAP) truncated = true;
  } else {
    try {
      const sm = await schemaSitemapUrls(base.origin, maxPages, explicitSitemap);
      queue = sm.urls;
      sitemapAttempts = sm.attempts;
      discoveryBlocked = sm.blocked;
    } catch (e) { sitemapError = e.message; }
  }
  const fromSitemap = !fromPasted && queue.length > 0;
  const sitemapCount = queue.length;
  if (!fromPasted && !queue.includes(base.href)) queue.unshift(base.href);

  // 100 pages at 10s apiece would run ~17 minutes and the platform proxy drops
  // the request long before that. Stop at the budget and return what we have.
  // The clock starts here, after sitemap discovery — starting it earlier let a
  // slow sitemap consume the budget and return zero pages.
  const deadline = Date.now() + 240000;

  /* Adaptive bot protection (SiteGround's, Cloudflare's) scores requests as they
     arrive, so a burst of sequential hits from a datacenter IP is itself the
     thing that trips it — the same URL routinely succeeds moments later at a
     gentler pace. Stay fast on sites that do not care, back off hard on ones
     that do. */
  const sleep  = ms => new Promise(r => setTimeout(r, ms));
  const jitter = () => Math.floor(Math.random() * 150);
  const MIN_DELAY = 120, MAX_DELAY = 3000;
  let delayMs = 150;
  let recovered = 0;          // challenged first, succeeded on a retry
  const ATTEMPTS = 3;

  /* Fetch one page, retrying a challenge before believing it. Retrying here
     rather than in a later sweep keeps link discovery, the deadline and the
     bookkeeping in one place — a deferred sweep could be cut short by the
     deadline and silently drop pages it had not recorded yet, which is the very
     false negative this detection exists to prevent. Every exit path records. */
  async function fetchAndRecord(pageUrl) {
    let firstBlock  = null;     // a positive firewall diagnosis, once seen, is kept
    let lastFailure = null;

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      if (attempt > 1) {
        // The scorer reacts to burst rate, so give it room before trying again
        await sleep(Math.min(MAX_DELAY, 900 * (attempt - 1)) + jitter());
        if (Date.now() > deadline) break;
      }

      let r;
      try {
        r = await schemaFetchHtml(pageUrl, TIMEOUT);
      } catch (e) { lastFailure = `fetch_error: ${e.message}`; continue; }

      // A challenge parses as a perfectly empty page. Recording it as one is how
      // the scan came to report "no structured data" for a fully marked-up site.
      // Checked before the status code, because a challenge is far more useful
      // to report than the 403 it usually arrives with.
      if (r.blocked) {
        firstBlock = firstBlock || r.blocked;
        delayMs = Math.min(MAX_DELAY, Math.round(delayMs * 2));
        continue;
      }
      if (!r.ok) { lastFailure = `http_${r.status}`; continue; }
      // A wrong content type will not change on a retry
      if (!r.contentType.includes('html')) { lastFailure = `non_html_${r.contentType}`; break; }

      delayMs = Math.max(MIN_DELAY, Math.round(delayMs * 0.85));
      const page = parsePageSchema(r.html, pageUrl);
      pages.push(page);
      if (firstBlock) recovered++;
      debugPages.push({
        url: pageUrl, status: 'ok',
        types: page.types.length, invalid: page.parseErrors.length,
        // An empty-shell 200 is invisible without these
        bytes: r.html.length,
        links: (r.html.match(/href=["'][^"'#?]/g) || []).length,
        recoveredOnAttempt: firstBlock ? attempt : undefined,
      });
      return { status: 'ok', html: r.html, finalUrl: r.finalUrl };
    }

    // Every attempt failed. A firewall diagnosis outranks whatever status the
    // later attempts happened to return — a 429 after a positive challenge is
    // still the challenge.
    if (firstBlock) {
      pageBlocked = pageBlocked || firstBlock;
      debugPages.push({ url: pageUrl, status: 'blocked_by_firewall', detail: firstBlock.reason });
      return { status: 'blocked' };
    }
    debugPages.push({ url: pageUrl, status: lastFailure || 'failed' });
    return { status: 'failed' };
  }

  while (queue.length && visited.size < maxPages) {
    if (Date.now() > deadline) { truncated = true; break; }
    const pageUrl = queue.shift();
    if (visited.has(pageUrl)) continue;
    visited.add(pageUrl);

    const got = await fetchAndRecord(pageUrl);
    if (got.status === 'ok' && visited.size === 1) { try { base = new URL(got.finalUrl); } catch {} }

    const html = got.status === 'ok' ? got.html : '';
    // Only crawl links when there was no sitemap to work from
    if (html && !fromSitemap && !fromPasted && visited.size < maxPages) {
      const linkRe = /href=["']([^"'#?][^"']*?)["']/gi;
      let lm;
      while ((lm = linkRe.exec(html)) !== null) {
        try {
          const abs = new URL(lm[1], pageUrl);
          if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|mp4)$/i.test(abs.pathname)) continue;
          // WordPress emits these and they are not pages
          if (/\/(feed|comments\/feed|wp-json|wp-content|wp-admin)\//.test(abs.pathname + '/')) continue;
          // Bare-host compare for the same reason the sitemap path does it: a
          // www redirect otherwise makes every link look off-site.
          if (bareHost(abs.href) === bareHost(base.href) && !visited.has(abs.href) && !queue.includes(abs.href)) queue.push(abs.href);
        } catch { /* skip */ }
      }
    }

    // Throttle after link mining, not before: in crawl mode the queue is empty
    // until this page's links are added, so gating on it beforehand skipped the
    // pause between the first two requests — exactly the burst the backoff is
    // meant to avoid.
    if (queue.length && visited.size < maxPages) await sleep(delayMs + jitter());
  }

  return {
    pages, debug: debugPages,
    source: fromPasted ? 'pasted list' : fromSitemap ? 'sitemap' : 'crawl',
    truncated, remaining: queue.length,
    // Only a page-level block means the audit is missing pages. A discovery-level
    // one is reported separately so a healthy scan is never called blocked.
    blocked: pageBlocked,
    discoveryBlocked,
    // Enough to explain a disappointing crawl without reading the server log
    diagnostics: {
      sitemapUrlsFound: sitemapCount,
      sitemapError,
      sitemapAttempts: sitemapAttempts.slice(0, 12),
      fetched:  debugPages.length,
      failed:   debugPages.filter(d => d.status !== 'ok').length,
      // Pages that were challenged first and came through on a retry — the
      // measure of whether throttling is earning its keep on this site
      recovered,
      // Counted over everything, not over the truncated sample below
      blockedCount: debugPages.filter(d => d.status === 'blocked_by_firewall').length,
      failures: debugPages.filter(d => d.status !== 'ok').slice(0, 5),
    },
  };
}

/* Import a report collected by public/schema-report.js in the user's browser.

   The browser is the one client the site's bot protection lets through, so this
   is the way in for hosts that challenge servers. The report carries reduced
   HTML rather than pre-extracted fields so it runs through the same
   parsePageSchema as a live scan — one implementation, identical results,
   no second definition of what counts as a page's schema drifting out of sync. */
/* Multer rejects an oversized upload by throwing, and with no handler Express
   answers with an HTML error page that the client's r.json() cannot parse —
   surfacing "Unexpected token '<'" instead of saying the file is too big. */
function schemaUploadReport(req, res, next) {
  upload.single('report')(req, res, err => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'That report is larger than the 20MB limit. Re-run the collector with fewer pages.'
      : `Upload failed — ${err.message}`;
    res.status(400).json({ error: { message } });
  });
}

/* Turn a collected report into the same shape a live scan returns. Shared by the
   file-upload route and the extension push, so both produce identical results —
   and both go through parsePageSchema, which is what keeps a collected report
   equivalent to a scan rather than a second opinion about it. */
function schemaReportToScan(report) {
  const pages = [];
  const debugPages = [];
  let skipped = 0;              // malformed entries — counted, never silently dropped
  for (const p of report.pages.slice(0, 500)) {
    if (!p?.url || typeof p.html !== 'string') { skipped++; continue; }
    const page = parsePageSchema(p.html, p.url);
    pages.push(page);
    debugPages.push({
      url: p.url, status: 'ok',
      types: page.types.length, invalid: page.parseErrors.length, bytes: p.html.length,
    });
  }

  return {
    pages, debug: debugPages,
    source: 'imported report',
    // The domain the collector actually ran on, so the caller can catch a report
    // being filed against the wrong record
    reportDomain: report.domain || '',
    truncated: report.pages.length > 500,
    remaining: Math.max(0, report.pages.length - 500),
    blocked: null, discoveryBlocked: null,
    diagnostics: {
      sitemapUrlsFound: pages.length, sitemapError: '', sitemapAttempts: [],
      fetched: debugPages.length, failed: skipped, recovered: 0, blockedCount: 0, failures: [],
      skipped,
      // Pages the collector could not read even from a browser
      importBlocked: Number(report.blocked) || 0,
      importFailed:  Number(report.failed)  || 0,
      generatedAt: report.generatedAt || null,
    },
  };
}

/* Token management, for the signed-in app only (session cookie, not a token —
   a token must never be able to mint another). Full values are returned only at
   creation; the list shows a prefix, which is enough to tell them apart. */
app.get('/api/exttokens', apiGuard, (req, res) => {
  const all = loadExtTokens();
  res.json({
    tokens: Object.entries(all).map(([t, meta]) => ({
      prefix: t.slice(0, 8), label: meta.label, createdAt: meta.createdAt, lastUsedAt: meta.lastUsedAt,
    })),
  });
});

app.post('/api/exttokens', apiGuard, (req, res) => {
  res.json({ token: createExtToken(req.body?.label) });
});

app.delete('/api/exttokens/:prefix', apiGuard, (req, res) => {
  const prefix = String(req.params.prefix || '');
  if (!/^[a-f0-9]{8}$/i.test(prefix)) return res.status(400).json({ error: { message: 'Invalid token id.' } });
  const all = loadExtTokens();
  let removed = 0;
  for (const t of Object.keys(all)) if (t.startsWith(prefix.toLowerCase())) { delete all[t]; removed++; }
  saveExtTokens(all);
  res.json({ ok: true, removed });
});

/* ─────────────────────────────────────────────
   EXTENSION API  (bearer token, see isValidExtToken)
───────────────────────────────────────────── */

/* Name, id and site URL only.

   .rankdata.json holds each client's WordPress application password next to its
   username, and /api/rankdata hands back the whole object. The fields are
   listed explicitly rather than deleted from a copy, so a field added to the
   client record later cannot leak here by default. */
app.get('/api/ext/clients', (req, res) => {
  if (isApiRateLimited(extTokenFromRequest(req))) {
    return res.status(429).json({ error: { message: 'Rate limit exceeded — wait a moment and try again.' } });
  }
  const { rtData } = loadRankData();
  const clients = (rtData?.clients || []).map(c => ({
    id:    String(c.id || ''),
    name:  String(c.name || ''),
    wpUrl: String(c.wpUrl || ''),
  }));
  res.json({ clients });
});

/* Receive a report collected by the extension and file it against a client.
   Writes straight to the schema store, so the app shows it without the user
   handling a file at all. */
app.post('/api/ext/schema/report', (req, res) => {
  if (isApiRateLimited(extTokenFromRequest(req))) {
    return res.status(429).json({ error: { message: 'Rate limit exceeded — wait a moment and try again.' } });
  }
  const { clientId, report } = req.body || {};
  if (!clientId || !report || !Array.isArray(report.pages)) {
    return res.status(400).json({ error: { message: 'clientId and a report with a pages array are required.' } });
  }

  // Never invent a client — a typo would otherwise create a record nothing owns
  const { rtData } = loadRankData();
  const client = (rtData?.clients || []).find(c => String(c.id) === String(clientId));
  if (!client) return res.status(404).json({ error: { message: 'That client no longer exists in LLAMASEO.' } });

  /* A report is only about the site it was collected on. The extension reads
     whichever tab is open, so a report from the wrong tab — LLAMASEO's own
     pages, most easily — must not be filed against a client and overwrite a
     real audit. The popup checks this too; this is the backstop. */
  const want = bareHost(client.wpUrl || '');
  const got  = bareHost(report.domain || '');
  if (want && got && want !== got) {
    return res.status(409).json({
      error: {
        message: `That report was collected on ${got}, but ${client.name} is ${want}. Open the client's site in a tab and collect from there.`,
      },
    });
  }

  const out = schemaReportToScan(report);
  if (!out.pages.length) {
    return res.status(400).json({ error: { message: 'The report contained no readable pages.' } });
  }

  // Carry recommendations forward for URLs that still exist, exactly as the
  // upload path does — a re-collect should not bin paid AI output.
  const store = loadSchemaData();
  const prev  = store[clientId] || {};
  const still = new Set(out.pages.map(p => p.url));
  const recs  = {};
  for (const [url, rec] of Object.entries(prev.recs || {})) if (still.has(url)) recs[url] = rec;

  store[clientId] = {
    domain:    report.domain || prev.domain || '',
    scannedAt: Date.now(),
    source:    'extension',
    // The store keeps no raw blocks; they are only needed to derive types
    pages:     out.pages.map(({ blocks, ...rest }) => rest),
    recs,
  };
  saveSchemaData(store);

  res.json({
    ok: true,
    client: client.name,
    pages: out.pages.length,
    skipped: out.diagnostics.skipped,
    blocked: out.diagnostics.importBlocked,
  });
});

app.post('/api/schema/import', apiGuard, schemaUploadReport, async (req, res) => {
  let report;
  try {
    const raw = req.file ? req.file.buffer.toString('utf8') : req.body?.report;
    report = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return res.status(400).json({ error: { message: `Could not read that file as JSON — ${e.message}` } });
  }
  if (!report || !Array.isArray(report.pages)) {
    return res.status(400).json({ error: { message: 'That does not look like a schema report — expected a JSON file with a "pages" array. Re-run the collector script and upload the file it saves.' } });
  }

  const out = schemaReportToScan(report);
  if (!out.pages.length) {
    return res.status(400).json({ error: { message: 'The report contained no readable pages.' } });
  }
  res.json(out);
});

/* Say what was blocked, by what, and what to do about it — where "what to do"
   differs by vendor, because sending someone to the wrong dashboard to change a
   setting that is not there is worse than saying nothing. */
async function schemaBlockMessage(block) {
  const ip = block.ip || await schemaEgressIp();
  const saw = ip
    ? `It saw this server as ${ip} and served a robot challenge instead of the page. `
    : 'It served a robot challenge instead of the page. ';
  const target = ip ? ip : "this server's outbound IP";
  const elsewhere = 'or run the scan from a computer that browses the site normally.';

  const advice = block.vendor === 'siteground'
    // Stated plainly because the obvious guess is wrong: this is not the
    // Security Optimizer plugin, and uninstalling it changes nothing.
    ? `This runs on SiteGround's servers, not on the site. The Security Optimizer plugin does not control it, so uninstalling that plugin makes no difference, and there is no switch for it in Site Tools. Open a SiteGround support ticket asking them to whitelist ${target} — or to turn off Anti-Bot AI for this domain — ${elsewhere}`
    : block.vendor === 'sucuri'
    ? `Whitelist ${target} in the site's Sucuri firewall (Firewall → Access Control → Whitelist IP), ${elsewhere}`
    : `Whitelist ${target} wherever the site's bot protection is configured, ${elsewhere}`;

  return `Blocked by the site's bot protection — ${block.reason}. ${saw}${advice}`;
}

app.post('/api/schema/scan', apiGuard, async (req, res) => {
  const { url, maxPages = 25, sitemapUrl = '', pageUrls = [] } = req.body || {};
  if (!url || !/^https?:\/\//i.test(String(url))) {
    return res.status(400).json({ error: { message: 'Valid http/https URL required.' } });
  }
  const sm = /^https?:\/\//i.test(String(sitemapUrl)) ? String(sitemapUrl) : '';
  try {
    const out = await crawlForSchema(String(url), Math.min(parseInt(maxPages) || 25, 500), sm, pageUrls);
    // Nothing readable plus a challenge means we never saw the site. Fail loudly
    // rather than returning an empty audit that reads as "this site has no schema".
    const anyBlock = out.blocked || out.discoveryBlocked;
    if (!out.pages.length && anyBlock) {
      return res.status(502).json({
        error: {
          message: await schemaBlockMessage(anyBlock),
          blocked: { ...anyBlock, ip: anyBlock.ip || await schemaEgressIp() },
          diagnostics: out.diagnostics,
        },
      });
    }
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: { message: e.message } });
  }
});

const SCHEMA_SYSTEM_PROMPT = `You are a technical SEO specialist writing advanced schema.org JSON-LD for a client's website.

For each page you are given, output ONE complete JSON-LD block using a single @graph that a developer can paste into the page's <head> with no edits.

STRUCTURE — this is what makes it "advanced":
- One "@context":"https://schema.org" and one "@graph" array. Never emit multiple disconnected blocks.
- Give every node a stable "@id" anchored to the page or site: "{origin}/#organization", "{origin}/#website", "{url}#webpage", "{url}#breadcrumb", "{url}#service", "{url}#article", "{url}#faq".
- Cross-reference nodes by {"@id":"..."} instead of repeating a nested copy of the same entity. A WebPage links to its site via "isPartOf", to the org via "publisher"/"provider", to breadcrumbs via "breadcrumb", and to the primary entity via "mainEntityOfPage"/"about".
- Add "sameAs" on the Organization only for profile URLs actually present in the page signals.
- Include BreadcrumbList built from the URL path segments, with readable names.

TYPE SELECTION by page type:
- homepage → Organization (or LocalBusiness when the business serves a physical area) + WebSite + WebPage + BreadcrumbList
- service  → Service + WebPage + BreadcrumbList, provider referencing the Organization/LocalBusiness node; add FAQPage only when the page really has Q&A
- article  → Article or BlogPosting + WebPage + BreadcrumbList + author node
- contact  → LocalBusiness + ContactPoint + WebPage + BreadcrumbList

NEVER INVENT FACTS. This is the most important rule:
- Each signal ships the evidence next to it — signals.phone, signals.address, signals.hours, signals.rating, signals.price, signals.date, signals.author, signals.questions. Use those exact values verbatim. Never substitute a placeholder, an example, or a value you consider more plausible.
- Only emit aggregateRating / ratingValue when signals.rating is a non-empty string, and use that number. Never invent reviewCount — omit it.
- Only emit price / priceRange / Offer when signals.price is non-empty, and use that value.
- Only emit address / PostalAddress when signals.address is non-empty; put the raw string in streetAddress rather than splitting it into city/region/postcode you cannot verify. Only emit openingHours when signals.hours is non-empty.
- Only emit FAQPage when signals.questions is non-empty, and use those exact questions. Write each answer only from the page's title, h1 and meta description; if you cannot answer a question from those, drop that question.
- Only emit HowTo when signals.hasSteps is true.
- Only emit datePublished / dateModified when signals.date is non-empty, and author when signals.author is non-empty (use that name).
- Leave out telephone, email, geo coordinates, images, logos, social profiles and sameAs entirely unless the value appears in the signals. Do not guess a URL.
- If a fact is not supported by the page title, h1, meta description or a signal value, leave the property out entirely. An omitted property is correct; a fabricated one is a Google penalty.

Also state what is already on the page versus what you added, so the user can see the gap.

Return ONLY a valid JSON array — no prose, no markdown fences, before or after. One object per input page:
{"url":"<exact url from input>","recommendedTypes":["Service","WebPage","BreadcrumbList"],"missing":["<types the page lacks today>"],"rationale":"<2-3 sentences: why these types, what was missing, what you deliberately left out for lack of evidence>","jsonld":"<the complete JSON-LD object as a JSON-encoded string>"}`;

async function recommendSchema(pages, clientName, wpUrl) {
  const out = [];
  // A schema payload is far heavier per page than an alt-text line, so chunk it
  // rather than one-shotting the way recommendAltText does.
  const CHUNK = 6;
  // Ten sequential 16k-token calls can outlast the platform's request timeout,
  // which would throw away every chunk already generated and billed. Stop early
  // and let the caller report what was skipped.
  const deadline = Date.now() + 240000;
  let stopped = 0;

  for (let i = 0; i < pages.length; i += CHUNK) {
    const batch = pages.slice(i, i + CHUNK);
    if (Date.now() > deadline) { stopped += batch.length; continue; }
    const desc = batch.map((p, n) => [
      `PAGE ${n + 1}`,
      `url: ${p.url}`,
      `pageType: ${p.pageType || 'unknown'}`,
      `title: ${p.title || ''}`,
      `h1: ${p.h1 || ''}`,
      `metaDescription: ${p.metaDesc || ''}`,
      `existingTypes: ${(p.types || []).join(', ') || '(none)'}`,
      `signals: ${JSON.stringify(p.signals || {})}`,
    ].join('\n')).join('\n\n');

    // One bad chunk must not discard the chunks already generated (and billed),
    // so every failure mode degrades to per-page error rows.
    try {
      const up = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          // Sonnet, not the Haiku used for alt text — a cross-referenced @graph
          // with correct @id resolution is a materially harder generation task.
          model: 'claude-sonnet-5',
          max_tokens: 16000,
          system: SCHEMA_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `Client: ${clientName || '(unknown)'}\nSite: ${wpUrl || ''}\n\nGenerate advanced JSON-LD for these ${batch.length} pages:\n\n${desc}` }],
        }),
      });
      const data = await up.json();
      if (!up.ok || data?.error) throw new Error(data?.error?.message || `Anthropic returned ${up.status}`);

      let text = data.content?.find(b => b.type === 'text')?.text || '[]';
      text = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('Model did not return an array');
      out.push(...parsed);
    } catch (e) {
      for (const p of batch) out.push({ url: p.url, error: e.message || 'Generation failed' });
    }
  }
  return { recommendations: out, stopped };
}

app.post('/api/schema/recommend', apiGuard, async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: { message: 'ANTHROPIC_API_KEY not configured.' } });
  const { pages, clientName = '', wpUrl = '' } = req.body || {};
  if (!Array.isArray(pages) || !pages.length) {
    return res.status(400).json({ error: { message: 'pages array required.' } });
  }
  const MAX = 60;
  const batch = pages.slice(0, MAX);
  try {
    const { recommendations, stopped } = await recommendSchema(batch, clientName, wpUrl);
    res.json({
      recommendations,
      // Say so rather than letting the dropped pages disappear without a word
      skipped: Math.max(0, pages.length - MAX) + stopped,
    });
  } catch (e) {
    res.status(502).json({ error: { message: e.message } });
  }
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
   GCS IMAGE UPLOAD
   Stores a generated service-page image and returns a public URL, so the
   Rank Tracker can link to it later instead of persisting megabytes of base64
   in the rank-data blob.
───────────────────────────────────────────── */
app.post('/api/gcs/upload-image', apiGuard, async (req, res) => {
  if (!gcs || !GCS_BUCKET) {
    return res.status(503).json({ error: { message: 'GCS not configured on this server.' } });
  }
  const { dataUrl, filename, folder } = sanitizeBody(req.body) || {};
  if (typeof dataUrl !== 'string') {
    return res.status(400).json({ error: { message: 'dataUrl is required.' } });
  }
  const m = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) {
    return res.status(400).json({ error: { message: 'dataUrl must be a base64 image (jpeg, png or webp).' } });
  }
  const contentType = m[1];
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length > 12 * 1024 * 1024) {
    return res.status(413).json({ error: { message: 'Image too large (max 12MB).' } });
  }

  const ext = contentType === 'image/jpeg' ? 'jpg' : contentType === 'image/webp' ? 'webp' : 'png';
  const safeName = String(filename || 'image')
    .toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9\-]/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 80) || 'image';
  const safeFolder = String(folder || 'service-images')
    .toLowerCase().replace(/[^a-z0-9\-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'service-images';
  // A short random suffix keeps re-generations from silently overwriting each other
  const objectName = `${safeFolder}/${safeName}-${randomBytes(4).toString('hex')}.${ext}`;

  try {
    const file = gcs.bucket(GCS_BUCKET).file(objectName);
    await file.save(buffer, { contentType, predefinedAcl: 'publicRead', resumable: false });
    res.json({ url: `https://storage.googleapis.com/${GCS_BUCKET}/${objectName}`, object: objectName });
  } catch (e) {
    console.error('[gcs upload-image]', e.message);
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
