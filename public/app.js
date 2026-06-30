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
let hasGcs  = false;
let hasPop  = false;
let generatedBlogs = [];
let igImages = [];

/* ── INIT ── */
async function init() {
  const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
  hasServerKey = !!cfg.hasServerKey;
  hasGcs       = !!cfg.hasGcs;
  hasAA        = !!cfg.hasAA;
  hasPop       = !!cfg.hasPop;
  if (hasServerKey) {
    document.getElementById('settingsToggle').style.display = 'none';
  } else {
    apiKey = await Store.get('seomanager_api_key');
    if (apiKey) document.getElementById('apiKeyInput').value = apiKey;
  }
  rtInit();

  // Hide POP key field when key is configured server-side
  if (hasPop) {
    const grp = document.getElementById('ag-popKeyGroup');
    const ind = document.getElementById('ag-popServerInd');
    if (grp) grp.classList.add('hidden');
    if (ind) ind.classList.remove('hidden');
  }

  const popKey = await Store.get('seomanager_pop_key');
  if (popKey) {
    const el = document.getElementById('ag-popKey');
    if (el) el.value = popKey;
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

  if (instr.length > 500) { showError('brandsError', 'Description too long (max 500 characters).'); return; }

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

  // GCS folder creation
  if (hasGcs) {
    const gcsSection = card.querySelector('.card-gcs-section');
    gcsSection.classList.remove('hidden');
    const gcsBtn = card.querySelector('.btn-gcs-create');
    const gcsUrlWrap = card.querySelector('.card-gcs-url');
    const gcsLink = card.querySelector('.gcs-url-link');
    gcsBtn.addEventListener('click', async () => {
      gcsBtn.disabled = true;
      gcsBtn.textContent = 'Creating…';
      try {
        const r = await fetch('/api/gcs/create-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: slugify(blog.blogName) })
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error?.message || `GCS error ${r.status}`);
        blog._gcsUrl = d.url;
        gcsLink.href = d.url;
        gcsLink.textContent = d.url;
        gcsBtn.classList.add('hidden');
        gcsUrlWrap.classList.remove('hidden');
        card.querySelector('.gcs-copy-btn').addEventListener('click', () => {
          copyText(card.querySelector('.gcs-copy-btn'), d.url);
        });
      } catch (e) {
        gcsBtn.textContent = `✕ ${e.message}`.slice(0, 60);
        gcsBtn.disabled = false;
      }
    });
  }

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
  if (topic.length > 500) { showError('igError', 'Topic too long (max 500 characters).'); return; }

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
      const errDiv = document.createElement('div');
      errDiv.className = 'img-error';
      errDiv.textContent = `⚠ ${e.message}`;
      imgDiv.innerHTML = '';
      imgDiv.appendChild(errDiv);
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
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

/* ═══════════════════════════════════════════════
   SEO ARTICLE GENERATOR
════════════════════════════════════════════════ */

const POP_API_DIRECT = 'https://app.pageoptimizer.pro/api';
const POP_API_PROXY  = '/api/pop';
let agSteps = [];
let agTermsData = null;
let agArticleText = '';
let agArticleHtml = '';

function agTogglePw(id, btn) {
  const el = document.getElementById(id);
  el.type = el.type === 'password' ? 'text' : 'password';
  btn.textContent = el.type === 'password' ? 'show' : 'hide';
}

function agLog(msg) {
  const el = document.getElementById('ag-logEl');
  el.textContent = msg;
  el.classList.add('show');
}

function agInitSteps(labels) {
  agSteps = labels.map(l => ({ label: l, state: 'pending', detail: '' }));
  agRenderSteps();
  document.getElementById('ag-progressSection').style.display = 'block';
  document.getElementById('ag-emptyState').style.display = 'none';
  document.getElementById('ag-outputSection').style.display = 'none';
}

function agRenderSteps() {
  const icons = { pending: '○', active: '◎', done: '✓', error: '✗' };
  const container = document.getElementById('ag-stepsEl');
  container.innerHTML = '';
  agSteps.forEach(s => {
    const div = document.createElement('div');
    div.className = `ag-step ${s.state}`;
    const icon = document.createElement('span');
    icon.className = 'ag-step-icon';
    icon.textContent = icons[s.state];
    const text = document.createElement('span');
    text.textContent = s.label + (s.detail ? ' — ' + s.detail : '');
    div.appendChild(icon);
    div.appendChild(text);
    container.appendChild(div);
  });
}

function agSetStep(i, state, detail) {
  agSteps[i].state = state;
  if (detail !== undefined) agSteps[i].detail = detail;
  agRenderSteps();
}

function agShowTermEditors(variations, lsaPhrases) {
  const varList = document.getElementById('ag-varList');
  varList.innerHTML = variations.map(v => {
    const phrase = typeof v === 'string' ? v : (v.phrase || v.variation || String(v));
    return `<label class="ag-term-item">
      <input type="checkbox" checked data-phrase="${escHtml(phrase)}">
      <span class="ag-term-phrase">${escHtml(phrase)}</span>
      <span class="ag-term-badge ag-badge-var">var</span>
    </label>`;
  }).join('');
  document.getElementById('ag-varCount').textContent = `(${variations.length})`;

  const lsiList = document.getElementById('ag-lsiList');
  lsiList.innerHTML = lsaPhrases.map(t => {
    const phrase = t.phrase || String(t);
    const avg = t.averageCount || 0;
    return `<label class="ag-term-item">
      <input type="checkbox" checked data-phrase="${escHtml(phrase)}">
      <span class="ag-term-phrase">${escHtml(phrase)}</span>
      <span class="ag-term-count">avg ${escHtml(String(avg))}</span>
      <span class="ag-term-badge ag-badge-lsi">lsi</span>
    </label>`;
  }).join('');
  document.getElementById('ag-lsiCount').textContent = `(${lsaPhrases.length})`;

  document.getElementById('ag-varEditor').style.display = 'block';
  document.getElementById('ag-lsiEditor').style.display = 'block';
  document.getElementById('ag-continueBtn').style.display = 'flex';
}

function agToggleAll(listId, checked) {
  document.querySelectorAll(`#${listId} input[type=checkbox]`).forEach(cb => cb.checked = checked);
}

function agGetSelected(listId) {
  return [...document.querySelectorAll(`#${listId} input[type=checkbox]:checked`)]
    .map(cb => cb.dataset.phrase);
}

async function agPopPost(path, body) {
  agLog('POST ' + path + '…');
  let url, sendBody;
  if (hasPop) {
    url = POP_API_PROXY + path;
    const { apiKey: _drop, ...rest } = body;  // server injects key — don't send client copy
    sendBody = rest;
  } else {
    url = POP_API_DIRECT + path;
    sendBody = body;
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sendBody)
  });
  const j = await r.json();
  agLog('← ' + r.status + ' ' + JSON.stringify(j).slice(0, 120));
  if (j.status === 'FAILURE') throw new Error('POP: ' + (j.msg || JSON.stringify(j).slice(0, 120)));
  return j;
}

