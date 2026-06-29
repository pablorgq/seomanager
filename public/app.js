/* ── STORE (localStorage) ── */
const Store = {
  get(key)      { return Promise.resolve(localStorage.getItem(key) || null); },
  set(key, val) { localStorage.setItem(key, val); return Promise.resolve(); },
  remove(key)   { localStorage.removeItem(key); return Promise.resolve(); }
};

/* ── CONSTANTS ── */
const OPENAI_TEXT_URL  = '/api/openai/text';
const OPENAI_IMAGE_URL = '/api/openai/images';
const IMAGE_MODELS     = ['gpt-image-1', 'dall-e-3', 'dall-e-2'];

const FRAMING_VARIATIONS = [
  'wide establishing shot of the professional environment',
  'close-up detail of the equipment and tools used',
  'medium shot showing the professional consultation',
  'over-the-shoulder perspective of the practitioner at work',
  'wide shot of the clean modern clinical space',
  'close-up of professional hands performing the treatment',
  'candid moment of patient and practitioner discussing results',
  'product flatlay of professional tools and equipment',
  'environmental shot of the welcoming reception area',
  'detail shot of modern medical technology and devices'
];

const STYLE_MAP = {
  realistic: 'ultra-realistic professional photography, natural lighting, sharp focus, Canon EOS quality, no text',
  editorial: 'editorial magazine photography style, high-end fashion magazine quality, artistic composition, no text',
  lifestyle:  'warm lifestyle photography, golden hour lighting, authentic candid feel, no text',
  clinical:   'clean professional medical photography, bright clinical lighting, sterile atmosphere, no text',
  minimal:    'minimalist composition, clean white background, negative space, studio photography, no text',
  dramatic:   'dramatic moody photography, cinematic lighting, rich shadows, high contrast, no text'
};

const SANITIZE_MAP = [
  [/body contouring/gi, 'non-invasive body sculpting medical treatment'],
  [/liposuction/gi,     'medical body contouring procedure'],
  [/lip filler/gi,      'non-surgical facial enhancement procedure'],
  [/\bbutt\b/gi,        'posterior treatment area'],
  [/\bbreast\b/gi,      'chest area medical treatment'],
  [/\bbikini\b/gi,      'lower treatment area'],
  [/\bnude\b/gi,        'natural'],
  [/sensual/gi,         'elegant'],
  [/\bsexy\b/gi,        'confident professional'],
  [/intimate/gi,        'personalized medical']
];

const SAFETY_PREFIX = 'Editorial healthcare photography for a professional medical blog. Fully clothed patients in clinical attire, licensed medical professionals in uniforms, sterile modern medical facility. ';

/* ── STATE ── */
let apiKey = null;
let hasServerKey = false;
let generatedBlogs = [];
let igImages = [];

/* ── INIT ── */
async function init() {
  const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
  hasServerKey = !!cfg.hasServerKey;
  if (hasServerKey) {
    document.getElementById('settingsToggle').style.display = 'none';
  } else {
    apiKey = await Store.get('seomanager_api_key');
    if (apiKey) document.getElementById('apiKeyInput').value = apiKey;
  }
  bindEvents();
}

