import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

const OPENAI_KEY = process.env.OPENAI_API_KEY || null;
const AUTH_USER  = process.env.AUTH_USER || 'pablo';
const AUTH_PASS  = process.env.AUTH_PASS || 'reateguijara';
const AUTH_TOKEN = Buffer.from(`${AUTH_USER}:${AUTH_PASS}:sm2025`).toString('base64');

/* ── Cookie parser (no extra dependency) ── */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(part => {
    const [k, ...v] = part.split('=');
    if (k) out[k.trim()] = decodeURIComponent(v.join('=').trim());
  });
  return out;
}

/* ── Login page HTML ── */
function loginPage(error = false) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SEO Manager — Sign In</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@800&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',system-ui,sans-serif;background:#F0F2F7;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border:1px solid #E2E6EF;border-radius:16px;padding:44px 40px;width:100%;max-width:380px;box-shadow:0 4px 32px rgba(67,97,238,.1)}
.brand{display:flex;align-items:center;gap:11px;margin-bottom:32px}
.logo-mark{width:40px;height:40px;background:linear-gradient(135deg,#4361EE,#4CC9F0);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:0 4px 14px rgba(67,97,238,.3);flex-shrink:0}
.brand-name{font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:#1A1D2E;line-height:1.2}
.brand-sub{font-size:11px;color:#9BA3BF;text-transform:uppercase;letter-spacing:.06em}
h2{font-size:22px;font-weight:700;color:#1A1D2E;margin-bottom:6px}
.hint{font-size:13px;color:#5A6080;margin-bottom:28px}
.error-msg{background:rgba(229,56,59,.08);border:1px solid rgba(229,56,59,.25);border-radius:8px;padding:10px 14px;font-size:13px;color:#E5383B;margin-bottom:20px}
.field{margin-bottom:18px}
label{display:block;font-size:11px;font-weight:600;color:#5A6080;text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px}
input{width:100%;padding:10px 14px;border:1px solid #E2E6EF;border-radius:9px;font-size:14px;color:#1A1D2E;background:#F8F9FC;outline:none;transition:border-color .18s,box-shadow .18s;font-family:inherit}
input:focus{border-color:#4361EE;box-shadow:0 0 0 3px rgba(67,97,238,.1);background:#fff}
button{width:100%;padding:12px;background:#4361EE;color:#fff;border:none;border-radius:9px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:0 4px 16px rgba(67,97,238,.3);transition:all .18s;margin-top:4px}
button:hover{background:#3451d1;box-shadow:0 6px 22px rgba(67,97,238,.4);transform:translateY(-1px)}
button:active{transform:translateY(0)}
</style>
</head>
<body>
<div class="card">
  <div class="brand">
    <div class="logo-mark">⚡</div>
    <div>
      <div class="brand-name">SEO Manager</div>
      <div class="brand-sub">Sign in to continue</div>
    </div>
  </div>
  <h2>Welcome back</h2>
  <p class="hint">Enter your credentials to access the dashboard.</p>
  ${error ? '<div class="error-msg">Invalid username or password. Please try again.</div>' : ''}
  <form method="POST" action="/login">
    <div class="field">
      <label for="u">Username</label>
      <input type="text" id="u" name="username" autocomplete="username" required autofocus>
    </div>
    <div class="field">
      <label for="p">Password</label>
      <input type="password" id="p" name="password" autocomplete="current-password" required>
    </div>
    <button type="submit">Sign In</button>
  </form>
</div>
</body>
</html>`;
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

/* ── Auth middleware — protects everything except /login ── */
app.use((req, res, next) => {
  if (req.path === '/login') return next();
  const cookies = parseCookies(req);
  if (cookies.sm_auth === AUTH_TOKEN) return next();
  res.redirect('/login');
});

/* ── Static files (served only to authenticated users) ── */
app.use(express.static(join(__dirname, 'public')));

/* ── Login routes ── */
app.get('/login', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.sm_auth === AUTH_TOKEN) return res.redirect('/');
  res.send(loginPage(false));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === AUTH_USER && password === AUTH_PASS) {
    const isSecure = req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie',
      `sm_auth=${AUTH_TOKEN}; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}${isSecure ? '; Secure' : ''}`
    );
    return res.redirect('/');
  }
  res.send(loginPage(true));
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sm_auth=; HttpOnly; SameSite=Strict; Max-Age=0');
  res.redirect('/login');
});

/* ── CONFIG ── */
app.get('/api/config', (req, res) => {
  res.json({ hasServerKey: !!OPENAI_KEY });
});

/* ── TEXT PROXY → OpenAI /v1/responses ── */
app.post('/api/openai/text', async (req, res) => {
  const key = OPENAI_KEY || req.headers['x-client-key'];
  if (!key) return res.status(401).json({ error: { message: 'No API key configured.' } });
  try {
    const up = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify(req.body)
    });
    res.status(up.status).json(await up.json());
  } catch (e) { res.status(502).json({ error: { message: `Proxy error: ${e.message}` } }); }
});

/* ── IMAGE PROXY → OpenAI /v1/images/generations ── */
app.post('/api/openai/images', async (req, res) => {
  const key = OPENAI_KEY || req.headers['x-client-key'];
  if (!key) return res.status(401).json({ error: { message: 'No API key configured.' } });
  try {
    const up = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify(req.body)
    });
    res.status(up.status).json(await up.json());
  } catch (e) { res.status(502).json({ error: { message: `Proxy error: ${e.message}` } }); }
});

/* ── CHAT PROXY → OpenAI /v1/chat/completions ── */
app.post('/api/openai/chat', async (req, res) => {
  const key = OPENAI_KEY || req.headers['x-client-key'];
  if (!key) return res.status(401).json({ error: { message: 'No API key configured.' } });
  try {
    const up = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify(req.body)
    });
    res.status(up.status).json(await up.json());
  } catch (e) { res.status(502).json({ error: { message: `Proxy error: ${e.message}` } }); }
});

app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`SEO Manager running on port ${PORT}${OPENAI_KEY ? ' (server key active)' : ''}`);
});