async function agPollTerms(taskId, stepIdx) {
  const base = hasPop ? POP_API_PROXY : POP_API_DIRECT;
  for (let i = 1; i <= 40; i++) {
    await new Promise(r => setTimeout(r, 4000));
    agSetStep(stepIdx, 'active', `attempt ${i}/40`);
    agLog(`Polling terms attempt ${i}`);
    const d = await fetch(`${base}/task/${taskId}/results/`).then(r => r.json());
    agLog(`terms ← ${d.status}${d.value ? ' ' + d.value + '%' : ''}${d.prepareId ? ' → prepareId:' + d.prepareId : ''}`);
    if (d.status === 'FAILURE') throw new Error('get-terms task failed');
    if (d.prepareId) return d;
  }
  throw new Error('get-terms timed out after 40 attempts');
}

async function agPollReport(taskId, stepIdx) {
  const base = hasPop ? POP_API_PROXY : POP_API_DIRECT;
  for (let i = 1; i <= 40; i++) {
    await new Promise(r => setTimeout(r, 4000));
    agSetStep(stepIdx, 'active', `attempt ${i}/40`);
    agLog(`Polling report attempt ${i}`);
    const d = await fetch(`${base}/task/${taskId}/results/`).then(r => r.json());
    agLog(`report ← ${d.status}${d.value ? ' ' + d.value + '%' : ''}${d.report && d.report.id ? ' → id:' + d.report.id : ''}`);
    if (d.status === 'FAILURE') throw new Error('create-report task failed');
    if (d.report && d.report.id) return d;
  }
  throw new Error('create-report timed out after 40 attempts');
}

function agBoldTerms(html, terms) {
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  let result = html;
  sorted.forEach(term => {
    if (!term || term.length < 3) return;
    const safeEsc = escHtml(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`\\b(${safeEsc})\\b`, 'gi'), '<strong>$1</strong>');
  });
  return result;
}

function agRenderArticle(text, terms) {
  let html = escHtml(text);          // escape before injecting any markup
  html = agBoldTerms(html, terms);
  html = html
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>');
  return html.split(/\n\n+/).map(line => {
    line = line.trim();
    if (!line) return '';
    if (line.startsWith('<h')) return line;
    return '<p>' + line.replace(/\n/g, ' ') + '</p>';
  }).filter(Boolean).join('\n');
}

function agRenderScore(score) {
  const num = parseFloat(score) || 0;
  const cls = num >= 80 ? 'good' : num >= 60 ? 'warn' : 'bad';
  const msg = num >= 80 ? 'Target score achieved ✓' : num >= 60 ? 'Needs improvement' : 'Below target — regenerate recommended';
  document.getElementById('ag-scoreBadge').innerHTML =
    `<div class="ag-score-badge ${cls}">POP Score: ${num} / 100 — ${msg}</div>`;
}