/* ── EVENTS ── */
function bindEvents() {
  // Settings toggle
  document.getElementById('settingsToggle').addEventListener('click', () => {
    document.getElementById('settingsPanel').classList.toggle('open');
  });

  // Save API key
  document.getElementById('saveKeyBtn').addEventListener('click', async () => {
    const val = document.getElementById('apiKeyInput').value.trim();
    if (!val) return;
    await Store.set('seomanager_api_key', val);
    apiKey = val;
    document.getElementById('settingsPanel').classList.remove('open');
  });

  // Clear API key
  document.getElementById('clearKeyBtn').addEventListener('click', async () => {
    await Store.remove('seomanager_api_key');
    apiKey = null;
    document.getElementById('apiKeyInput').value = '';
  });

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + tab).classList.add('active');
    });
  });

  // Generate blogs
  document.getElementById('generateBtn').addEventListener('click', handleGenerateBlogs);

  // Export dropdown
  const exportWrap = document.getElementById('exportWrap');
  exportWrap.querySelector('.export-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    exportWrap.querySelector('.export-dropdown').classList.toggle('hidden');
  });
  document.addEventListener('click', () => {
    exportWrap.querySelector('.export-dropdown').classList.add('hidden');
  });
  exportWrap.querySelectorAll('.export-opt').forEach(opt => {
    opt.addEventListener('click', () => exportAll(opt.dataset.fmt));
  });

  // Image generator
  document.getElementById('igGenerateBtn').addEventListener('click', handleGenerateImages);
  document.getElementById('igDownloadAllBtn').addEventListener('click', downloadAllImages);

  // Error close buttons (delegated)
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('error-close')) {
      e.target.closest('.error-banner').classList.add('hidden');
    }
  });
}

/* ── API KEY GUARD ── */
async function getApiKey() {
  if (hasServerKey) return null;
  if (apiKey) return apiKey;
  apiKey = await Store.get('seomanager_api_key');
  if (!apiKey) {
    document.getElementById('settingsPanel').classList.add('open');
    throw new Error('Enter your OpenAI API key in Settings first.');
  }
  return apiKey;
}

/* ── SHOW ERROR ── */
function showError(bannerId, msg) {
  const banner = document.getElementById(bannerId);
  banner.querySelector('.error-text').textContent = msg;
  banner.classList.remove('hidden');
}

/* ── PROGRESS ── */
function setProgress(pct, text) {
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressText').textContent = text;
}
function showProgress() {
  document.getElementById('progressWrap').classList.remove('hidden');
}
function hideProgress() {
  setTimeout(() => document.getElementById('progressWrap').classList.add('hidden'), 1200);
}

/* ═══════════════════════════════════════════════
   BLOG BRANDS TAB
════════════════════════════════════════════════ */
async function handleGenerateBlogs() {
  document.getElementById('brandsError').classList.add('hidden');
  let key;
  try { key = await getApiKey(); } catch(e) { showError('brandsError', e.message); return; }

  const count   = Math.max(1, Math.min(10, parseInt(document.getElementById('blogCount').value) || 3));
  const instr   = document.getElementById('industryInput').value.trim();
  const doImages = document.getElementById('generateImages').checked;

  const btn = document.getElementById('generateBtn');
  btn.disabled = true;
  document.getElementById('cardsGrid').innerHTML = '';
  document.getElementById('exportWrap').style.display = 'none';
  generatedBlogs = [];
  showProgress();
  setProgress(5, 'Crafting blog identities…');

  try {
    const blogs = await generateBlogText(key, count, instr);
    generatedBlogs = blogs;

    const totalSteps = 1 + (doImages ? count * 2 : 0);
    let step = 1;

    setProgress(Math.round((step / totalSteps) * 100), `Building ${count} blog card${count > 1 ? 's' : ''}…`);

    const cards = blogs.map((blog, i) => renderCard(blog, i + 1, doImages));

    if (doImages) {
      for (let i = 0; i < blogs.length; i++) {
        const blog = blogs[i];
        const card = cards[i];

        step++;
        setProgress(Math.round((step / totalSteps) * 100), `Logo for ${blog.blogName}… (${step}/${totalSteps})`);
        await generateCardImage(key, card, blog, 'logo');

        step++;
        setProgress(Math.round((step / totalSteps) * 100), `Hero for ${blog.blogName}… (${step}/${totalSteps})`);
        await generateCardImage(key, card, blog, 'hero');
      }
    } else {
      // Hide image frames if not generating images
      cards.forEach(card => {
        const imagesEl = card.querySelector('.card-images');
        if (imagesEl) imagesEl.style.display = 'none';
      });
    }

    setProgress(100, 'Done ✓');
    hideProgress();
    document.getElementById('exportWrap').style.display = 'flex';
  } catch(e) {
    showError('brandsError', e.message);
    hideProgress();
  } finally {
    btn.disabled = false;
  }
}

