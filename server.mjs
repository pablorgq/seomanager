import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY || null;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(__dirname, 'public')));

/* ── CONFIG: tells the frontend whether a server-side key is set ── */
app.get('/api/config', (req, res) => {
  res.json({ hasServerKey: !!OPENAI_KEY });
});

/* ── TEXT PROXY → OpenAI /v1/responses ── */
app.post('/api/openai/text', async (req, res) => {
  const key = OPENAI_KEY || req.headers['x-client-key'];
  if (!key) return res.status(401).json({ error: { message: 'No API key configured on server. Enter your key in Settings.' } });
  try {
    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify(req.body)
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(502).json({ error: { message: `Proxy error: ${e.message}` } });
  }
});

/* ── IMAGE PROXY → OpenAI /v1/images/generations ── */
app.post('/api/openai/images', async (req, res) => {
  const key = OPENAI_KEY || req.headers['x-client-key'];
  if (!key) return res.status(401).json({ error: { message: 'No API key configured on server. Enter your key in Settings.' } });
  try {
    const upstream = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify(req.body)
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(502).json({ error: { message: `Proxy error: ${e.message}` } });
  }
});

/* ── CHAT PROXY → OpenAI /v1/chat/completions ── */
app.post('/api/openai/chat', async (req, res) => {
  const key = OPENAI_KEY || req.headers['x-client-key'];
  if (!key) return res.status(401).json({ error: { message: 'No API key configured on server. Enter your key in Settings.' } });
  try {
    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify(req.body)
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(502).json({ error: { message: `Proxy error: ${e.message}` } });
  }
});

app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`SEO Manager running on port ${PORT}${OPENAI_KEY ? ' (server API key active)' : ' (no server key — client key required)'}`);
});