async function agStartFlow() {
  const popKey  = hasPop ? '' : document.getElementById('ag-popKey').value.trim();
  const keyword = document.getElementById('ag-keyword').value.trim();
  const targetUrl    = document.getElementById('ag-targetUrl').value.trim() || 'https://example.com';
  const pageNotBuilt = document.getElementById('ag-pageNotBuilt').checked ? 1 : 0;
  const locName  = document.getElementById('ag-locationName').value;
  const targLang = document.getElementById('ag-targetLanguage').value;
  const compRaw  = document.getElementById('ag-competitors').value.trim();

  if (!hasPop && !popKey) { alert('Enter your POP API key.'); return; }
  if (!keyword) { alert('Enter a keyword.');         return; }
  if (keyword.length > 200) { alert('Keyword too long (max 200 characters).'); return; }
  if (!hasServerKey) {
    const k = apiKey || await Store.get('seomanager_api_key');
    if (!k) { alert('Enter your OpenAI API key in Settings first.'); return; }
  }

  if (!hasPop && popKey) await Store.set('seomanager_pop_key', popKey);

  const btn = document.getElementById('ag-genBtn');
  btn.disabled = true;
  btn.textContent = 'Working…';

  document.getElementById('ag-outputSection').style.display = 'none';
  document.getElementById('ag-varEditor').style.display = 'none';
  document.getElementById('ag-lsiEditor').style.display = 'none';
  document.getElementById('ag-continueBtn').style.display = 'none';

  const competitors = compRaw ? compRaw.split('\n').map(s => s.trim()).filter(Boolean) : [];

  agInitSteps([
    'Step 1 — Request POP terms',
    'Step 2 — Poll: terms ready',
    'Step 3 — Review & edit terms ✎',
    'Step 4 — Create POP report',
    'Step 5 — Poll: report ready',
    'Step 6 — Fetch recommendations',
    'Step 7 — Generate article with OpenAI',
  ]);

  try {
    agSetStep(0, 'active');
    const body1 = { apiKey: popKey, keyword, locationName: locName, targetUrl, targetLanguage: targLang };
    if (competitors.length) body1.competitors = competitors;
    const r1 = await agPopPost('/expose/get-terms/', body1);
    const tid1 = r1.taskId || r1.task_id;
    if (!tid1) throw new Error('No taskId from get-terms');
    agSetStep(0, 'done', 'taskId: ' + tid1);

    agSetStep(1, 'active');
    const td = await agPollTerms(tid1, 1);
    agTermsData = td;
    agSetStep(1, 'done', `${td.variations.length} vars · ${td.lsaPhrases.length} LSI`);

    agSetStep(2, 'active', 'review terms below → uncheck brand names → click Continue');
    agShowTermEditors(td.variations, td.lsaPhrases);
    agLog('Terms loaded — uncheck any brand/competitor names, then click Continue.');

    window._agFlow = { popKey, keyword, targetUrl, pageNotBuilt, locName, targLang };

  } catch(e) {
    agLog('ERROR: ' + e.message);
    const ai = agSteps.findIndex(s => s.state === 'active');
    if (ai >= 0) agSetStep(ai, 'error', e.message.slice(0, 130));
    btn.disabled = false;
    btn.textContent = 'Generate SEO Article';
  }
}