/* ── TEXT GENERATION ── */
async function generateBlogText(key, count, instructions) {
  const userPrompt = `Generate ${count} completely unique blog brand identities for: ${instructions || 'a general interest blog'}.

Each blog must have a completely different name, tone, voice, and brand personality. Never reuse phrases.

Return ONLY a valid JSON array with exactly ${count} objects, no markdown, no explanation, no trailing commas:
[
  {
    "blogName": "2-3 word brandable name",
    "blogTitle": "short content focus descriptor",
    "tagline": "under 8 words",
    "aboutUs": "60-80 word authentic paragraph",
    "colorPalette": ["#hex1", "#hex2", "#hex3"],
    "logoPrompt": "40-word DALL-E logo prompt, no text in image",
    "heroPrompt": "40-word DALL-E hero prompt, no text overlay"
  }
]`;

  const textHeaders = { 'Content-Type': 'application/json' };
  if (!hasServerKey && key) textHeaders['x-client-key'] = key;
  const res = await fetch(OPENAI_TEXT_URL, {
    method: 'POST',
    headers: textHeaders,
    body: JSON.stringify({
      model: 'gpt-4o',
      max_output_tokens: 6000,
      instructions: 'You are an SEO content strategist. Return ONLY a valid JSON array, no markdown, no explanation, no trailing commas. Keep aboutUs under 80 words, logoPrompt and heroPrompt under 60 words each.',
      input: userPrompt
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`OpenAI text error ${res.status}: ${err?.error?.message || res.statusText}`);
  }

  const data = await res.json();
  const raw = data?.output?.[0]?.content?.[0]?.text || data?.choices?.[0]?.message?.content || '';
  return parseJsonBlogs(raw);
}

/* ── ROBUST 6-STAGE JSON PARSER ── */
function parseJsonBlogs(raw) {
  let s = raw.trim();

  // Stage 1: strip markdown fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  // Stage 2: direct parse
  try { return JSON.parse(s); } catch(_) {}

  // Stage 3: extract array with regex
  const m = s.match(/\[[\s\S]*\]/);
  if (m) {
    s = m[0];
    // Stage 4: fix trailing commas
    s = s.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}');
    // Stage 5: try again
    try { return JSON.parse(s); } catch(_) {}
  }

  // Stage 6: walk backward until valid
  let attempt = s;
  while (attempt.length > 2) {
    attempt = attempt.slice(0, attempt.lastIndexOf('}')).trim();
    if (!attempt.endsWith(',')) attempt += ']';
    else attempt = attempt.slice(0, -1) + ']';
    try {
      const result = JSON.parse(attempt);
      if (Array.isArray(result) && result.length) return result;
    } catch(_) {}
    if (attempt.endsWith(']')) attempt = attempt.slice(0, -1);
  }

  throw new Error('Failed to parse blog data from AI response. Try again.');
}

/* ── RENDER CARD ── */
function renderCard(blog, num, doImages) {
  const tpl = document.getElementById('cardTemplate');
  const frag = tpl.content.cloneNode(true);
  const card = frag.querySelector('.blog-card');

  // Accent bar gradient from palette
  const p = blog.colorPalette || ['#6C63FF', '#3ECFCF', '#ff6b6b'];
  card.querySelector('.card-accent-bar').style.background =
    `linear-gradient(90deg, ${p[0]}, ${p[1] || p[0]})`;

  // Palette swatches
  card.querySelector('.card-num').textContent = `Blog ${num}`;
  const swatchWrap = card.querySelector('.palette-swatches');
  p.forEach(hex => {
    const s = document.createElement('div');
    s.className = 'palette-swatch';
    s.style.background = hex;
    s.title = hex;
    swatchWrap.appendChild(s);
  });

  // Text fields
  card.querySelector('.card-blog-name').textContent  = blog.blogName  || '';
  card.querySelector('.card-blog-title').textContent = blog.blogTitle || '';
  card.querySelector('.card-tagline').textContent    = blog.tagline   || '';
  card.querySelector('.card-about-us').textContent   = blog.aboutUs   || '';

  // Prompts
  card.querySelector('.prompt-logo-text').textContent = blog.logoPrompt || '';
  card.querySelector('.prompt-hero-text').textContent = blog.heroPrompt || '';

  // Inline copy buttons
  card.querySelectorAll('.btn-copy-inline').forEach(btn => {
    const field = btn.dataset.copy;
    btn.addEventListener('click', () => {
      const val = field === 'name'    ? blog.blogName  :
                  field === 'title'   ? blog.blogTitle :
                  field === 'tagline' ? blog.tagline   :
                  field === 'aboutUs' ? blog.aboutUs   : '';
      copyText(btn, val);
    });
  });

  // Copy prompt buttons
  card.querySelectorAll('.btn-copy-prompt').forEach(btn => {
    const type = btn.dataset.type;
    btn.addEventListener('click', () => {
      copyText(btn, type === 'logo' ? blog.logoPrompt : blog.heroPrompt);
    });
  });

  // Footer buttons
  card.querySelector('.btn-copy-all').addEventListener('click', () => {
    copyText(card.querySelector('.btn-copy-all'), formatBlogText(blog));
  });
  card.querySelector('.btn-copy-json').addEventListener('click', () => {
    const clean = Object.assign({}, blog);
    delete clean._logoDataUrl; delete clean._heroDataUrl;
    copyText(card.querySelector('.btn-copy-json'), JSON.stringify(clean, null, 2));
  });
  card.querySelector('.btn-save-txt').addEventListener('click', () => {
    downloadText(`blog-${slugify(blog.blogName)}.txt`, formatBlogText(blog));
  });

  // Store card reference on blog object for later image injection
  blog._card = card;

  document.getElementById('cardsGrid').appendChild(frag);
  return card;
}

/* ── GENERATE IMAGE FOR CARD ── */
async function generateCardImage(key, card, blog, type) {
  const isLogo = type === 'logo';
  const frame  = card.querySelector(isLogo ? '.img-frame--logo' : '.img-frame--hero');
  const spinner = frame.querySelector('.img-spinner');
  const errEl   = frame.querySelector('.img-error');
  const imgEl   = frame.querySelector('.img-result');
  const actionsEl = frame.querySelector('.img-actions');

  spinner.style.display = 'flex';
  errEl.classList.add('hidden');
  imgEl.classList.add('hidden');

  const prompt = isLogo ? blog.logoPrompt : blog.heroPrompt;
  const size   = isLogo ? '1024x1024' : '1536x1024';

  try {
    const dataUrl = await generateImage(key, prompt, size);
    imgEl.src = dataUrl;
    imgEl.classList.remove('hidden');
    spinner.style.display = 'none';
    actionsEl.classList.remove('hidden');

    if (isLogo) blog._logoDataUrl = dataUrl;
    else        blog._heroDataUrl = dataUrl;

    frame.querySelector('.btn-download').addEventListener('click', () => {
      downloadDataUrl(dataUrl, `${slugify(blog.blogName)}-${type}.png`);
    });
  } catch(e) {
    spinner.style.display = 'none';
    errEl.textContent = `⚠ ${e.message}`;
    errEl.classList.remove('hidden');
  }
}

/* ═══════════════════════════════════════════════
   IMAGE GENERATOR TAB
════════════════════════════════════════════════ */
async function handleGenerateImages() {
  document.getElementById('igError').classList.add('hidden');
  let key;
  try { key = await getApiKey(); } catch(e) { showError('igError', e.message); return; }

  const topic  = document.getElementById('igTopic').value.trim();
  const count  = Math.max(1, Math.min(10, parseInt(document.getElementById('igCount').value) || 4));
  const style  = document.getElementById('igStyle').value;
  const size   = document.getElementById('igSize').value;

  if (!topic) { showError('igError', 'Enter an image topic first.'); return; }

  const btn = document.getElementById('igGenerateBtn');
  btn.disabled = true;
  document.getElementById('igDownloadAllBtn').classList.add('hidden');
  igImages = [];
  const gallery = document.getElementById('igGallery');
  gallery.innerHTML = '';

  // Create placeholder cards
  const cards = Array.from({ length: count }, (_, i) => {
    const card = document.createElement('div');
    card.className = 'ig-card';
    card.innerHTML = `
      <div class="ig-card-img"><div class="spinner"></div></div>
      <div class="ig-card-body">
        <span class="ig-card-num">Image ${i + 1}</span>
        <div class="ig-card-actions"></div>
      </div>`;
    gallery.appendChild(card);
    return card;
  });

  // Generate all images (parallel, capped at 3 concurrent)
  const sanitized = sanitizeTopic(topic);
  const stylePrompt = STYLE_MAP[style] || STYLE_MAP.realistic;

  const tasks = cards.map((card, i) => async () => {
    const framing = FRAMING_VARIATIONS[i % FRAMING_VARIATIONS.length];
    const prompt  = `${SAFETY_PREFIX}${sanitized}. ${framing}. ${stylePrompt}.`;
    const imgDiv  = card.querySelector('.ig-card-img');
    const actions = card.querySelector('.ig-card-actions');

    try {
      const dataUrl = await generateImage(key, prompt, size);
      igImages[i] = { dataUrl, prompt };
      imgDiv.innerHTML = `<img src="${dataUrl}" alt="Image ${i+1}" loading="lazy" />`;
      actions.innerHTML = `
        <button class="btn-sm btn-copy-prompt">Copy Prompt</button>
        <button class="btn-sm btn-download">Download</button>`;
      actions.querySelector('.btn-copy-prompt').addEventListener('click', () => {
        copyText(actions.querySelector('.btn-copy-prompt'), prompt);
      });
      actions.querySelector('.btn-download').addEventListener('click', () => {
        downloadDataUrl(dataUrl, `blog-image-${i + 1}.png`);
      });
    } catch(e) {
      imgDiv.innerHTML = `<div class="img-error">⚠ ${e.message}</div>`;
    }
  });

  // Run with concurrency limit of 3
  await runConcurrent(tasks, 3);

  btn.disabled = false;
  if (igImages.some(Boolean)) {
    document.getElementById('igDownloadAllBtn').classList.remove('hidden');
  }
}

async function runConcurrent(tasks, limit) {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await queue.shift()();
  });
  await Promise.all(workers);
}