async function agContinueWithSelected() {
  const { popKey, keyword, targetUrl, pageNotBuilt, locName, targLang } = window._agFlow;
  const enableNlp = document.getElementById('ag-enableNlp').checked ? 1 : 0;
  const overOpt   = document.getElementById('ag-overOpt').checked ? 1 : 0;
  const strategy  = document.getElementById('ag-strategy').value;
  const approach  = document.getElementById('ag-approach').value;
  const tone      = document.getElementById('ag-tone').value;
  const model     = document.getElementById('ag-oaiModel').value;

  const selectedVars = agGetSelected('ag-varList');
  const selectedLsi  = agGetSelected('ag-lsiList');
  const fullLsa = (agTermsData.lsaPhrases || []).filter(t => selectedLsi.includes(t.phrase || String(t)));

  document.getElementById('ag-continueBtn').style.display = 'none';
  agSetStep(2, 'done', `${selectedVars.length} vars · ${selectedLsi.length} LSI selected`);

  const btn = document.getElementById('ag-genBtn');

  try {
    agSetStep(3, 'active');
    const r4 = await agPopPost('/expose/create-report/', {
      apiKey: popKey, prepareId: agTermsData.prepareId,
      variations: selectedVars, lsaPhrases: fullLsa,
      considerOverOptimization: overOpt, specialLanguageSupport: 0,
      pageNotBuiltYet: pageNotBuilt, googleNlpCalculation: enableNlp
    });
    const tid4 = r4.taskId || r4.task_id;
    if (!tid4) throw new Error('No taskId from create-report');
    agSetStep(3, 'done', 'taskId: ' + tid4);

    agSetStep(4, 'active');
    const rd = await agPollReport(tid4, 4);
    const reportId  = rd.report.id;
    const wcTarget  = (rd.report.wordCount && rd.report.wordCount.target) || 600;
    const h2Target  = rd.report.subHeadingsCount || 3;
    const pageScore = rd.report.pageScore || rd.report.pageScoreValue || '?';
    const cbTerms   = (rd.report.cleanedContentBrief && rd.report.cleanedContentBrief.p) || [];
    const nlpEntities = enableNlp && rd.report.googleNlpSchemaData
      ? (rd.report.googleNlpSchemaData.entities || []).slice(0, 20) : [];
    agSetStep(4, 'done', `reportId:${reportId} · score:${pageScore} · wc:${wcTarget}`);

    agSetStep(5, 'active');
    agLog('Fetching recommendations → reportId: ' + reportId);
    const recResp = await agPopPost('/expose/get-custom-recommendations/', { apiKey: popKey, reportId, strategy, approach });
    const recs = recResp.recommendations || {};
    agSetStep(5, 'done', `exact:${(recs.exactKeyword||[]).length} lsi:${(recs.lsi||[]).length} vars:${(recs.variations||[]).length}`);

    agSetStep(6, 'active');
    const bodyTerms = cbTerms.filter(t => t.contentBrief && t.contentBrief.target > 0).slice(0, 25);
    const termLines = bodyTerms.length > 0
      ? bodyTerms.map(t => `"${t.term.phrase}" (${t.term.type}) → ~${t.contentBrief.target} times`).join('\n')
      : selectedLsi.slice(0, 15).map(p => `"${p}" → ~1 time`).join('\n');
    const titleTerms = ((rd.report.cleanedContentBrief && rd.report.cleanedContentBrief.pageTitle) || [])
      .filter(t => t.contentBrief && t.contentBrief.target > 0).map(t => t.term.phrase);
    const h2Terms = ((rd.report.cleanedContentBrief && rd.report.cleanedContentBrief.subHeadings) || [])
      .filter(t => t.contentBrief && t.contentBrief.target > 0).map(t => t.term.phrase);
    const nlpEntityNames = nlpEntities.map(e => e.name).filter(Boolean);

    const prompt = `You are an expert SEO content writer. Write a high-quality, fully optimised article following these exact specifications:

KEYWORD: "${keyword}"
TARGET WORD COUNT: ~${wcTarget} words
LANGUAGE: ${targLang}
TONE: ${tone}
H2 SUBHEADINGS: ${h2Target}

TITLE MUST INCLUDE: ${titleTerms.length ? titleTerms.join(', ') : keyword}
H2 SUBHEADINGS SHOULD INCLUDE: ${h2Terms.length ? h2Terms.join(', ') : 'relevant variations'}

BODY TERM TARGETS (incorporate naturally at these frequencies):
${termLines}
${nlpEntityNames.length ? '\nGOOGLE NLP ENTITIES (weave in naturally):\n' + nlpEntityNames.join(', ') : ''}

VARIATIONS TO USE NATURALLY: ${selectedVars.join(', ')}

RULES:
- Write one H1 title, ${h2Target} H2 sections, and a brief conclusion
- Every term must appear naturally — never forced or keyword-stuffed
- Write fluent, human-sounding prose a real expert would write
- Do NOT mention SEO, term counts, word counts, or this prompt
- Do NOT use bullet lists — use flowing paragraphs only`;

    agLog(`Calling OpenAI (${model})…`);
    const chatHeaders = { 'Content-Type': 'application/json' };
    if (!hasServerKey) {
      const k = apiKey || await Store.get('seomanager_api_key');
      if (k) chatHeaders['x-client-key'] = k;
    }
    const oaiRes = await fetch('/api/openai/chat', {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({ model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
    });
    if (!oaiRes.ok) {
      const err = await oaiRes.json();
      throw new Error(`OpenAI ${oaiRes.status}: ${err.error?.message || JSON.stringify(err).slice(0, 100)}`);
    }
    const oaiData = await oaiRes.json();
    const articleText = oaiData.choices[0].message.content;
    const wordCount = articleText.split(/\s+/).length;
    agSetStep(6, 'done', `~${wordCount} words · score: ${pageScore}`);
    agLog('Done! Article generated.');

    const allTerms = bodyTerms.map(t => t.term.phrase).concat(selectedVars).concat(selectedLsi).filter(Boolean);

    document.getElementById('ag-outputTitle').textContent = keyword;
    agRenderScore(pageScore);

    document.getElementById('ag-metaCards').innerHTML = [
      { label: 'POP Score',   value: pageScore,       sub: '/ 100 target' },
      { label: 'Word count',  value: wordCount,        sub: `target ~${wcTarget}` },
      { label: 'H2 sections', value: h2Target,         sub: 'recommended' },
      { label: 'Terms used',  value: allTerms.length,  sub: 'POP-recommended' },
    ].map(c => `<div class="ag-meta-card">
      <div class="ag-meta-label">${c.label}</div>
      <div class="ag-meta-value">${escHtml(String(c.value))}</div>
      <div class="ag-meta-sub">${c.sub}</div>
    </div>`).join('');

    agArticleHtml = agRenderArticle(articleText, allTerms);
    agArticleText = articleText;
    document.getElementById('ag-articleBox').innerHTML = agArticleHtml;

    document.getElementById('ag-termsSummary').innerHTML =
      `<strong style="color:var(--text-primary)">Variations:</strong> ${selectedVars.map(escHtml).join(' · ')}<br>` +
      `<strong style="color:var(--text-primary)">LSI terms:</strong> ${selectedLsi.map(escHtml).join(' · ')}`;

    if (nlpEntities.length) {
      const nlpSection = document.getElementById('ag-nlpSection');
      nlpSection.style.display = 'block';
      document.getElementById('ag-nlpChips').innerHTML =
        nlpEntities.map(e => `<span class="ag-nlp-chip" title="${escHtml(e.type || '')}">${escHtml(e.name || '')}</span>`).join('');
    }

    document.getElementById('ag-outputSection').style.display = 'block';
    document.getElementById('ag-outputSection').scrollIntoView({ behavior: 'smooth' });

  } catch(e) {
    agLog('ERROR: ' + e.message);
    const ai = agSteps.findIndex(s => s.state === 'active');
    if (ai >= 0) agSetStep(ai, 'error', e.message.slice(0, 130));
    document.getElementById('ag-continueBtn').style.display = 'flex';
  }

  btn.disabled = false;
  btn.textContent = 'Generate SEO Article';
}

function agCopyArticle() {
  navigator.clipboard.writeText(agArticleText || '').then(() => {
    const b = event.target; const orig = b.textContent;
    b.textContent = 'Copied!';
    setTimeout(() => b.textContent = orig, 1500);
  }).catch(() => {});
}

function agCopyHtml() {
  navigator.clipboard.writeText(agArticleHtml || '').then(() => {
    const b = event.target; const orig = b.textContent;
    b.textContent = 'Copied!';
    setTimeout(() => b.textContent = orig, 1500);
  }).catch(() => {});
}

/* ═══════════════════════════════════════════════
   RANK TRACKER
════════════════════════════════════════════════ */

const RT_KEY = 'seomanager_ranktracker';

let rtData   = { clients: [], activeClientId: null };
let hasAA    = false;

/* ── persistence ── */
function rtLoad() {
  try { return JSON.parse(localStorage.getItem(RT_KEY)) || { clients: [], activeClientId: null }; }
  catch { return { clients: [], activeClientId: null }; }
}
function rtSave() { localStorage.setItem(RT_KEY, JSON.stringify(rtData)); }

/* ── helpers ── */
function rtUid() { return '_' + Math.random().toString(36).slice(2, 10); }

function rtActiveClient() {
  return rtData.clients.find(c => c.id === rtData.activeClientId) || null;
}

function rtRankBadge(rank, prev) {
  if (!rank && rank !== 0) return `<span class="rt-badge rt-na">—</span>`;
  const cls = rank <= 5 ? 'rt-green' : rank <= 10 ? 'rt-orange' : 'rt-red';
  let delta = '';
  if (prev && prev !== rank) {
    const diff = prev - rank; // positive = improved
    delta = diff > 0
      ? `<span class="rt-delta rt-up">↑${diff}</span>`
      : `<span class="rt-delta rt-down">↓${Math.abs(diff)}</span>`;
  }
  return `<span class="rt-badge ${cls}">${rank}</span>${delta}`;
}

function rtFormatDate(iso) {
  if (!iso) return '';
  return iso.slice(0, 10);
}

/* ── render ── */
function rtRender() {
  const client = rtActiveClient();

  // Update client selector
  const sel = document.getElementById('rt-clientSelect');
  sel.innerHTML = rtData.clients.map(c =>
    `<option value="${escHtml(c.id)}"${c.id === rtData.activeClientId ? ' selected' : ''}>${escHtml(c.name)}</option>`
  ).join('');

  const noClient  = document.getElementById('rt-noClient');
  const tableWrap = document.getElementById('rt-tableWrap');

  if (!client) {
    noClient.classList.remove('hidden');
    tableWrap.classList.add('hidden');
    return;
  }
  noClient.classList.add('hidden');
  tableWrap.classList.remove('hidden');

  const tbody = document.getElementById('rt-tbody');
  tbody.innerHTML = '';
  (client.keywords || []).forEach(kw => {
    const tr = document.createElement('tr');
    tr.dataset.id = kw.id;
    tr.innerHTML = `
      <td class="rt-td-rank">${rtRankBadge(kw.rank, kw.prevRank)}</td>
      <td class="rt-td-url"><a href="${escHtml(kw.url || '')}" target="_blank" rel="noopener" class="rt-url-link" title="${escHtml(kw.url || '')}">${escHtml(rtShortUrl(kw.url || ''))}</a></td>
      <td class="rt-td-kw rt-editable" data-field="keyword">${escHtml(kw.keyword || '')}</td>
      <td class="rt-td-vol">${kw.volume ? escHtml(String(kw.volume)) : '<span class="rt-na">—</span>'}</td>
      <td class="rt-td-delta">${rtDeltaCell(kw.rank, kw.prevRank)}</td>
      <td class="rt-td-pop rt-editable" data-field="popStatus">${rtPopCell(kw)}</td>
      <td class="rt-td-note rt-editable" data-field="note">${escHtml(kw.note || '')}</td>
      <td class="rt-td-check">${escHtml(rtFormatDate(kw.lastCheck) || '')}</td>
      <td class="rt-td-del"><button class="rt-del-btn" title="Delete row">✕</button></td>`;
    tbody.appendChild(tr);
  });
}

function rtShortUrl(url) {
  try { return new URL(url).pathname || '/'; } catch { return url; }
}

function rtDeltaCell(rank, prev) {
  if (!rank || !prev || rank === prev) return '';
  const diff = prev - rank;
  return diff > 0
    ? `<span class="rt-delta rt-up">↑${diff}</span>`
    : `<span class="rt-delta rt-down">↓${Math.abs(diff)}</span>`;
}

function rtPopCell(kw) {
  if (!kw.popStatus) return '<span class="rt-na">—</span>';
  const date = kw.popDate ? ` <span class="rt-pop-date">${escHtml(kw.popDate)}</span>` : '';
  return `<span class="rt-pop-badge">POP ✓</span>${date}<br><span style="font-size:10px;color:var(--text-muted)">${escHtml(kw.popStatus)}</span>`;
}

/* ── init rank tracker ── */
function rtInit() {
  rtData = rtLoad();

  // Events
  document.getElementById('rt-clientSelect').addEventListener('change', e => {
    rtData.activeClientId = e.target.value;
    rtSave();
    rtRender();
  });
  document.getElementById('rt-addClientBtn').addEventListener('click', () => rtShowAddClient());
  document.getElementById('rt-editClientBtn').addEventListener('click', () => rtShowEditClient());
  document.getElementById('rt-refreshBtn').addEventListener('click', rtRefreshAll);
  document.getElementById('rt-importBtn').addEventListener('click', () => {
    document.getElementById('rt-importText').value = '';
    rtOpenModal('rt-importModal');
  });
  document.getElementById('rt-importConfirmBtn').addEventListener('click', rtImport);
  document.getElementById('rt-addRowBtn').addEventListener('click', rtAddRow);
  document.getElementById('rt-saveClientBtn').addEventListener('click', rtSaveClient);
  document.getElementById('rt-deleteClientBtn').addEventListener('click', rtDeleteClient);
  document.getElementById('rt-campaignPick').addEventListener('change', e => {
    const opt = e.target.selectedOptions[0];
    if (!opt?.value) return;
    document.getElementById('rt-campaignId').value = opt.value;
    if (!document.getElementById('rt-clientName').value.trim())
      document.getElementById('rt-clientName').value = opt.dataset.name || '';
  });

  // Table delegation: edit + delete
  document.getElementById('rt-tbody').addEventListener('click', e => {
    const delBtn = e.target.closest('.rt-del-btn');
    if (delBtn) { rtDeleteRow(delBtn.closest('tr').dataset.id); return; }
    const editCell = e.target.closest('.rt-editable');
    if (editCell) {
      const tr  = editCell.closest('tr');
      const id  = tr.dataset.id;
      const fld = editCell.dataset.field;
      rtOpenEditModal(id, fld);
    }
  });

  // Edit modal save
  document.getElementById('rt-editSaveBtn').addEventListener('click', rtEditSave);

  rtRender();
}

/* ── client management ── */
async function rtLoadCampaigns(preselectId) {
  const wrap = document.getElementById('rt-campaignPickWrap');
  const sel  = document.getElementById('rt-campaignPick');
  wrap.classList.remove('hidden');
  sel.innerHTML = '<option value="">— loading campaigns… —</option>';
  sel.disabled  = true;
  try {
    const r = await fetch('/api/aa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'agency-analytics-v2',
        asset: 'campaign',
        operation: 'read',
        fields: ['id', 'company', 'url'],
        limit: 200,
        offset: 0,
      }),
    });
    const data = await r.json();
    // AA returns HTTP 200 but puts errors in data.status / data.results.messages
    const aaErr = !r.ok || data?.status === 'error' || (data?.code >= 400);
    if (aaErr) throw new Error(
      (data?.results?.messages || []).join('; ') ||
      data?.error?.message ||
      `AA error ${data?.code || r.status}`
    );
    const list = Array.isArray(data?.results?.rows) ? data.results.rows
               : Array.isArray(data?.data)           ? data.data
               : Array.isArray(data)                 ? data
               : [];
    if (!list.length) throw new Error(
      `No campaigns returned — top keys: ${Object.keys(data).join(', ')}` +
      (data?.results ? ` / results keys: ${Object.keys(data.results).join(', ')}` : '')
    );
    sel.innerHTML = '<option value="">— select a campaign —</option>' +
      list.map(c =>
        `<option value="${escHtml(String(c.id))}" data-name="${escHtml(c.company || '')}">`+
        `${escHtml(c.company || c.url || String(c.id))}</option>`
      ).join('');
    if (preselectId) sel.value = String(preselectId);
  } catch (e) {
    sel.innerHTML = `<option value="">Error: ${escHtml(e.message)}</option>`;
  }
  sel.disabled = false;
}

function rtShowAddClient() {
  document.getElementById('rt-modalTitle').textContent     = 'Add Client';
  document.getElementById('rt-clientName').value           = '';
  document.getElementById('rt-campaignId').value           = '';
  document.getElementById('rt-deleteClientBtn').classList.add('hidden');
  document.getElementById('rt-saveClientBtn').dataset.mode = 'add';
  if (hasAA) rtLoadCampaigns();
  else document.getElementById('rt-campaignPickWrap').classList.add('hidden');
  rtOpenModal('rt-clientModal');
}

function rtShowEditClient() {
  const c = rtActiveClient();
  if (!c) return;
  document.getElementById('rt-modalTitle').textContent     = 'Edit Client';
  document.getElementById('rt-clientName').value           = c.name;
  document.getElementById('rt-campaignId').value           = c.aaCampaignId || '';
  document.getElementById('rt-deleteClientBtn').classList.remove('hidden');
  document.getElementById('rt-saveClientBtn').dataset.mode = 'edit';
  if (hasAA) rtLoadCampaigns(c.aaCampaignId);
  else document.getElementById('rt-campaignPickWrap').classList.add('hidden');
  rtOpenModal('rt-clientModal');
}

function rtSaveClient() {
  const name  = document.getElementById('rt-clientName').value.trim();
  const cid   = document.getElementById('rt-campaignId').value.trim();
  const mode  = document.getElementById('rt-saveClientBtn').dataset.mode;
  if (!name) return;
  if (mode === 'add') {
    const client = { id: rtUid(), name, aaCampaignId: cid, keywords: [] };
    rtData.clients.push(client);
    rtData.activeClientId = client.id;
  } else {
    const c = rtActiveClient();
    if (c) { c.name = name; c.aaCampaignId = cid; }
  }
  rtSave();
  rtRender();
  rtCloseModal('rt-clientModal');
}