function sanitizeTopic(topic) {
  let s = topic;
  for (const [pattern, replacement] of SANITIZE_MAP) s = s.replace(pattern, replacement);
  return s;
}

async function downloadAllImages() {
  for (let i = 0; i < igImages.length; i++) {
    if (igImages[i]) {
      downloadDataUrl(igImages[i].dataUrl, `blog-image-${i + 1}.png`);
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

/* ═══════════════════════════════════════════════
   OPENAI IMAGE GENERATION
════════════════════════════════════════════════ */
async function generateImage(key, prompt, size) {
  for (const model of IMAGE_MODELS) {
    try {
      return await tryModel(key, model, prompt, size);
    } catch(e) {
      const msg = e.message.toLowerCase();
      const isMissing = msg.includes('does not exist') || msg.includes('not found') ||
                        msg.includes('no access') || msg.includes('model_not_found') ||
                        msg.includes('invalid_model');
      if (!isMissing) throw e; // billing / content policy — stop immediately
      // else try next model
    }
  }
  throw new Error('No accessible image model found on this account.');
}

async function tryModel(key, model, prompt, size) {
  let effectiveSize = size;
  if (model === 'dall-e-2') {
    effectiveSize = '1024x1024';
  } else if (model === 'dall-e-3') {
    if (size === '1536x1024') effectiveSize = '1792x1024';
    else if (size === '1024x1536') effectiveSize = '1024x1792';
  }

  const body = { model, prompt, n: 1, size: effectiveSize };
  // DO NOT include response_format — causes "Unknown parameter" error on many tiers

  const imgHeaders = { 'Content-Type': 'application/json' };
  if (!hasServerKey && key) imgHeaders['x-client-key'] = key;
  const res = await fetch(OPENAI_IMAGE_URL, {
    method: 'POST',
    headers: imgHeaders,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`${model} error ${res.status}: ${err?.error?.message || res.statusText}`);
  }

  const data = await res.json();
  const item = data?.data?.[0];
  if (!item) throw new Error(`${model}: no image data in response`);

  if (item.b64_json) {
    return `data:image/png;base64,${item.b64_json}`;
  }
  if (item.url) {
    return await urlToBase64(item.url);
  }
  throw new Error(`${model}: unexpected response format`);
}

async function urlToBase64(imgUrl) {
  const r = await fetch(imgUrl);
  if (!r.ok) throw new Error(`Failed to fetch image: ${r.status}`);
  const buf   = await r.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const CHUNK = 8192;
  let binary  = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

/* ═══════════════════════════════════════════════
   EXPORT
════════════════════════════════════════════════ */
function exportAll(fmt) {
  if (!generatedBlogs.length) return;
  const clean = generatedBlogs.map(b => {
    const c = Object.assign({}, b);
    delete c._logoDataUrl; delete c._heroDataUrl; delete c._card;
    return c;
  });

  if (fmt === 'json') {
    downloadText('blog-brands.json', JSON.stringify(clean, null, 2));
  } else if (fmt === 'csv') {
    const headers = ['blogName','blogTitle','tagline','aboutUs','colorPalette','logoPrompt','heroPrompt'];
    const rows = clean.map(b =>
      headers.map(h => `"${String(b[h] || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`).join(',')
    );
    downloadText('blog-brands.csv', [headers.join(','), ...rows].join('\n'));
  } else if (fmt === 'txt') {
    downloadText('blog-brands.txt', clean.map((b, i) => formatBlogText(b, i + 1)).join('\n\n' + '─'.repeat(60) + '\n\n'));
  }
}

function formatBlogText(blog, num) {
  const lines = [];
  if (num) lines.push(`BLOG ${num}`);
  lines.push(`Blog Name:   ${blog.blogName || ''}`);
  lines.push(`Blog Title:  ${blog.blogTitle || ''}`);
  lines.push(`Tagline:     ${blog.tagline || ''}`);
  lines.push(`Colors:      ${(blog.colorPalette || []).join(', ')}`);
  lines.push('');
  lines.push('About Us:');
  lines.push(blog.aboutUs || '');
  lines.push('');
  lines.push(`Logo Prompt: ${blog.logoPrompt || ''}`);
  lines.push(`Hero Prompt: ${blog.heroPrompt || ''}`);
  return lines.join('\n');
}

/* ═══════════════════════════════════════════════
   UTILITIES
════════════════════════════════════════════════ */
function copyText(btn, text) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.innerHTML;
    btn.innerHTML = btn.innerHTML.replace(/Copy.*/, '✓');
    btn.textContent = '✓';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.innerHTML = orig;
      btn.classList.remove('copied');
    }, 1800);
  }).catch(() => {});
}

function downloadText(filename, content) {
  const a = document.createElement('a');
  a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(content);
  a.download = filename;
  a.click();
}

function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

function slugify(str) {
  return (str || 'blog').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/* ── START ── */
init();