function rtDeleteClient() {
  const c = rtActiveClient();
  if (!c || !confirm(`Delete "${c.name}" and all its keywords?`)) return;
  rtData.clients = rtData.clients.filter(x => x.id !== c.id);
  rtData.activeClientId = rtData.clients[0]?.id || null;
  rtSave();
  rtRender();
  rtCloseModal('rt-clientModal');
}

/* ── row management ── */
function rtAddRow() {
  const c = rtActiveClient();
  if (!c) return;
  c.keywords.push({ id: rtUid(), url: '', keyword: '', volume: null, note: '', popStatus: '', popDate: '', rank: null, prevRank: null, lastCheck: null });
  rtSave();
  rtRender();
}

function rtDeleteRow(id) {
  const c = rtActiveClient();
  if (!c) return;
  c.keywords = c.keywords.filter(k => k.id !== id);
  rtSave();
  rtRender();
}

/* ── inline edit modal ── */
let _rtEditCtx = null;

function rtOpenEditModal(kwId, field) {
  const c   = rtActiveClient();
  const kw  = c?.keywords.find(k => k.id === kwId);
  if (!kw) return;

  const labels = {
    keyword:   'Keyword',
    popStatus: 'POP Status',
    note:      'Note',
  };
  _rtEditCtx = { kwId, field };

  const isLong = field === 'note' || field === 'popStatus';
  const val    = field === 'popStatus'
    ? (kw.popStatus + (kw.popDate ? '\n' + kw.popDate : ''))
    : (kw[field] || '');

  document.getElementById('rt-editModalTitle').textContent = `Edit ${labels[field] || field}`;
  document.getElementById('rt-editInput').style.display    = isLong ? 'none' : 'block';
  document.getElementById('rt-editTextarea').style.display = isLong ? 'block' : 'none';

  if (isLong) {
    document.getElementById('rt-editTextarea').value = val;
  } else {
    document.getElementById('rt-editInput').value = val;
  }
  rtOpenModal('rt-editModal');

  setTimeout(() => {
    const el = isLong
      ? document.getElementById('rt-editTextarea')
      : document.getElementById('rt-editInput');
    el.focus(); el.select();
  }, 50);
}

function rtEditSave() {
  if (!_rtEditCtx) return;
  const { kwId, field } = _rtEditCtx;
  const c  = rtActiveClient();
  const kw = c?.keywords.find(k => k.id === kwId);
  if (!kw) return;

  const isLong = field === 'note' || field === 'popStatus';
  const raw    = isLong
    ? document.getElementById('rt-editTextarea').value.trim()
    : document.getElementById('rt-editInput').value.trim();

  if (field === 'popStatus') {
    const lines    = raw.split('\n');
    kw.popStatus   = lines[0].trim();
    kw.popDate     = lines[1]?.trim() || new Date().toISOString().slice(0, 10);
  } else {
    kw[field] = raw;
  }

  rtSave();
  rtRender();
  rtCloseModal('rt-editModal');
}

/* ── import ── */
function rtImport() {
  const c = rtActiveClient();
  if (!c) return;
  const text = document.getElementById('rt-importText').value.trim();
  if (!text) return;
  const lines = text.split('\n').filter(l => l.trim());

  for (const line of lines) {
    const cols = line.split('\t').map(s => s.trim());
    const [url = '', keyword = '', volume = '', note = '', lastCheck = ''] = cols;
    if (!keyword && !url) continue;
    // skip header row
    if (keyword.toLowerCase() === 'emq' || keyword.toLowerCase() === 'keyword') continue;
    c.keywords.push({
      id: rtUid(),
      url: url || '',
      keyword: keyword || '',
      volume: volume ? parseInt(volume) || null : null,
      note: note || '',
      popStatus: note?.startsWith('POP') ? note : '',
      popDate:   note?.startsWith('POP') && lastCheck ? lastCheck : '',
      rank: null,
      prevRank: null,
      lastCheck: lastCheck && !note?.startsWith('POP') ? lastCheck : null,
    });
  }
  rtSave();
  rtRender();
  rtCloseModal('rt-importModal');
}

/* ── AA ranking refresh ── */
async function rtRefreshAll() {
  const c = rtActiveClient();
  if (!c) return;
  if (!hasAA) { alert('AgencyAnalytics API key is not configured on the server.'); return; }
  if (!c.aaCampaignId) { alert('Set the AgencyAnalytics Campaign ID for this client (click ✎ edit).'); return; }

  const btn = document.getElementById('rt-refreshBtn');
  btn.disabled   = true;
  btn.textContent = 'Refreshing…';

  try {
    const today  = new Date().toISOString().slice(0, 10);
    const campId = String(c.aaCampaignId);

    async function aaQuery(body) {
      const r = await fetch('/api/aa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'agency-analytics-v2', ...body }),
      });
      const d = await r.json();
      const aaErr = !r.ok || d?.status === 'error' || (d?.code >= 400);
      if (aaErr) throw new Error(
        (d?.results?.messages || []).join('; ') ||
        d?.error?.message ||
        `AA error ${d?.code || r.status}`
      );
      return Array.isArray(d?.results?.rows) ? d.results.rows
           : Array.isArray(d?.data)          ? d.data
           : Array.isArray(d)               ? d
           : [];
    }

    // Step 1: get keyword phrases + ids for this campaign (no date fields — they're date-dependent)
    const kwRows = await aaQuery({
      asset: 'keyword',
      operation: 'read',
      fields: ['id', 'keyword_phrase'],
      filters: [{ campaign_id: { '$equals_comparison': campId } }],
      sort: [{ id: 'asc' }],
      limit: 500,
      offset: 0,
    });
    if (!kwRows.length) throw new Error(`No keywords found for campaign ID ${campId}. Verify the campaign ID in ✎ edit.`);

    // keyword_id → phrase
    const kwById = {};
    for (const k of kwRows) kwById[k.id] = k.keyword_phrase;

    // Step 2: get latest rankings via campaign-rankings (keyword-rankings requires connector type)
    const rkRows = await aaQuery({
      asset: 'campaign-rankings',
      operation: 'read',
      fields: ['date', 'google_ranking', 'google_mobile_ranking', 'volume'],
      filters: [
        { campaign_id: { '$equals_comparison': campId } },
      ],
      sort: [{ date: 'desc' }],
      limit: 500,
      offset: 0,
    });

    // Debug: show what keys AA actually returns per row
    const firstRowKeys = rkRows[0] ? Object.keys(rkRows[0]).join(', ') : 'no rows';

    // Build lookups — AA may auto-include keyword_id / keyword_phrase even without requesting them
    const rkByKwId  = {};
    const rkByPhrase = {};
    for (const r of rkRows) {
      if (r.keyword_id   != null && !rkByKwId[r.keyword_id])              rkByKwId[r.keyword_id]  = r;
      const p = (r.keyword_phrase || '').toLowerCase();
      if (p && !rkByPhrase[p]) rkByPhrase[p] = r;
    }

    // Match stored keywords: direct phrase → or via keyword_id join from step 1
    let updated = 0;
    for (const kw of c.keywords) {
      const kwLower = (kw.keyword || '').toLowerCase();
      let rk = rkByPhrase[kwLower];
      if (!rk) {
        const aaKw = kwRows.find(k => (k.keyword_phrase || '').toLowerCase() === kwLower);
        if (aaKw) rk = rkByKwId[aaKw.id];
      }
      if (!rk) continue;
      kw.prevRank  = kw.rank;
      kw.rank      = rk.google_ranking ?? null;
      kw.volume    = rk.volume ?? kw.volume;
      kw.lastCheck = today;
      updated++;
    }

    rtSave();
    document.getElementById('rt-lastRefresh').textContent =
      `Updated ${updated}/${c.keywords.length} keywords · ${new Date().toLocaleTimeString()} [row keys: ${firstRowKeys}]`;
    rtRender();
  } catch (e) {
    alert('Refresh failed: ' + e.message);
  } finally {
    btn.disabled   = false;
    btn.innerHTML  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Refresh Rankings`;
  }
}

/* ── modal helpers ── */
function rtOpenModal(id)  { document.getElementById(id).classList.remove('hidden'); }
function rtCloseModal(id) { document.getElementById(id).classList.add('hidden'); }

// Close modals on overlay click
document.addEventListener('click', e => {
  ['rt-clientModal', 'rt-importModal', 'rt-editModal'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.classList.contains('hidden') && e.target === el) rtCloseModal(id);
  });
});

// Close modals on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    ['rt-clientModal', 'rt-importModal', 'rt-editModal'].forEach(id => rtCloseModal(id));
  }
});

/* ── START ── */
init();
