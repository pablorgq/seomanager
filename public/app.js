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
  await rtInit();
  coraInit();
  dbRender();

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

  // Tools dropdown
  const toolsBtn  = document.getElementById('toolsMenuBtn');
  const toolsDrop = document.getElementById('toolsDropdown');
  const TOOLS_TABS = new Set(['brands', 'images']);
  toolsBtn.addEventListener('click', e => {
    e.stopPropagation();
    toolsDrop.classList.toggle('open');
  });
  document.addEventListener('click', () => toolsDrop.classList.remove('open'));
  toolsDrop.addEventListener('click', () => setTimeout(() => toolsDrop.classList.remove('open'), 80));

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + tab).classList.add('active');
      toolsBtn.classList.toggle('active', TOOLS_TABS.has(tab));
      if (tab === 'dashboard') dbRender();
      if (tab === 'files') filesRender();
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

  // "Page not built yet" toggle — show/hide existing content area
  const pnbCheck  = document.getElementById('ag-pageNotBuilt');
  const pnbWrap   = document.getElementById('ag-existingContentWrap');
  const urlInput  = document.getElementById('ag-targetUrl');
  if (pnbCheck && pnbWrap) {
    const syncWrap = () => { pnbWrap.style.display = pnbCheck.checked ? 'none' : 'block'; };
    pnbCheck.addEventListener('change', syncWrap);
    syncWrap();
    // Auto-fetch when URL is set and page is marked as existing
    urlInput?.addEventListener('blur', () => {
      if (!pnbCheck.checked && urlInput.value.trim().startsWith('http')) {
        const ta = document.getElementById('ag-existingContent');
        if (!ta?.value.trim()) agFetchPageContent();
      }
    });
  }

  // Error close buttons (delegated)
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('error-close')) {
      e.target.closest('.error-banner').classList.add('hidden');
    }
  });
}

/* ── FETCH PAGE CONTENT (manual trigger from UI) ── */
async function agFetchPageContent() {
  const url    = document.getElementById('ag-targetUrl').value.trim();
  const status = document.getElementById('ag-fetchStatus');
  const ta     = document.getElementById('ag-existingContent');
  if (!url || !/^https?:\/\//i.test(url)) {
    status.innerHTML = 'Enter a valid page URL first.';
    return;
  }
  status.innerHTML = 'Fetching…';
  try {
    const r = await fetch('/api/fetch-page', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    let d = {};
    try { d = await r.json(); } catch(_) {}
    if (r.ok && d.text) {
      ta.value = d.text;
      const via = d.source === 'jina' ? ' via Jina Reader' : '';
      status.innerHTML = `<span style="color:var(--green)">✓ ${d.words} words fetched${via} — review and edit if needed.</span>`;
    } else {
      const reason = typeof d.error === 'string' ? d.error : (r.status ? `HTTP ${r.status}` : 'blocked');
      agFetchShowManual(status, url, reason);
    }
  } catch(e) {
    agFetchShowManual(status, url, String(e.message || e));
  }
}

function agFetchShowManual(status, url, reason) {
  const safeUrl = escHtml(url);
  status.innerHTML =
    `<span style="color:var(--text-muted)">⚠ Site blocked auto-fetch (${escHtml(String(reason))}).</span> ` +
    `<a href="${safeUrl}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline;font-weight:600">Open page ↗</a>` +
    ` &mdash; select all text, copy, and paste into the box above.`;
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

function downloadDoc(filename, htmlContent) {
  const a = document.createElement('a');
  a.href = 'data:application/msword;charset=utf-8,' + encodeURIComponent(htmlContent);
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
let agOriginalContent = '';

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

// Derives likely brand/competitor name tokens from the competitor URLs the
// user entered (domain root, e.g. "icoone.com" → "icoone").
function agBrandTokens(competitors) {
  const tokens = new Set();
  for (const url of competitors || []) {
    try {
      const host = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url).hostname.replace(/^www\./, '');
      const root = host.split('.')[0];
      if (root && root.length >= 3) tokens.add(root.toLowerCase());
    } catch (_) {}
  }
  return tokens;
}

// A term looks like a brand/product name if it carries a trademark symbol,
// or contains one of the competitor domain-root tokens as a whole word.
function agIsBrandTerm(phrase, brandTokens) {
  if (/[®™©]/.test(phrase)) return true;
  if (!brandTokens || !brandTokens.size) return false;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...brandTokens].some(tok => new RegExp(`\\b${esc(tok)}\\b`, 'i').test(phrase));
}

function agTermItemHtml(phrase, badgeHtml, brandTokens) {
  const isBrand = agIsBrandTerm(phrase, brandTokens);
  const brandBadge = isBrand
    ? `<span class="ag-term-badge ag-badge-brand" title="Looks like a competitor/brand name — excluded from content">⚠ brand</span>`
    : '';
  return `<label class="ag-term-item${isBrand ? ' ag-term-brand' : ''}">
      <input type="checkbox" ${isBrand ? '' : 'checked'} data-phrase="${escHtml(phrase)}"${isBrand ? ' disabled' : ''}>
      <span class="ag-term-phrase">${escHtml(phrase)}</span>
      ${brandBadge}${badgeHtml}
    </label>`;
}

function agShowTermEditors(variations, lsaPhrases, brandTokens) {
  const varList = document.getElementById('ag-varList');
  varList.innerHTML = variations.map(v => {
    const phrase = typeof v === 'string' ? v : (v.phrase || v.variation || String(v));
    return agTermItemHtml(phrase, `<span class="ag-term-badge ag-badge-var">var</span>`, brandTokens);
  }).join('');
  document.getElementById('ag-varCount').textContent = `(${variations.length})`;

  const lsiList = document.getElementById('ag-lsiList');
  lsiList.innerHTML = lsaPhrases.map(t => {
    const phrase = t.phrase || String(t);
    const avg = t.averageCount || 0;
    const isNlp = t.type === 'nlp' || t.isNlp || t.nlp;
    const badge = isNlp
      ? `<span class="ag-term-badge ag-badge-nlp">nlp</span>`
      : `<span class="ag-term-badge ag-badge-lsi">lsi</span>`;
    return agTermItemHtml(phrase, `<span class="ag-term-count">avg ${escHtml(String(avg))}</span>${badge}`, brandTokens);
  }).join('');
  document.getElementById('ag-lsiCount').textContent = `(${lsaPhrases.length})`;

  document.getElementById('ag-varEditor').style.display = 'block';
  document.getElementById('ag-lsiEditor').style.display = 'block';
  document.getElementById('ag-continueBtn').style.display = 'flex';
}

function agToggleAll(listId, checked) {
  document.querySelectorAll(`#${listId} input[type=checkbox]:not(:disabled)`).forEach(cb => cb.checked = checked);
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
  agLog('← ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
  if (!r.ok || j.error || j.detail) {
    const toStr = v => !v ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    const msg = toStr(j.error) || toStr(j.detail) || toStr(j.message) || JSON.stringify(j).slice(0, 300);
    throw new Error('POP error: ' + msg);
  }
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

function buildTermClassMap(popAllTerms, coraLsi) {
  const coraTerms = (coraLsi ?? []).map(item => item.term || item.keyword || '').filter(Boolean);
  if (!popAllTerms.length && !coraTerms.length) return new Map();

  const norm = s => String(s || '').toLowerCase().trim();
  const words = s => norm(s).split(/\s+/).filter(w => w.length > 3);
  function overlaps(a, b) {
    const na = norm(a), nb = norm(b);
    if (na === nb || na.includes(nb) || nb.includes(na)) return true;
    const wa = new Set(words(a));
    return words(b).some(w => wa.has(w));
  }

  const map = new Map();

  for (const t of popAllTerms) {
    if (!t || t.length < 2) continue;
    const inCora = coraTerms.some(c => overlaps(t, c));
    map.set(norm(t), inCora ? 'term-both' : 'term-pop');
  }

  for (const t of coraTerms) {
    if (!t || t.length < 2) continue;
    const n = norm(t);
    const inPOP = [...map.keys()].some(p => overlaps(t, p));
    if (map.has(n)) {
      if (inPOP) map.set(n, 'term-both');
    } else {
      map.set(n, inPOP ? 'term-both' : 'term-cora');
    }
  }

  return map;
}

function agHighlightTerms(html, termClassMap) {
  if (!termClassMap || !termClassMap.size) return html;

  const priority = { 'term-both': 0, 'term-cora': 1, 'term-pop': 2 };
  const entries = [...termClassMap.entries()]
    .filter(([t]) => t && t.length >= 3)
    .sort((a, b) => {
      if (b[0].length !== a[0].length) return b[0].length - a[0].length;
      return (priority[a[1]] ?? 3) - (priority[b[1]] ?? 3);
    });

  let result = html;
  entries.forEach(([term, cls]) => {
    const safeEsc = escHtml(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`\\b(${safeEsc})\\b`, 'gi'), (_m, p1, offset, str) => {
      const before = str.slice(0, offset);
      const opens  = (before.match(/<mark /g) || []).length;
      const closes = (before.match(/<\/mark>/g) || []).length;
      if (opens > closes) return _m;
      return `<mark class="${cls}">${p1}</mark>`;
    });
  });

  return result;
}

function paraSimScore(a, b) {
  const sig = s => new Set((s.toLowerCase().match(/\b\w{4,}\b/g) || []));
  const wa = sig(a), wb = sig(b);
  if (!wa.size || !wb.size) return 0;
  const inter = [...wa].filter(w => wb.has(w)).length;
  return inter / new Set([...wa, ...wb]).size;
}

function agRenderArticle(text, termClassMap, originalText) {
  const origParas = originalText
    ? originalText.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 30)
    : [];

  let html = escHtml(text);
  html = agHighlightTerms(html, termClassMap);
  html = html
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>');

  return html.split(/\n\n+/).map(line => {
    line = line.trim();
    if (!line) return '';
    if (line.startsWith('<h')) return line;
    let diffCls = '';
    if (origParas.length) {
      const plain = line.replace(/<[^>]+>/g, '');
      const best = Math.max(...origParas.map(op => paraSimScore(plain, op)));
      diffCls = best > 0.72 ? '' : best > 0.22 ? ' diff-modified' : ' diff-added';
    }
    return `<p${diffCls ? ` class="${diffCls.trim()}"` : ''}>${line.replace(/\n/g, ' ')}</p>`;
  }).filter(Boolean).join('\n');
}

function agRenderScore(score) {
  const num = parseFloat(score) || 0;
  const cls = num >= 80 ? 'good' : num >= 60 ? 'warn' : 'bad';
  const msg = num >= 80 ? 'Target score achieved ✓' : num >= 60 ? 'Needs improvement' : 'Below target — regenerate recommended';
  document.getElementById('ag-scoreBadge').innerHTML =
    `<div class="ag-score-badge ${cls}">POP Score: ${num} / 100 — ${msg}</div>`;
}

/* ── Cora + POP cross-reference ── */
function agRenderCrossRef(popTerms, popLsi, popVars) {
  const box = document.getElementById('ag-crossRef');
  if (!box) return;

  const coraLsi = coraReport?.lsi ?? [];
  if (!coraLsi.length) {
    box.style.display = 'none';
    return;
  }

  // Normalise a phrase to lowercase words for matching
  const norm = s => String(s || '').toLowerCase().trim();
  const words = s => norm(s).split(/\s+/).filter(w => w.length > 3);

  function overlaps(a, b) {
    const na = norm(a), nb = norm(b);
    if (na === nb || na.includes(nb) || nb.includes(na)) return true;
    const wa = new Set(words(a));
    return words(b).some(w => wa.has(w));
  }

  // All unique POP phrases
  const popAll = [...new Set([...popTerms, ...popLsi, ...popVars].map(norm))];

  // Score each Cora LSI item
  const rows = coraLsi.map(item => {
    const t       = item.term || item.keyword || '';
    const best    = Math.abs(item.best ?? item.spearman ?? 0);
    const deficit = item.deficit ?? 0;
    const coraPri = best * Math.log1p(Math.max(0, deficit));
    const inPOP   = popAll.some(p => overlaps(p, t));
    return { term: t, best, deficit, coraPri, inPOP,
             spearman: item.spearman ?? 0, pearson: item.pearson ?? 0 };
  }).filter(r => r.term);

  // Sort: both signals first (highest coraPri), then Cora-only
  rows.sort((a, b) => {
    if (a.inPOP !== b.inPOP) return a.inPOP ? -1 : 1;
    return b.coraPri - a.coraPri;
  });

  const bothCount = rows.filter(r => r.inPOP).length;
  document.getElementById('ag-crossRefSub').textContent =
    `${bothCount} term${bothCount !== 1 ? 's' : ''} confirmed by both POP + Cora`;

  const strengthCls = v => Math.abs(v) >= 0.5 ? 'cr-strong' : Math.abs(v) >= 0.25 ? 'cr-mod' : 'cr-weak';

  box.querySelector('#ag-crossRefGrid').innerHTML = rows.slice(0, 40).map(r => `
    <div class="cr-row ${r.inPOP ? 'cr-both' : ''}">
      <span class="cr-term">${escHtml(r.term)}</span>
      <span class="cr-signal ${r.inPOP ? 'cr-sig-both' : 'cr-sig-cora'}">${r.inPOP ? '★ Both' : 'Cora'}</span>
      <span class="cr-stat ${strengthCls(r.spearman)}" title="Spearman">${r.spearman >= 0 ? '+' : ''}${r.spearman.toFixed(2)}</span>
      <span class="cr-stat ${strengthCls(r.pearson)}"  title="Pearson">${r.pearson  >= 0 ? '+' : ''}${r.pearson.toFixed(2)}</span>
      <span class="cr-def" title="Deficit">+${r.deficit}</span>
    </div>`).join('');

  box.style.display = 'block';
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
    const tid1 = r1.taskId || r1.task_id || r1.id;
    if (!tid1) throw new Error('No taskId from get-terms — response: ' + JSON.stringify(r1).slice(0, 200));
    agSetStep(0, 'done', 'taskId: ' + tid1);

    agSetStep(1, 'active');
    const td = await agPollTerms(tid1, 1);
    agTermsData = td;
    agSetStep(1, 'done', `${td.variations.length} vars · ${td.lsaPhrases.length} LSI`);

    agSetStep(2, 'active', 'review terms below → possible brand/competitor names auto-excluded → click Continue');
    const brandTokens = agBrandTokens(competitors);
    agShowTermEditors(td.variations, td.lsaPhrases, brandTokens);
    agLog('Terms loaded — possible brand/competitor names are unchecked & locked out automatically. Review, then click Continue.');

    window._agFlow = { popKey, keyword, targetUrl, pageNotBuilt, locName, targLang, competitors };

  } catch(e) {
    agLog('ERROR: ' + e.message);
    const ai = agSteps.findIndex(s => s.state === 'active');
    if (ai >= 0) agSetStep(ai, 'error', e.message.slice(0, 130));
    btn.disabled = false;
    btn.textContent = 'Generate SEO Article';
  }
}

async function agContinueWithSelected() {
  const { popKey, keyword, targetUrl, pageNotBuilt, locName, targLang, competitors } = window._agFlow;
  const enableNlp = document.getElementById('ag-enableNlp').checked ? 1 : 0;
  const overOpt   = document.getElementById('ag-overOpt').checked ? 1 : 0;
  const strategy  = document.getElementById('ag-strategy').value;
  const approach  = document.getElementById('ag-approach').value;
  const tone      = document.getElementById('ag-tone').value;
  const model     = document.getElementById('ag-oaiModel').value;
  const contentInstructions = document.getElementById('ag-contentInstructions').value.trim();

  const selectedVars = agGetSelected('ag-varList');
  const selectedLsi  = agGetSelected('ag-lsiList');
  // POP create-report expects the original lsaPhrase objects from get-terms,
  // filtered to only the ones the user kept checked
  const fullLsa = (agTermsData.lsaPhrases || [])
    .filter(t => selectedLsi.includes(t.phrase || String(t)));

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
    // POP nests the score under cleanedContentBrief.pageScore, itself an
    // object shaped like { pageScore: 1.03, pageScoreValue: "" } — confirmed
    // from a live report. The number looks like a 0–1 ratio vs. target
    // (1.03 = 103% of target) rather than already being on a 0–100 scale.
    const rawScore = rd.report.cleanedContentBrief?.pageScore ?? rd.report.pageScore
      ?? rd.report.pageScoreValue ?? rd.report.score ?? '?';
    console.log('[POP report] pageScore (raw):', rawScore, '| pTotal:', rd.report.cleanedContentBrief?.pTotal);
    let pageScore = rawScore && typeof rawScore === 'object'
      ? (rawScore.pageScore ?? rawScore.current ?? rawScore.value ?? rawScore.score ?? rawScore.percent ?? rawScore.total ?? JSON.stringify(rawScore))
      : rawScore;
    if (typeof pageScore === 'number' && pageScore > 0 && pageScore <= 5) pageScore = Math.round(pageScore * 100);
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
    const cb = rd.report.cleanedContentBrief || {};

    // Page title (H1) terms
    const titleTerms = (cb.pageTitle || [])
      .filter(t => t.contentBrief && t.contentBrief.target > 0).map(t => t.term.phrase);

    // Meta/SEO title terms
    const metaTitleTerms = (cb.metaTitle || cb.searchEngineTitle || [])
      .filter(t => t.contentBrief && t.contentBrief.target > 0).map(t => t.term.phrase);

    // H2 subheading terms with targets
    const h2Items = (cb.subHeadings || []).filter(t => t.contentBrief);
    const h2Lines = h2Items.length
      ? h2Items.map(t => {
          const min = t.contentBrief.min ?? 0;
          const max = t.contentBrief.max ?? t.contentBrief.target ?? 0;
          return `  "${t.term.phrase}" → ${min}-${max} times in H2s`;
        }).join('\n')
      : '';

    // Body paragraph terms with targets
    const bodyTerms = (cb.p || cbTerms || []).filter(t => t.contentBrief && t.contentBrief.target > 0).slice(0, 30);
    const bodyLines = bodyTerms.length > 0
      ? bodyTerms.map(t => {
          const min = t.contentBrief.min ?? 0;
          const max = t.contentBrief.max ?? t.contentBrief.target ?? 0;
          const nlp = t.term.type === 'nlp' ? ' [NLP]' : '';
          return `  "${t.term.phrase}"${nlp} → ${min}-${max} times`;
        }).join('\n')
      : selectedLsi.slice(0, 15).map(p => `  "${p}" → ~1 time`).join('\n');

    const nlpEntityNames = nlpEntities.map(e => e.name).filter(Boolean);

    // Read existing page content from the textarea (user-pasted or auto-fetched)
    agOriginalContent = '';
    let existingContent = '';
    if (!pageNotBuilt) {
      const taCnt = (document.getElementById('ag-existingContent')?.value || '').trim();
      if (taCnt.length > 100) {
        existingContent = taCnt;
        agOriginalContent = taCnt;
        agLog(`✓ Using ${taCnt.split(/\s+/).length} words of existing page content`);
      } else {
        agLog('⚠ No existing content — paste it into the "Existing page content" box or click Auto-fetch');
      }
    }

    const popBriefSpecs = `FOCUS KEYWORD: "${keyword}"
TARGET WORD COUNT: ~${wcTarget} words
LANGUAGE: ${targLang}
TONE: ${existingContent ? 'match the original page tone' : tone}

── PLACEMENT RULES ──────────────────────────────────────

SEO/META TITLE (write a meta title including these terms):
${metaTitleTerms.length ? metaTitleTerms.map(t => `  "${t}"`).join('\n') : `  "${keyword}"`}

H1 PAGE TITLE (the article H1 must include these terms):
${titleTerms.length ? titleTerms.map(t => `  "${t}"`).join('\n') : `  "${keyword}"`}

H2 SUBHEADINGS — write exactly ${h2Target} H2s, distribute these terms across them:
${h2Lines || `  use: ${selectedVars.slice(0, 4).join(', ')}`}

MAIN CONTENT — use each term at the indicated frequency in body paragraphs:
${bodyLines}
${nlpEntityNames.length ? '\nGOOGLE NLP ENTITIES — weave these in naturally in body text:\n' + nlpEntityNames.map(t => `  "${t}"`).join('\n') : ''}

KEYWORD VARIATIONS — use naturally throughout (not all in one place):
${selectedVars.join(', ')}
${contentInstructions ? `\nCONTENT INSTRUCTIONS — follow these exactly:\n${contentInstructions}\n` : ''}
── FORMAT ───────────────────────────────────────────────
- Output: one # H1 title, ${h2Target} ## H2 sections, one conclusion paragraph
- Use flowing paragraphs — NO bullet lists
- Every term must read naturally — never forced or stuffed
- Do NOT include the meta title in the article body
- Do NOT mention SEO, word counts, or these instructions`;

    // Build term insertion list for the edit prompt
    const insertTermLines = [
      ...bodyTerms.map(t => {
        const min = t.contentBrief.min ?? 0;
        const max = t.contentBrief.max ?? t.contentBrief.target ?? 0;
        return `  • "${t.term.phrase}" — ${min}–${max} times`;
      }),
      ...selectedVars.map(v => `  • "${v}" — weave in naturally`),
      ...selectedLsi.slice(0, 10).map(l => `  • "${l}" — at least once`),
      ...(nlpEntityNames.map(n => `  • "${n}" [NLP entity] — at least once`)),
    ].join('\n');

    const prompt = existingContent
      ? `You are an SEO copy-editor. Return the EXISTING PAGE below with the minimum edits needed to naturally include the listed terms. This is NOT a rewrite.

ABSOLUTE CONSTRAINTS — failure to follow = task failed:
• Copy every sentence from the original verbatim UNLESS that exact sentence is the one receiving a term insertion
• Preserve all brand names, product names, technology names (ICOONE®, Roboderm®, Celluma®, etc.) exactly as written
• Preserve all section headings — only rename a heading if a required term cannot fit anywhere else in that section
• Do NOT invent new facts, services, or claims not present in the original
• Do NOT reorder sections or paragraphs
• You MAY add up to 2 short new paragraphs at the very end if the original is under ${wcTarget} words
• Return the full page — every heading and paragraph — with edits applied

TERMS TO WEAVE IN (insert where they fit naturally; do not force every term):
${insertTermLines}

H1 must contain: ${titleTerms.join(', ') || keyword}
${contentInstructions ? `\nCONTENT INSTRUCTIONS — follow these exactly:\n${contentInstructions}\n` : ''}
EXISTING PAGE CONTENT (return this with edits applied):
---
${existingContent.slice(0, 8000)}
---`
      : `You are an expert SEO content writer. Write a fully optimised article following these POP content brief specifications exactly:

${popBriefSpecs}`;

    agLog(`Calling OpenAI (${model})…`);
    const chatHeaders = { 'Content-Type': 'application/json' };
    if (!hasServerKey) {
      const k = apiKey || await Store.get('seomanager_api_key');
      if (k) chatHeaders['x-client-key'] = k;
    }
    const oaiRes = await fetch('/api/openai/chat', {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({ model, max_tokens: existingContent ? 4000 : 2000, messages: [{ role: 'user', content: prompt }] })
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

    const termClassMap = buildTermClassMap(allTerms, coraReport?.lsi);
    agArticleHtml = agRenderArticle(articleText, termClassMap, agOriginalContent);
    agArticleText = articleText;
    document.getElementById('ag-articleBox').innerHTML = agArticleHtml;

    // Highlight legend
    const hlLegend = document.getElementById('ag-hlLegend');
    if (hlLegend) {
      const vals = [...termClassMap.values()];
      const bothCount = vals.filter(v => v === 'term-both').length;
      const coraCount = vals.filter(v => v === 'term-cora').length;
      const popCount  = vals.filter(v => v === 'term-pop').length;
      hlLegend.style.display = 'flex';
      let legendHtml =
        `<span class="hl-legend-label">Terms:</span>` +
        `<span class="hl-chip term-both">&#9733; Both (${bothCount})</span>` +
        `<span class="hl-chip term-cora">Cora (${coraCount})</span>` +
        `<span class="hl-chip term-pop">POP (${popCount})</span>`;
      if (agOriginalContent) {
        legendHtml +=
          `<span class="hl-sep">|</span>` +
          `<span class="hl-legend-label">Edits:</span>` +
          `<span class="hl-chip diff-modified-chip">&#9998; Modified</span>` +
          `<span class="hl-chip diff-added-chip">+ Added</span>`;
      }
      hlLegend.innerHTML = legendHtml;
    }

    // NLP terms from content brief (blue words) — always available after step 4
    const nlpBriefTerms = bodyTerms.filter(t => t.term && t.term.type === 'nlp').map(t => t.term.phrase);

    document.getElementById('ag-termsSummary').innerHTML =
      `<strong style="color:var(--text-primary)">Variations:</strong> ${selectedVars.map(escHtml).join(' · ')}<br>` +
      `<strong style="color:var(--text-primary)">LSI terms:</strong> ${selectedLsi.map(escHtml).join(' · ')}`;

    // Show NLP section — content brief NLP terms + Google NLP entities
    const allNlpChips = [
      ...nlpBriefTerms.map(p => `<span class="ag-nlp-chip ag-nlp-brief" title="POP content brief NLP">${escHtml(p)}</span>`),
      ...nlpEntities.map(e => `<span class="ag-nlp-chip ag-nlp-google" title="Google NLP: ${escHtml(e.type || '')}">${escHtml(e.name || '')}</span>`),
    ];
    if (allNlpChips.length) {
      const nlpSection = document.getElementById('ag-nlpSection');
      nlpSection.style.display = 'block';
      document.getElementById('ag-nlpSection').querySelector('div').textContent =
        `NLP Terms (${allNlpChips.length}) — use these in body content`;
      document.getElementById('ag-nlpChips').innerHTML = allNlpChips.join('');
    }

    document.getElementById('ag-outputSection').style.display = 'block';
    document.getElementById('ag-outputSection').scrollIntoView({ behavior: 'smooth' });

    // Cora + POP cross-reference
    agRenderCrossRef(allTerms, selectedLsi, selectedVars);

    // Auto-save report so it can be viewed from Rank Tracker + Files
    const repClientId = rtData?.activeClientId;
    if (repClientId) {
      repSave({
        savedAt:        new Date().toISOString(),
        keyword,
        clientId:       repClientId,
        clientName:     rtActiveClient()?.name || '',
        url:            targetUrl,
        score:          pageScore,
        wordCount,
        articleHtml:    agArticleHtml,
        articleText:    agArticleText,
        legendHtml:     document.getElementById('ag-hlLegend')?.innerHTML || '',
        termsSummary:   document.getElementById('ag-termsSummary')?.innerHTML || '',
        competitors:    competitors || [],
        strategy,
        approach,
        enableNlp:      !!enableNlp,
        overOpt:        !!overOpt,
        tone,
        locationName:   locName,
        targetLanguage: targLang,
        contentInstructions,
      });
      rtRender();    // refresh RT table so the 📄 icon activates
      filesRender(); // refresh Files tab if it's the active tab
    }

  } catch(e) {
    agLog('ERROR: ' + e.message);
    const ai = agSteps.findIndex(s => s.state === 'active');
    if (ai >= 0) agSetStep(ai, 'error', e.message.slice(0, 130));
    document.getElementById('ag-continueBtn').style.display = 'flex';
  }

  btn.disabled = false;
  btn.textContent = 'Generate SEO Article';
}

// Inline the highlight/heading styles so bold + colored terms survive
// pasting into apps that don't see this page's stylesheet (Word, Docs, Gmail…)
function agCopySafeHtml(html) {
  return (html || '')
    .replace(/<mark class="term-pop">/g,  '<mark style="background:#c7d2fe;font-weight:600">')
    .replace(/<mark class="term-cora">/g, '<mark style="background:#a7f3d0;font-weight:600">')
    .replace(/<mark class="term-both">/g, '<mark style="background:#fde68a;font-weight:700">');
}

function copyRichHtml(html, plainText, btn) {
  const plain = plainText || (html || '').replace(/<[^>]+>/g, '');
  const done = () => {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = orig, 1500);
  };
  if (window.ClipboardItem) {
    const item = new ClipboardItem({
      'text/html':  new Blob([html || ''], { type: 'text/html' }),
      'text/plain': new Blob([plain], { type: 'text/plain' }),
    });
    navigator.clipboard.write([item]).then(done).catch(() => {
      navigator.clipboard.writeText(plain).then(done).catch(() => {});
    });
  } else {
    navigator.clipboard.writeText(plain).then(done).catch(() => {});
  }
}

function agCopyArticle() {
  copyRichHtml(agCopySafeHtml(agArticleHtml), agArticleText, event.target);
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

const RT_KEY  = 'seomanager_ranktracker';
const REP_PFX = 'pop_report::';

function repKey(clientId, keyword) {
  return REP_PFX + (clientId || 'global') + '::' + (keyword || '').toLowerCase().trim();
}

// In-memory cache of saved SEO reports, keyed by repKey(). Source of truth
// once loaded from the server; localStorage is kept as an instant local
// mirror so reads never block on the network.
let reportsCache = {};

function repSave(data) {
  const key = repKey(data.clientId, data.keyword);
  reportsCache[key] = data;
  try { localStorage.setItem(key, JSON.stringify(data)); } catch(_) {}
  rtScheduleServerSync();
}
function repGet(clientId, keyword) {
  return reportsCache[repKey(clientId, keyword)] || null;
}
function repListAll() {
  return Object.values(reportsCache)
    .sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0));
}
function repListAllLocal() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(REP_PFX)) continue;
    try {
      const rep = JSON.parse(localStorage.getItem(k));
      if (rep) out[k] = rep;
    } catch(_) {}
  }
  return out;
}

// null = still loading from the server; { clients: [], activeClientId: null } = confirmed empty
let rtData   = null;
let rtSort   = { col: null, dir: 'asc' };
let hasAA    = false;

/* ── persistence ── */
function rtLoadLocal() {
  try { return JSON.parse(localStorage.getItem(RT_KEY)) || { clients: [], activeClientId: null }; }
  catch { return { clients: [], activeClientId: null }; }
}

let rtSyncTimer = null;
function rtScheduleServerSync() {
  if (rtSyncTimer) clearTimeout(rtSyncTimer);
  rtSyncTimer = setTimeout(rtSyncToServer, 600);
}
async function rtSyncToServer() {
  rtSyncTimer = null;
  try {
    await fetch('/api/rankdata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rtData, reports: reportsCache }),
    });
  } catch (_) {}
}

// Loads from the server; falls back to (and migrates up) local data if the
// server has nothing yet, or falls back entirely if the server is unreachable.
async function rtLoadFromServer() {
  try {
    const r = await fetch('/api/rankdata');
    if (!r.ok) throw new Error('bad response');
    const server = await r.json();
    if (server?.rtData?.clients?.length > 0) {
      rtData = server.rtData;
      reportsCache = server.reports || {};
      return;
    }
    const local = rtLoadLocal();
    if (local.clients?.length > 0) {
      rtData = local;
      reportsCache = repListAllLocal();
      rtScheduleServerSync(); // one-time push of pre-existing local data
      return;
    }
    rtData = server.rtData || { clients: [], activeClientId: null };
    reportsCache = server.reports || {};
  } catch (_) {
    rtData = rtLoadLocal();
    reportsCache = repListAllLocal();
  }
}

function rtSave() {
  try { localStorage.setItem(RT_KEY, JSON.stringify(rtData)); } catch(_) {}
  dbRender();
  rtScheduleServerSync();
}

/* ── helpers ── */
function rtUid() { return '_' + Math.random().toString(36).slice(2, 10); }

function rtActiveClient() {
  return rtData?.clients?.find(c => c.id === rtData.activeClientId) || null;
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
  if (rtData === null) return; // still loading from the server

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

  // Update sort indicators on headers
  document.querySelectorAll('.rt-sortable').forEach(th => {
    const isSorted = th.dataset.sort === rtSort.col;
    th.dataset.sortDir = isSorted ? rtSort.dir : '';
  });

  // Apply column sort (if any) within the full list, then split into MK / non-MK groups
  let keywords = [...(client.keywords || [])];
  if (rtSort.col) {
    keywords.sort((a, b) => {
      let av, bv;
      if (rtSort.col === 'delta') {
        av = (a.prevRank && a.rank) ? a.prevRank - a.rank : -Infinity;
        bv = (b.prevRank && b.rank) ? b.prevRank - b.rank : -Infinity;
      } else if (rtSort.col === 'keyword') {
        av = (a.keyword || '').toLowerCase();
        bv = (b.keyword || '').toLowerCase();
        return rtSort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      } else {
        av = a[rtSort.col] ?? (rtSort.dir === 'asc' ? Infinity : -Infinity);
        bv = b[rtSort.col] ?? (rtSort.dir === 'asc' ? Infinity : -Infinity);
      }
      return rtSort.dir === 'asc' ? av - bv : bv - av;
    });
  }

  const hasCora   = !!(client?.coraFileName);
  const mkKws     = keywords.filter(kw => kw.mainKeyword);
  const otherKws  = keywords.filter(kw => !kw.mainKeyword);
  const emptyRow  = msg => `<tr class="rt-group-empty-row"><td colspan="13" class="rt-group-empty">${escHtml(msg)}</td></tr>`;

  document.getElementById('rt-tbody-mk').innerHTML = mkKws.length
    ? mkKws.map(kw => rtRowHtml(kw, client, hasCora)).join('')
    : emptyRow('No main keywords yet — click MK on a row below to add one');

  document.getElementById('rt-tbody-all').innerHTML = otherKws.length
    ? otherKws.map(kw => rtRowHtml(kw, client, hasCora)).join('')
    : emptyRow('No other keywords');
}

function rtRowHtml(kw, client, hasCora) {
  const coraCell = hasCora
    ? `<td class="rt-td-cora"><button class="rt-cora-btn" title="View Cora report: ${escHtml(client.coraFileName)}">📊</button></td>`
    : `<td class="rt-td-cora"><span class="rt-na">—</span></td>`;
  const savedRep = repGet(client.id, kw.keyword);
  const repDate  = savedRep?.savedAt ? new Date(savedRep.savedAt).toLocaleDateString() : '';
  const repTip   = savedRep ? `SEO report — saved ${repDate}` : 'No report yet';
  const repCell  = `<td class="rt-td-rep"><button class="rt-rep-btn${savedRep ? ' rt-rep-has' : ''}"
    data-client="${escHtml(client.id)}" data-kw="${escHtml(kw.keyword || '')}"
    title="${escHtml(repTip)}"${savedRep ? '' : ' disabled'}>📄</button></td>`;
  return `
    <tr data-id="${escHtml(kw.id)}">
      <td class="rt-td-rank">${rtRankBadge(kw.rank, kw.prevRank)}</td>
      <td class="rt-td-local">${rtLocalBadge(kw.localRank)}</td>
      <td class="rt-td-url"><a href="${escHtml(kw.url || '')}" target="_blank" rel="noopener" class="rt-url-link" title="${escHtml(kw.url || '')}">${escHtml(rtShortUrl(kw.url || ''))}</a></td>
      <td class="rt-td-kw rt-editable" data-field="keyword">
        <button class="rt-mk-btn${kw.mainKeyword ? ' rt-mk-active' : ''}" data-id="${escHtml(kw.id)}" title="Toggle Main Keyword">MK</button>
        ${escHtml(kw.keyword || '')}</td>
      <td class="rt-td-target rt-editable" data-field="targetUrl">${kw.targetUrl ? `<a href="${escHtml(kw.targetUrl)}" target="_blank" rel="noopener" class="rt-url-link" title="${escHtml(kw.targetUrl)}">${escHtml(rtShortUrl(kw.targetUrl))}</a>` : '<span class="rt-na">—</span>'}</td>
      <td class="rt-td-vol">${kw.volume ? escHtml(String(kw.volume)) : '<span class="rt-na">—</span>'}</td>
      <td class="rt-td-delta">${rtDeltaCell(kw.rank, kw.prevRank)}</td>
      <td class="rt-td-pop">${rtPopCell(kw)}</td>
      ${coraCell}
      ${repCell}
      <td class="rt-td-note rt-editable" data-field="note">${escHtml(kw.note || '')}</td>
      <td class="rt-td-check">${escHtml(rtFormatDate(kw.lastCheck) || '')}</td>
      <td class="rt-td-del"><button class="rt-del-btn" title="Delete row">✕</button></td>
    </tr>`;
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

function rtLocalBadge(rank) {
  if (!rank) return '<span class="rt-na">—</span>';
  const cls = rank <= 3 ? 'rt-green' : rank <= 10 ? 'rt-orange' : 'rt-red';
  return `<span class="rt-rank-badge ${cls}">${rank}</span>`;
}

function showPopReport(clientId, keyword) {
  const rep = repGet(clientId, keyword);
  if (!rep) return;
  const modal = document.getElementById('popReportModal');
  document.getElementById('rep-keyword').textContent = rep.keyword || keyword;
  document.getElementById('rep-meta').innerHTML =
    `<span class="ag-meta-card" style="min-width:80px"><div class="ag-meta-label">POP Score</div><div class="ag-meta-value">${escHtml(String(rep.score || '—'))}</div></span>` +
    `<span class="ag-meta-card" style="min-width:80px"><div class="ag-meta-label">Words</div><div class="ag-meta-value">${escHtml(String(rep.wordCount || '—'))}</div></span>` +
    `<span style="font-size:11px;color:var(--text-muted);align-self:center">Saved ${rep.savedAt ? new Date(rep.savedAt).toLocaleDateString() : '—'}</span>`;
  const leg = document.getElementById('rep-legend');
  leg.innerHTML = rep.legendHtml || '';
  leg.style.display = rep.legendHtml ? 'flex' : 'none';
  document.getElementById('rep-article').innerHTML = rep.articleHtml || '';
  document.getElementById('rep-summary').innerHTML = rep.termsSummary || '';
  document.getElementById('rep-summary').style.display = rep.termsSummary ? 'block' : 'none';
  modal._repText     = rep.articleText || '';
  modal._repHtml     = rep.articleHtml || '';
  modal._repClientId = clientId;
  modal._repKeyword  = keyword;
  modal.classList.add('open');
}

function closePopReport() {
  document.getElementById('popReportModal').classList.remove('open');
}

function copyPopReport() {
  const modal = document.getElementById('popReportModal');
  copyRichHtml(agCopySafeHtml(modal._repHtml), modal._repText, document.getElementById('rep-copyBtn'));
}

function repDownloadDocFromModal() {
  const modal = document.getElementById('popReportModal');
  repDownloadDoc(modal._repClientId, modal._repKeyword);
}

function repDownloadDoc(clientId, keyword) {
  const rep = repGet(clientId, keyword);
  if (!rep) return;

  const details = [
    ['Client',               rep.clientName],
    ['Keyword',               rep.keyword],
    ['URL',                   rep.url],
    ['Competitors',           (rep.competitors || []).join(', ')],
    ['Strategy',               rep.strategy],
    ['Approach',               rep.approach],
    ['Google NLP Analysis',    rep.enableNlp ? 'Yes' : 'No'],
    ['Consider Over-optimization', rep.overOpt ? 'Yes' : 'No'],
    ['Tone',                   rep.tone],
    ['Location',               rep.locationName],
    ['Language',               rep.targetLanguage],
    ['Content Instructions',   rep.contentInstructions],
    ['POP Score',              rep.score],
    ['Word Count',             rep.wordCount],
    ['Saved',                  rep.savedAt ? new Date(rep.savedAt).toLocaleString() : ''],
  ].filter(([, v]) => v);

  const detailRows = details.map(([label, value]) =>
    `<tr><td style="padding:3px 10px 3px 0;color:#666"><strong>${escHtml(label)}</strong></td><td style="padding:3px 0">${escHtml(String(value)).replace(/\n/g, '<br>')}</td></tr>`
  ).join('');

  const html = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><meta charset="utf-8"><title>${escHtml(rep.keyword || 'SEO Article')}</title></head>
<body style="font-family:Calibri,Arial,sans-serif">
<h1>${escHtml(rep.keyword || 'SEO Article')}</h1>
<table>${detailRows}</table>
<hr>
${rep.articleHtml || `<p>${escHtml(rep.articleText || '')}</p>`}
</body></html>`;

  const filename = `${slugify(rep.keyword)}${rep.clientName ? '-' + slugify(rep.clientName) : ''}.doc`;
  downloadDoc(filename, html);
}

function rtPopCell(kw) {
  if (!kw.popStatus) {
    const kw64 = encodeURIComponent(kw.keyword || '');
    const url64 = encodeURIComponent(kw.targetUrl || kw.url || '');
    return `<button class="rt-run-pop-btn" data-kw="${escHtml(kw.keyword||'')}" data-url="${escHtml(kw.targetUrl || kw.url||'')}" title="Run POP analysis">Run POP</button>`;
  }
  const date = kw.popDate ? ` <span class="rt-pop-date">${escHtml(kw.popDate)}</span>` : '';
  return `<span class="rt-pop-badge">POP ✓</span>${date}<br><span style="font-size:10px;color:var(--text-muted)">${escHtml(kw.popStatus)}</span>`;
}

/* ── Dashboard ── */
function dbRender() {
  const grid = document.getElementById('db-grid');
  if (!grid) return;

  if (rtData === null) {
    grid.innerHTML = '<div class="db-empty">Loading…</div>';
    return;
  }

  const clients = rtData?.clients ?? [];

  if (!clients.length) {
    grid.innerHTML = '<div class="db-empty">No clients yet — add clients in Rank Tracker to see performance here.</div>';
    return;
  }

  const tierColor = v => v === null ? 'var(--text-muted)'
    : v <= 5  ? 'var(--green)'
    : v <= 15 ? '#e8a838'
    : v <= 30 ? '#FF7300'
    : 'var(--red)';

  const scored = clients.map(c => {
    const mkKws  = (c.keywords || []).filter(k => k.mainKeyword);
    const ranked = mkKws.filter(k => k.rank);
    const avgRank = ranked.length
      ? ranked.reduce((s, k) => s + k.rank, 0) / ranked.length : null;
    const deltaArr = ranked.filter(k => k.prevRank);
    const avgDelta = deltaArr.length
      ? deltaArr.reduce((s, k) => s + (k.prevRank - k.rank), 0) / deltaArr.length : null;
    const top3  = ranked.filter(k => k.rank <= 3).length;
    const top10 = ranked.filter(k => k.rank <= 10).length;
    const topKws = [...ranked].sort((a, b) => a.rank - b.rank).slice(0, 4);

    const localRanked = mkKws.filter(k => k.localRank);
    const avgLocalRank = localRanked.length
      ? localRanked.reduce((s, k) => s + k.localRank, 0) / localRanked.length : null;

    const avgTotal = avgRank !== null && avgLocalRank !== null
      ? (avgRank + avgLocalRank) / 2
      : avgRank !== null ? avgRank : avgLocalRank;

    return { c, mkKws, ranked, avgRank, avgDelta, top3, top10, topKws, avgLocalRank, avgTotal };
  });

  scored.sort((a, b) => {
    if (a.avgTotal === null && b.avgTotal === null) return 0;
    if (a.avgTotal === null) return 1;
    if (b.avgTotal === null) return -1;
    return a.avgTotal - b.avgTotal;
  });

  grid.innerHTML = scored.map(({ c, mkKws, ranked, avgRank, avgDelta, top3, top10, topKws, avgLocalRank, avgTotal }, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `<span class="db-pos-num">#${i + 1}</span>`;
    const hasMk    = mkKws.length > 0;
    const hasScore = avgTotal !== null;

    let deltaBadge = '';
    if (avgDelta !== null) {
      const sign = avgDelta > 0 ? '↑' : '↓';
      const cls  = avgDelta > 0 ? 'db-delta-up' : 'db-delta-down';
      deltaBadge = `<span class="db-delta ${cls}">${sign}${Math.abs(avgDelta).toFixed(1)} avg</span>`;
    }

    const kwChips = topKws.map(k =>
      `<div class="db-kw-chip"><span class="db-kw-rank">#${k.rank}</span><span class="db-kw-text">${escHtml(k.keyword)}</span></div>`
    ).join('');

    const noData = !hasMk
      ? '<span class="db-no-data">No MK keywords set</span>'
      : '<span class="db-no-data">No rank data yet — run a refresh</span>';

    return `
    <div class="db-card" data-client-id="${escHtml(c.id)}">
      <div class="db-card-top">
        <span class="db-pos">${medal}</span>
        <span class="db-client-name">${escHtml(c.name)}</span>
        <span class="db-mk-count">${mkKws.length} MK</span>
      </div>
      ${hasScore ? `
      <div class="db-score-row">
        <div class="db-score-total">
          <span class="db-avg-rank" style="color:${tierColor(avgTotal)}">${avgTotal.toFixed(1)}</span>
          <div class="db-rank-meta">
            <span class="db-rank-label">total score</span>
            ${deltaBadge}
          </div>
        </div>
        <div class="db-score-split">
          <div class="db-score-sub">
            <span class="db-score-sub-val" style="color:${tierColor(avgRank)}">${avgRank !== null ? avgRank.toFixed(1) : '—'}</span>
            <span class="db-score-sub-label">Organic</span>
          </div>
          <div class="db-score-sub">
            <span class="db-score-sub-val" style="color:${tierColor(avgLocalRank)}">${avgLocalRank !== null ? avgLocalRank.toFixed(1) : '—'}</span>
            <span class="db-score-sub-label">Local</span>
          </div>
        </div>
      </div>
      <div class="db-stats-row">
        <span class="db-stat"><span class="db-stat-val">${top3}</span>&thinsp;Top 3</span>
        <span class="db-stat-sep">·</span>
        <span class="db-stat"><span class="db-stat-val">${top10}</span>&thinsp;Top 10</span>
        <span class="db-stat-sep">·</span>
        <span class="db-stat"><span class="db-stat-val">${ranked.length}</span>&thinsp;ranked</span>
      </div>
      <div class="db-kw-list">${kwChips}</div>
      ` : `<div class="db-no-rank-wrap">${noData}</div>`}
    </div>`;
  }).join('');

  grid.querySelectorAll('.db-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.clientId;
      rtData.activeClientId = id;
      localStorage.setItem(RT_KEY, JSON.stringify(rtData));
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.querySelector('.tab-btn[data-tab="ranks"]').classList.add('active');
      document.getElementById('tab-ranks').classList.add('active');
      document.getElementById('toolsMenuBtn')?.classList.remove('active');
      rtRender();
    });
  });
}

/* ── FILES ── */
function filesRender() {
  const grid = document.getElementById('fl-grid');
  if (!grid) return;
  const reps = repListAll();

  if (!reps.length) {
    grid.innerHTML = '<div class="db-empty">No content generated yet — articles you create in SEO Article are saved here automatically.</div>';
    return;
  }

  grid.innerHTML = reps.map(rep => {
    const details = [
      rep.competitors?.length ? `Competitors: ${rep.competitors.join(', ')}` : null,
      rep.strategy    ? `Strategy: ${rep.strategy}` : null,
      rep.approach    ? `Approach: ${rep.approach}` : null,
      `Google NLP Analysis: ${rep.enableNlp ? 'Yes' : 'No'}`,
      `Consider Over-optimization: ${rep.overOpt ? 'Yes' : 'No'}`,
      rep.tone           ? `Tone: ${rep.tone}` : null,
      rep.locationName   ? `Location: ${rep.locationName}` : null,
      rep.targetLanguage ? `Language: ${rep.targetLanguage}` : null,
      rep.contentInstructions ? `Content Instructions: ${rep.contentInstructions}` : null,
    ].filter(Boolean).join('\n');

    const savedDate = rep.savedAt ? new Date(rep.savedAt).toLocaleDateString() : '';

    return `
    <div class="fl-card" data-client-id="${escHtml(rep.clientId || '')}" data-kw="${escHtml(rep.keyword || '')}" title="${escHtml(details)}">
      <div class="fl-card-top">
        <span class="fl-kw">${escHtml(rep.keyword || '')}</span>
        <span class="fl-score">${escHtml(String(rep.score || '—'))}</span>
      </div>
      <div class="fl-client">${escHtml(rep.clientName || '—')}</div>
      <div class="fl-url">${escHtml(rep.url || '')}</div>
      <div class="fl-meta">
        <span>${escHtml(String(rep.wordCount || '—'))} words</span>
        <span class="db-stat-sep">·</span>
        <span>Saved ${savedDate}</span>
      </div>
      <div class="fl-actions">
        <button class="btn btn-secondary btn-sm fl-view-btn">View</button>
        <button class="btn btn-secondary btn-sm fl-doc-btn">Download .doc</button>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.fl-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.fl-card');
      showPopReport(card.dataset.clientId, card.dataset.kw);
    });
  });
  grid.querySelectorAll('.fl-doc-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.fl-card');
      repDownloadDoc(card.dataset.clientId, card.dataset.kw);
    });
  });
}

/* ── init rank tracker ── */
async function rtInit() {
  await rtLoadFromServer();

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
  document.getElementById('rt-addKeywordsBtn').addEventListener('click', () => {
    document.getElementById('rt-addKeywordsText').value = '';
    rtOpenModal('rt-addKeywordsModal');
  });
  document.getElementById('rt-addKeywordsConfirmBtn').addEventListener('click', rtAddKeywordsBulk);
  document.getElementById('rt-aaImportBtn').addEventListener('click', rtImportFromAA);
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

  // Table delegation: edit + delete + Run POP (covers both Main Keywords and Keywords groups)
  document.getElementById('rt-table').addEventListener('click', e => {
    const delBtn = e.target.closest('.rt-del-btn');
    if (delBtn) { rtDeleteRow(delBtn.closest('tr').dataset.id); return; }

    const mkBtn = e.target.closest('.rt-mk-btn');
    if (mkBtn) {
      const kw = rtActiveClient()?.keywords?.find(k => k.id === mkBtn.dataset.id);
      if (kw) { kw.mainKeyword = !kw.mainKeyword; rtSave(); rtRender(); }
      return;
    }

    const coraBtn = e.target.closest('.rt-cora-btn');
    if (coraBtn) {
      document.querySelector('.tab-btn[data-tab="cora"]')?.click();
      return;
    }

    const repBtn = e.target.closest('.rt-rep-btn');
    if (repBtn && !repBtn.disabled) {
      showPopReport(repBtn.dataset.client, repBtn.dataset.kw);
      return;
    }

    const popBtn = e.target.closest('.rt-run-pop-btn');
    if (popBtn) {
      const kw  = popBtn.dataset.kw;
      const url = popBtn.dataset.url;
      // Pre-fill generator fields and switch to article tab
      document.getElementById('ag-keyword').value   = kw;
      document.getElementById('ag-targetUrl').value = url;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.querySelector('.tab-btn[data-tab="article"]').classList.add('active');
      document.getElementById('tab-article').classList.add('active');
      document.getElementById('toolsMenuBtn')?.classList.remove('active');
      ['ag-keyword','ag-targetUrl'].forEach(id => {
        const el = document.getElementById(id);
        el.classList.add('ag-prefill-flash');
        setTimeout(() => el.classList.remove('ag-prefill-flash'), 1200);
      });
      document.getElementById('ag-keyword').focus();
      return;
    }

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

  // Sortable column headers
  document.getElementById('rt-table').querySelector('thead').addEventListener('click', e => {
    const th = e.target.closest('.rt-sortable');
    if (!th) return;
    const col = th.dataset.sort;
    if (rtSort.col === col) {
      rtSort.dir = rtSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      rtSort.col = col;
      rtSort.dir = col === 'keyword' || col === 'lastCheck' ? 'asc' : 'desc';
    }
    rtRender();
  });

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
    targetUrl: 'Target URL',
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

function rtAddKeywordsBulk() {
  const c = rtActiveClient();
  if (!c) return;
  const text = document.getElementById('rt-addKeywordsText').value.trim();
  if (!text) return;
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);

  for (const keyword of lines) {
    c.keywords.push({
      id: rtUid(), url: '', keyword, volume: null, note: '',
      popStatus: '', popDate: '', rank: null, prevRank: null, lastCheck: null,
    });
  }
  rtSave();
  rtRender();
  rtCloseModal('rt-addKeywordsModal');
  document.getElementById('rt-addKeywordsText').value = '';
}

/* ── AA fetch helper (shared by refresh + import) ── */
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

    // Step 2: get per-keyword rankings — group_by keyword_id gives one row per keyword
    const rkRows = await aaQuery({
      asset: 'campaign-rankings',
      operation: 'read',
      fields: ['keyword_id', 'keyword_phrase', 'google_ranking', 'google_ranking_url', 'google_local_ranking', 'google_mobile_ranking', 'volume', 'competition'],
      filters: [
        { end_date:    { '$lessthanorequal_comparison': today } },
        { start_date:  { '$greaterthanorequal_comparison': today } },
        { campaign_id: { '$equals_comparison': campId } },
      ],
      group_by: ['keyword_id'],
      sort: [{ date: 'asc' }],
      limit: 500,
      offset: 0,
    });

    // Build phrase lookup from campaign-rankings rows (keyword_phrase + keyword_id both returned)
    const rkByPhrase = {};
    const rkByKwId   = {};
    for (const r of rkRows) {
      const p = (r.keyword_phrase || '').toLowerCase();
      if (p && !rkByPhrase[p]) rkByPhrase[p] = r;
      if (r.keyword_id != null && !rkByKwId[r.keyword_id]) rkByKwId[r.keyword_id] = r;
    }

    // Match stored keywords by phrase first, then by keyword_id via step-1 map
    let updated = 0;
    for (const kw of c.keywords) {
      const kwLower = (kw.keyword || '').toLowerCase();
      let rk = rkByPhrase[kwLower];
      if (!rk) {
        const aaKw = kwRows.find(k => (k.keyword_phrase || '').toLowerCase() === kwLower);
        if (aaKw) rk = rkByKwId[aaKw.id];
      }
      if (!rk) continue;
      kw.prevRank   = kw.rank;
      kw.rank       = rk.google_ranking ?? null;
      kw.localRank  = rk.google_local_ranking ?? null;
      kw.volume     = rk.volume ?? kw.volume;
      kw.lastCheck  = today;
      if (!kw.url && rk.google_ranking_url) kw.url = rk.google_ranking_url;
      updated++;
    }

    rtSave();
    document.getElementById('rt-lastRefresh').textContent =
      `Updated ${updated}/${c.keywords.length} keywords · ${new Date().toLocaleTimeString()}`;
    rtRender();
  } catch (e) {
    alert('Refresh failed: ' + e.message);
  } finally {
    btn.disabled   = false;
    btn.innerHTML  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Refresh Rankings`;
  }
}

// Normalizes AA's "tags" field into a flat lowercase name list. AA's own
// filter DSL represents tags as a nested array (e.g. [[""]] for "any"), so
// the read shape may likewise be nested arrays of strings/objects/ids —
// flatten to any depth, then extract a name from whatever's left.
function aaTagNames(row) {
  const flatten = v => Array.isArray(v) ? v.flatMap(flatten)
    : typeof v === 'string' ? v.split(',')
    : [v];
  return flatten(row.tags)
    .map(t => (typeof t === 'string' ? t : (t?.name || t?.tag || ''))
      .toString().trim().toLowerCase())
    .filter(Boolean);
}

/* ── Import all starred keywords from AA campaign.
   Keywords also tagged "sm" in AA are auto-marked Main Keyword; the MK
   button in Rank Tracker always remains available as a manual override. ── */
async function rtImportFromAA() {
  const c = rtActiveClient();
  if (!c) return;
  if (!hasAA) { alert('AgencyAnalytics API key is not configured on the server.'); return; }
  if (!c.aaCampaignId) { alert('Set the AgencyAnalytics Campaign ID for this client (click ✎ edit).'); return; }

  const btn = document.getElementById('rt-aaImportBtn');
  btn.disabled    = true;
  btn.textContent = 'Importing…';

  try {
    const campId = String(c.aaCampaignId);
    const kwRows = await aaQuery({
      asset: 'keyword',
      operation: 'read',
      fields: ['id', 'keyword_phrase', 'primary_keyword', 'tags'],
      filters: [
        { campaign_id: { '$equals_comparison': campId } },
      ],
      sort: [{ id: 'asc' }],
      limit: 500,
      offset: 0,
    });
    // Filter client-side — AA API doesn't reliably support primary_keyword filter
    const starredRows = kwRows.filter(r => r.primary_keyword === true || r.primary_keyword === 1 || r.primary_keyword === '1');
    if (!starredRows.length) throw new Error(`No starred keywords found for campaign ID ${campId}. Star keywords in AgencyAnalytics first.`);

    const existingByPhrase = new Map(c.keywords.map(k => [(k.keyword || '').toLowerCase(), k]));
    let added = 0, markedMk = 0, skipped = 0;
    for (const row of starredRows) {
      const phrase = (row.keyword_phrase || '').trim();
      if (!phrase) continue;
      const key    = phrase.toLowerCase();
      const wantMk = aaTagNames(row).includes('sm');

      const existingKw = existingByPhrase.get(key);
      if (existingKw) {
        if (wantMk && !existingKw.mainKeyword) { existingKw.mainKeyword = true; markedMk++; }
        else skipped++;
        continue;
      }
      const newKw = { id: rtUid(), url: '', keyword: phrase, volume: null,
        note: '', popStatus: '', popDate: '', rank: null, prevRank: null, lastCheck: null,
        mainKeyword: wantMk };
      c.keywords.push(newKw);
      existingByPhrase.set(key, newKw);
      added++;
    }

    rtSave();
    rtRender();
    document.getElementById('rt-lastRefresh').textContent =
      `Added ${added} new · marked ${markedMk} existing as MK via "sm" tag (${skipped} unchanged) — fetching ranks…`;

    // Auto-refresh ranks so URL/rank/local/vol populate immediately
    if (added > 0) await rtRefreshAll();

  } catch (e) {
    alert('Import failed: ' + e.message);
  } finally {
    btn.disabled  = false;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/></svg> ↓ AA Keywords`;
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

/* ═══════════════════════════════════════════════════════════
   CORA SEO REPORT ANALYZER
   ═══════════════════════════════════════════════════════════ */

let coraReport       = null;
let coraFilters      = { effort: 'all', corr: 'all' };
let coraGroupByPhase = false;

/* ── Cora folder watcher ── */
let coraWatchHandle = null;
let coraWatchTimer  = null;

function coraWatchSeenGet() {
  try { return new Set(JSON.parse(localStorage.getItem('cora_watch_seen') || '[]')); }
  catch { return new Set(); }
}
function coraWatchSeenSave(seen) {
  localStorage.setItem('cora_watch_seen', JSON.stringify([...seen].slice(-400)));
}

async function coraWatchStart() {
  if (!window.showDirectoryPicker) {
    alert('Folder watching requires Chrome or Edge — not supported in Firefox or Safari.');
    return;
  }
  try {
    coraWatchHandle = await window.showDirectoryPicker({ mode: 'read' });
    coraWatchUpdateUI();
    await coraWatchPoll();
    coraWatchTimer = setInterval(coraWatchPoll, 30_000);
  } catch(e) {
    if (e.name !== 'AbortError') coraWatchUpdateUI(`Error: ${e.message}`, true);
  }
}

function coraWatchStop() {
  clearInterval(coraWatchTimer);
  coraWatchTimer  = null;
  coraWatchHandle = null;
  coraWatchUpdateUI();
}

async function coraWatchPoll() {
  if (!coraWatchHandle) return;
  const seen = coraWatchSeenGet();
  const queue = [];
  try {
    for await (const [name, entry] of coraWatchHandle.entries()) {
      if (entry.kind !== 'file') continue;
      if (!name.toLowerCase().endsWith('.xlsx')) continue;
      const file = await entry.getFile();
      const key  = `${name}::${file.lastModified}`;
      if (!seen.has(key)) queue.push({ name, file, key });
    }
  } catch(e) {
    coraWatchUpdateUI(`Watch error: ${e.message}`, true);
    return;
  }
  queue.sort((a, b) => a.file.lastModified - b.file.lastModified);
  for (const { name, file, key } of queue) {
    seen.add(key);
    coraWatchSeenSave(seen);
    coraWatchUpdateUI(`Loading: ${name}…`);
    await coraHandleFile(file);
  }
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const folderName = coraWatchHandle?.name || '';
  coraWatchUpdateUI(
    queue.length
      ? `Loaded ${queue.length} new report${queue.length > 1 ? 's' : ''} · watching ${folderName}`
      : `Watching ${folderName} · checked ${t}`
  );
}

function coraWatchUpdateUI(msg, isError = false) {
  const active = !!coraWatchHandle;
  document.querySelectorAll('.cora-watch-status').forEach(el => {
    if (!active && !msg) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    el.innerHTML = `
      <span class="cw-dot ${active ? 'cw-active' : ''} ${isError ? 'cw-err-dot' : ''}"></span>
      <span class="cw-msg ${isError ? 'cw-err' : ''}">${escHtml(msg || '')}</span>
      ${active ? '<button class="cw-stop">Stop</button>' : ''}`;
    el.querySelectorAll('.cw-stop').forEach(b => b.addEventListener('click', coraWatchStop));
  });
  document.querySelectorAll('.cora-watch-btn').forEach(btn => {
    if (active) {
      btn.textContent = '⏹ Stop';
      btn.onclick = coraWatchStop;
    } else {
      btn.textContent = btn.id === 'cora-watch-btn-view' ? '📁 Watch' : '📁 Watch Folder';
      btn.onclick = coraWatchStart;
    }
  });
}

// ── sheet helpers ────────────────────────────────────────────
function coraFindSheet(wb, patterns) {
  for (const pat of patterns) {
    const re   = new RegExp(pat, 'i');
    const name = wb.SheetNames.find(n => re.test(n));
    if (name) return wb.Sheets[name];
  }
  return null;
}

function coraHeaderMap(rows, keywords, maxScan = 30, minMatches = 2) {
  let bestRow = -1, bestCount = 0, bestMap = {};
  for (let r = 0; r < Math.min(maxScan, rows.length); r++) {
    const cells = rows[r].map(c => String(c ?? '').toLowerCase().trim());
    const hits  = keywords.filter(kw => cells.some(c => c.includes(kw))).length;
    if (hits >= minMatches && hits > bestCount) {
      bestCount = hits;
      bestRow   = r;
      const map = {};
      cells.forEach((h, i) => { if (h) map[h] = i; });
      bestMap = map;
      // Perfect match: stop early if we found many columns
      if (hits >= 4) break;
    }
  }
  if (bestRow === -1) return { map: {}, rowIdx: -1 };
  return { map: bestMap, rowIdx: bestRow };
}

function coraCol(map, ...names) {
  for (const n of names) {
    if (map[n] !== undefined) return map[n];
    const key = Object.keys(map).find(k => k.includes(n));
    if (key !== undefined) return map[key];
  }
  return -1;
}

// Read fill RGB from an xlsx cell (SheetJS cellStyles mode)
function coraCellFill(ws, r, c) {
  try {
    const addr = XLSX.utils.encode_cell({ r, c });
    const cell = ws[addr];
    if (!cell?.s) return null;
    const f = cell.s.fgColor ?? cell.s.bgColor ?? cell.s.fill?.fgColor;
    if (!f) return null;
    return String(f.rgb ?? f.argb ?? '').replace(/^FF/i, '').toUpperCase();
  } catch { return null; }
}

function coraColorType(rgb) {
  if (!rgb || rgb === '000000' || rgb === 'FFFFFF' || rgb.length < 6) return 'none';
  if (/^(00B050|70AD47|92D050|008000|22B14C|00FF00|4EA72A|375623|548235)/i.test(rgb)) return 'green';
  if (/^(FF0000|C00000|FF3333|C0504D|FF4444|CC0000|A50000|9C0006)/i.test(rgb))        return 'red';
  if (/^(FFFF00|FFEB9C|FFE699|FFFFCC|FFF2CC|FFFF99|FFFFC0|FFFD75)/i.test(rgb))       return 'yellow';
  return 'none';
}

// ── metadata ─────────────────────────────────────────────────
function coraParseMeta(wb) {
  const ws = coraFindSheet(wb, ['road.?map', 'roadmap']);
  if (!ws) return {};
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const meta = {};
  for (let r = 0; r < Math.min(20, rows.length); r++) {
    const row   = rows[r];
    const c0    = String(row[0] || '').trim();
    const c1    = String(row[1] || '').trim();
    // Row 0: URL of tracked page
    if (r === 0 && /^https?:\/\//i.test(c0)) { meta.url = c0; meta.domain = c0.replace(/^https?:\/\//i,'').replace(/\/.*$/,''); }
    // "SEO Tuning Roadmap [domain]"
    if (/seo tuning roadmap/i.test(c0) && c1) meta.domain = meta.domain || c1;
    // Settings rows
    if (/localize near/i.test(c0) && c1) meta.location = c1;
    if (/google country/i.test(c0) && c1) meta.country  = c1;
    if (/keyword strategy/i.test(c0) && c1) meta.kwStrategy = c1;
  }
  return meta;
}

// ── Road Map parser ──────────────────────────────────────────
// Cora Roadmap structure (no column header row):
//   Col 0: Factor name  |  Col 1: "Add X more. ( Type )"
//   Col 2: Easy/Difficult  |  Col 3: On Page / Off Page / Web Development / Academic / Configuration
//   Col 4: "Top 200 Factor" or ""  |  Col 5: "High Usage Rate" or ""  |  Col 6: NOT DONE / DONE
// Phase rows: Col 0 = "Phase 1: Title & Headings" (other cols empty)
// corrType detected from cell fill color: green / red / black (default)
function coraParseRoadMap(wb) {
  const ws = coraFindSheet(wb, ['road.?map', 'roadmap']);
  if (!ws) return [];

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // Find where phases start
  let dataStart = 0;
  for (let r = 0; r < Math.min(40, rows.length); r++) {
    if (/^Phase\s+[\dX]+/i.test(String(rows[r][0] || '').trim())) { dataStart = r; break; }
  }

  const items = [];
  let currentPhase = 'Other';

  for (let r = dataStart; r < rows.length; r++) {
    const row  = rows[r];
    const c0   = String(row[0] ?? '').trim();
    if (!c0) continue;

    // Phase header row: "Phase 1: Title & Headings"
    if (/^Phase\s+[\dX]+/i.test(c0)) { currentPhase = c0; continue; }

    // Data row: col 1 must have "Add X more. ( Type )"
    const action = String(row[1] ?? '').trim();
    if (!/^Add\s+/i.test(action)) continue;

    const countM   = action.match(/Add\s+([\d,]+)\s+more/i);
    const deficit  = countM ? parseInt(countM[1].replace(/,/g,'')) : 0;
    const typeM    = action.match(/\(\s*([^)]+?)\s*\)/);
    const factorType = typeM ? typeM[1].trim() : '';

    const easy      = /^easy$/i.test(String(row[2] ?? '').trim());
    const category  = String(row[3] ?? '').trim();  // On Page / Off Page / Web Development / Academic / Configuration
    const top200    = /top 200/i.test(String(row[4] ?? ''));
    const highUsage = /high usage/i.test(String(row[5] ?? ''));
    const done      = /^done$/i.test(String(row[6] ?? '').trim());

    // Correlation type from cell color
    let corrType = 'black';
    for (let c = 0; c < 8; c++) {
      const t = coraColorType(coraCellFill(ws, r, c));
      if (t === 'green') { corrType = 'green'; break; }
      if (t === 'red')   { corrType = 'red';   break; }
    }

    items.push({ factor: c0, phase: currentPhase, factorType, category, easy, deficit, top200, highUsage, done, corrType });
  }

  return items;
}

// ── LSI parser ───────────────────────────────────────────────
function coraParseLSI(wb) {
  // Try multiple sheet name patterns — Cora uses "LSI" but some versions vary
  const ws = coraFindSheet(wb, ['lsi keywords', '^lsi$', 'lsi report', 'lsi keyword', 'lsi analysis', 'lsi']);
  if (!ws) return { items: [], sheetNames: wb.SheetNames };

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const debugRows = rows.slice(0, 8).map((r, i) => `[${i}] ${r.slice(0, 10).map(c => String(c).slice(0, 25)).join(' | ')}`);

  // Extract Cora's statistical significance thresholds from preamble rows 3-4
  let spearmanCrit = null, pearsonCrit = null;
  for (let r = 0; r < Math.min(10, rows.length); r++) {
    const c0 = String(rows[r][0] || '').toLowerCase();
    const c1 = parseFloat(rows[r][1]);
    if (/spearman/i.test(c0) && !isNaN(c1)) spearmanCrit = c1;
    if (/pearson/i.test(c0)  && !isNaN(c1)) pearsonCrit  = c1;
  }

  // Header scan: broad keyword list, scan up to 100 rows (Cora has long preambles)
  const { map, rowIdx } = coraHeaderMap(
    rows,
    ['term', 'phrase', 'word', 'pages', 'deficit', 'spearman', 'pearson', 'best', 'avg', 'average', 'count', 'total', 'max'],
    100
  );
  if (rowIdx === -1) return { items: [], sheetNames: wb.SheetNames, debugRows };

  const termCol     = Math.max(0, coraCol(map, 'term', 'phrase', 'word', 'keyword'));
  const pagesCol    = coraCol(map, 'pages');
  const maxCol      = coraCol(map, 'max');
  const avgCol      = coraCol(map, 'avg', 'average');
  const totalCol    = coraCol(map, 'total');
  const defCol      = coraCol(map, 'deficit');
  const spearmanCol = coraCol(map, 'spearman', 'spearmans');
  const pearsonCol  = coraCol(map, 'pearson',  'pearsons');
  const bestCol     = coraCol(map, 'best of both', 'best');

  // "Your count" column: Cora names this column with the tracked domain, NOT "your count"
  // Reliable heuristic: it's the column immediately before "deficit"
  const yrCol = defCol > 0 ? defCol - 1
    : coraCol(map, 'your count', 'you', 'your', 'count');

  const items = [];
  for (let r = rowIdx + 1; r < rows.length; r++) {
    const row  = rows[r];
    const term = String(row[termCol] ?? '').trim();
    if (!term || /^(term|word|phrase|keyword)$/i.test(term)) continue;

    const avgVal  = avgCol >= 0 ? (parseFloat(row[avgCol])  || 0) : 0;
    const yours   = yrCol  >= 0 ? (parseFloat(row[yrCol])   || 0) : 0;
    const rawDef  = defCol >= 0 ? (parseFloat(row[defCol])  || 0) : 0;
    const deficit = rawDef !== 0 ? rawDef : Math.max(0, avgVal - yours);
    // Skip only if we have zero signal on every numeric field
    const spearmanRaw = spearmanCol >= 0 ? (parseFloat(row[spearmanCol]) || 0) : 0;
    const pearsonRaw  = pearsonCol  >= 0 ? (parseFloat(row[pearsonCol])  || 0) : 0;
    if (deficit <= 0 && avgVal <= 0 && spearmanRaw === 0 && pearsonRaw === 0) continue;

    const spearman = spearmanRaw;
    const pearson  = pearsonRaw;
    const best     = bestCol >= 0
      ? (parseFloat(row[bestCol]) || 0)
      : (Math.abs(spearman) >= Math.abs(pearson) ? spearman : pearson);

    // Priority score: |correlation| × log(deficit+1)
    // Negative best = more usage correlates with BETTER rank = "add this"
    // Fall back to deficit-only if no correlation data
    const hasCorrData = spearman !== 0 || pearson !== 0 || best !== 0;
    const priority    = hasCorrData
      ? Math.abs(best || spearman || pearson) * Math.log1p(deficit)
      : Math.log1p(deficit) * 0.01; // low priority when no signal

    // Word count of term (1–4 words) — shorter = more general
    const words = term.split(/\s+/).length;

    items.push({
      term, words,
      pages:   pagesCol >= 0 ? (parseInt(row[pagesCol])   || 0) : 0,
      max:     maxCol   >= 0 ? (parseFloat(row[maxCol])   || 0) : 0,
      avg:     avgVal,
      total:   totalCol >= 0 ? (parseInt(row[totalCol])   || 0) : 0,
      yours, deficit, spearman, pearson, best, priority, hasCorrData,
    });
  }

  // Sort by priority (signal × gap), not just raw gap
  // Sort: items with correlation data first (by priority), then no-data items by deficit
  items.sort((a, b) => {
    if (a.hasCorrData !== b.hasCorrData) return a.hasCorrData ? -1 : 1;
    return b.priority - a.priority;
  });
  return { items, sheetNames: wb.SheetNames, debugRows: [], spearmanCrit, pearsonCrit };
}

// ── Variations parser (wide format: terms = columns, results = rows) ─
function coraParseVariations(wb) {
  // Try named sheets first, then fall back to any sheet with wide variation data
  const ws = coraFindSheet(wb, [
    'variation', 'variations', 'keyword variation', 'content.*var', 'var.*report', 'var'
  ]) || coraDetectVariationsSheet(wb);
  if (!ws) return { items: [], sheetNames: wb.SheetNames };

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (rows.length < 3) return { items: [], sheetNames: wb.SheetNames };

  // Determine format: wide (terms as columns) or tall (terms as rows)
  // Wide format: first row has many columns, several of which look like keyword phrases
  const firstRow = rows[0] || [];
  const isWide   = firstRow.length > 8;

  if (isWide) {
    return { items: coraParseVarWide(ws, rows), sheetNames: wb.SheetNames };
  }
  // Tall format fallback
  return { items: coraParseVarTall(ws, rows), sheetNames: wb.SheetNames };
}

function coraDetectVariationsSheet(wb) {
  // Try to find any sheet whose first row has many text columns (variation terms)
  for (const name of wb.SheetNames) {
    const ws   = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!rows.length) continue;
    const first = rows[0];
    const textCols = first.filter(c => typeof c === 'string' && c.trim().split(' ').length >= 2);
    if (textCols.length >= 5) return ws;
  }
  return null;
}

function coraParseVarWide(ws, rows) {
  // Row 0 = column headers: [label col, url col?, "# used"?, ...variation terms...]
  // Find data start column: first col whose header looks like a keyword phrase (≥2 words)
  const hdrRow   = rows[0];
  let termStart  = -1;
  const termCols = []; // { col, term }

  for (let c = 0; c < hdrRow.length; c++) {
    const h = String(hdrRow[c] || '').trim();
    if (h.split(' ').length >= 2 && !/^#|^result|^page|^url|^domain/i.test(h)) {
      if (termStart === -1) termStart = c;
      termCols.push({ col: c, term: h });
    }
  }
  if (!termCols.length) return [];

  // Find key rows
  let p1MaxIdx  = -1, p1AvgIdx  = -1, yourIdx = -1;
  for (let r = 1; r < rows.length; r++) {
    const lbl = String(rows[r][0] || rows[r][1] || '').toLowerCase().trim();
    if (/page\s*1\s*max/.test(lbl))                            p1MaxIdx = r;
    if (/page\s*1\s*avg|page\s*1\s*average/.test(lbl))        p1AvgIdx = r;

    // Yellow = user's tracked page
    for (let c = 0; c < Math.min(4, hdrRow.length); c++) {
      if (coraColorType(coraCellFill(ws, r, c)) === 'yellow') { yourIdx = r; break; }
    }
  }

  if (p1AvgIdx === -1 && p1MaxIdx === -1) return [];
  const benchIdx = p1AvgIdx >= 0 ? p1AvgIdx : p1MaxIdx;

  return termCols.map(({ col, term }) => {
    const avg    = parseFloat(rows[benchIdx]?.[col]) || 0;
    const max    = p1MaxIdx >= 0 ? (parseFloat(rows[p1MaxIdx]?.[col]) || 0) : avg;
    const yours  = yourIdx  >= 0 ? (parseFloat(rows[yourIdx]?.[col])  || 0) : 0;
    const deficit = Math.max(0, avg - yours);
    return { term, pages: 0, max, avg, yours, deficit, corr: 0 };
  })
  .filter(i => i.avg > 0 || i.deficit > 0)
  .sort((a, b) => b.deficit - a.deficit);
}

function coraParseVarTall(ws, rows) {
  // Tall format: term in first column, metrics in subsequent columns
  const { map, rowIdx } = coraHeaderMap(rows, ['variation', 'keyword', 'term', 'phrase', 'deficit'], 20);
  if (rowIdx === -1) return [];

  const termCol = Math.max(0, coraCol(map, 'variation', 'keyword', 'term', 'phrase', 'word'));
  const avgCol  = coraCol(map, 'avg', 'average');
  const yrCol   = coraCol(map, 'your count', 'you', 'your', 'count');
  const defCol  = coraCol(map, 'deficit');

  const items = [];
  for (let r = rowIdx + 1; r < rows.length; r++) {
    const row  = rows[r];
    const term = String(row[termCol] ?? '').trim();
    if (!term) continue;
    const avgVal  = avgCol >= 0 ? (parseFloat(row[avgCol]) || 0) : 0;
    const yours   = yrCol  >= 0 ? (parseFloat(row[yrCol])  || 0) : 0;
    const deficit = defCol >= 0 ? (parseFloat(row[defCol]) || 0) : Math.max(0, avgVal - yours);
    items.push({ term, pages: 0, max: 0, avg: avgVal, yours, deficit, corr: 0 });
  }
  return items.sort((a, b) => b.deficit - a.deficit);
}

// ── Grades parser ────────────────────────────────────────────
function coraParseGrades(wb) {
  const KNOWN_CATS = [
    'Page Size','Meta Tags','Title Tags','Headings','Navigation',
    'Content Tuning','Content Formatting','Images','Videos',
    'Sentiment','Keyword Frequency','Trust','Forms','Ratings & Reviews',
    'Open Graph','Authorship','Social Integration','Google Presentation',
    'Links on Page','Fringe','Misc',
  ];
  const GRADE_RE = /^[A-F][+-]?$/;
  const grades   = [];
  const seen     = new Set();

  for (const pat of [/basic.?tuning/i, /intermediate.?tuning/i]) {
    const wsName = wb.SheetNames.find(n => pat.test(n));
    if (!wsName) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wsName], { header: 1, defval: '' });
    let curCat = null, curGrade = null;

    for (const row of rows) {
      const texts  = row.map(c => String(c ?? '').trim());
      const joined = texts.join(' ');
      const cat    = KNOWN_CATS.find(c => joined.toLowerCase().includes(c.toLowerCase()));

      if (cat) {
        if (curCat && curGrade && !seen.has(curCat)) { grades.push({ category: curCat, grade: curGrade }); seen.add(curCat); }
        curCat   = cat;
        curGrade = texts.find(t => GRADE_RE.test(t)) ?? null;
      } else if (curCat) {
        const g = texts.find(t => GRADE_RE.test(t));
        if (g && !curGrade) curGrade = g;
      }
    }
    if (curCat && curGrade && !seen.has(curCat)) { grades.push({ category: curCat, grade: curGrade }); seen.add(curCat); }
  }

  return grades;
}

// ── SheetJS loader ───────────────────────────────────────────
async function coraLoadXLSX() {
  if (!window.XLSX) throw new Error('SheetJS not loaded — please refresh the page and try again.');
}

async function coraHandleFile(file) {
  const upload = document.getElementById('cora-upload');
  upload.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted);font-size:15px">⏳ Parsing report…</div>';
  try {
    await coraLoadXLSX();
    const buf  = await file.arrayBuffer();
    const wb   = XLSX.read(buf, { type: 'array', cellStyles: true });

    const lsiResult = coraParseLSI(wb);
    const varResult = coraParseVariations(wb);
    coraReport = {
      fileName:   file.name,
      meta:       coraParseMeta(wb),
      roadMap:    coraParseRoadMap(wb),
      lsi:        lsiResult.items,
      variations: varResult.items,
      grades:     coraParseGrades(wb),
      sheets:     wb.SheetNames,
      lsiSheets:      lsiResult.sheetNames,
      lsiDebug:       lsiResult.debugRows,
      lsiCritSpearman: lsiResult.spearmanCrit,
      lsiCritPearson:  lsiResult.pearsonCrit,
    };
    // Validate domain matches active RT client, then tag it
    const rtClient = rtActiveClient();
    if (rtClient) {
      const normalize = d => String(d || '').toLowerCase().replace(/^www\./, '').replace(/\/.*$/, '').trim();
      const coraDomain = normalize(coraReport.meta?.domain);

      if (coraDomain) {
        // Collect unique domains from all client keyword URLs
        const clientDomains = new Set();
        (rtClient.keywords || []).forEach(kw => {
          [kw.url, kw.targetUrl].forEach(u => {
            try { clientDomains.add(normalize(new URL(u).hostname)); } catch {}
          });
        });

        const matched = clientDomains.size === 0
          || [...clientDomains].some(d => d === coraDomain || d.includes(coraDomain) || coraDomain.includes(d));

        if (!matched) {
          const clientList = [...clientDomains].join(', ') || '(no URLs set on this client)';
          const proceed = confirm(
            `⚠️ Domain mismatch\n\nThis Cora report is for:  ${coraDomain}\nCurrent client URLs:       ${clientList}\n\nAssociate this report with "${rtClient.name}" anyway?`
          );
          if (!proceed) return;
        }
      }

      rtClient.coraFileName = file.name;
      rtClient.coraDomain   = coraDomain;
      rtSave();
      rtRender();
    }
    coraRender();
  } catch (err) {
    upload.innerHTML = `
      <div class="cora-upload-inner" style="text-align:center">
        <div style="color:var(--danger);margin-bottom:12px;font-size:14px">❌ ${escHtml(err.message)}</div>
        <button class="btn btn-ghost" id="cora-retry-btn">Try Again</button>
      </div>`;
    document.getElementById('cora-retry-btn').addEventListener('click', coraReset);
  }
}

// ── render ───────────────────────────────────────────────────
function coraReset() {
  coraReport  = null;
  coraFilters = { effort: 'all', corr: 'all' };
  document.getElementById('cora-view').classList.add('hidden');
  const upload = document.getElementById('cora-upload');
  upload.innerHTML = `
    <div class="cora-upload-inner">
      <div class="cora-upload-icon">📊</div>
      <div class="cora-upload-title">Cora SEO Report Analyzer</div>
      <div class="cora-upload-sub">Upload your Cora Excel report (.xlsx) to get an expert priority breakdown of what to fix and why</div>
      <input type="file" id="cora-file-input" accept=".xlsx,.xls" style="display:none">
      <button class="btn btn-primary" id="cora-browse-btn">Upload Report</button>
      <div class="cora-upload-hint">Or drag and drop the .xlsx file anywhere in this area</div>
    </div>`;
  upload.classList.remove('hidden');
  coraBindUpload();
}

function coraRender() {
  document.getElementById('cora-upload').classList.add('hidden');
  document.getElementById('cora-view').classList.remove('hidden');

  const m     = coraReport.meta;
  const parts = [];
  if (m.keyword)  parts.push(`<strong>${escHtml(m.keyword)}</strong>`);
  if (m.domain)   parts.push(`<span class="cora-meta-dim">${escHtml(m.domain)}</span>`);
  if (m.date)     parts.push(`<span class="cora-meta-dim">${escHtml(m.date)}</span>`);
  parts.push(`<span class="cora-meta-dim">${escHtml(coraReport.fileName)}</span>`);
  document.getElementById('cora-meta-bar').innerHTML = parts.join(' <span class="cora-sep">·</span> ');

  // Reset sub-tabs to Road Map
  document.querySelectorAll('.cora-stab').forEach((b, i) => b.classList.toggle('active', i === 0));
  document.querySelectorAll('.cora-section').forEach((s, i) => {
    s.classList.toggle('active', i === 0);
    s.classList.toggle('hidden', i !== 0);
  });

  coraRenderRoadMap();
  coraRenderVariations();
  coraRenderLSI();
  coraRenderGrades();
}

function coraFilteredRoadMap() {
  return (coraReport?.roadMap ?? []).filter(item => {
    if (coraFilters.effort === 'easy' && !item.easy)              return false;
    if (coraFilters.effort === 'hard' &&  item.easy)              return false;
    if (coraFilters.corr   !== 'all'  && item.corrType !== coraFilters.corr) return false;
    return true;
  });
}

function coraRMRow(item) {
  const LABEL    = { green: '🟢 Universal', black: '⚫ Competitor', red: '🔴 Opportunity' };
  const CLS      = { green: 'cora-badge-green', black: 'cora-badge-black', red: 'cora-badge-red' };
  const CAT_SHORT = { 'On Page':'On Page', 'Off Page':'Off Page', 'Web Development':'Web Dev', 'Academic':'Academic', 'Configuration':'Config' };
  const TYPE_CLS  = { Variations:'cora-ft-var', LSI:'cora-ft-lsi', Entities:'cora-ft-ent', Tags:'cora-ft-tag', Words:'cora-ft-word', Links:'cora-ft-link', Backlinks:'cora-ft-link', Other:'cora-ft-other' };
  const catShort  = CAT_SHORT[item.category] || item.category;
  const typeCls   = TYPE_CLS[item.factorType] || 'cora-ft-other';
  return `
    <tr class="cora-rm-row ${item.corrType === 'green' ? 'cora-row-green' : item.corrType === 'red' ? 'cora-row-red' : ''}${item.done ? ' cora-row-done' : ''}">
      <td><span class="cora-type-badge ${CLS[item.corrType] || ''}">${LABEL[item.corrType] || item.corrType}</span></td>
      <td class="cora-factor-cell">${escHtml(item.factor)}${item.top200 ? ' <span class="cora-top200">★</span>' : ''}</td>
      <td><span class="cora-ft-badge ${typeCls}">${escHtml(item.factorType)}</span></td>
      <td style="font-size:11px;color:var(--text-muted)">${escHtml(catShort)}</td>
      <td>${item.easy ? '<span class="cora-easy-badge">⚡ Easy</span>' : '<span class="cora-hard-badge">🔧 Hard</span>'}</td>
      <td style="text-align:right"><strong class="cora-gap-val">+${item.deficit}</strong></td>
    </tr>`;
}

function coraRenderRoadMap() {
  const all    = coraReport?.roadMap ?? [];
  const items  = coraFilteredRoadMap();
  const nGreen = all.filter(i => i.corrType === 'green').length;
  const nEasy  = all.filter(i => i.easy).length;

  document.getElementById('cora-rm-stats').innerHTML =
    `<span>${all.length} deficient factors</span>`
    + `<span class="cora-sep">·</span><span style="color:#00B050;font-weight:600">${nGreen} universal</span>`
    + `<span class="cora-sep">·</span><span style="color:var(--accent);font-weight:600">${nEasy} easy wins</span>`
    + `<span class="cora-sep">·</span><span>${items.length} shown</span>`;

  // Update phase toggle button label
  const phBtn = document.getElementById('cora-phase-toggle');
  if (phBtn) phBtn.classList.toggle('active', coraGroupByPhase);

  const tbody = document.getElementById('cora-rm-tbody');
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px">No factors match the current filters.</td></tr>';
    return;
  }

  if (!coraGroupByPhase) {
    tbody.innerHTML = items.map(coraRMRow).join('');
    return;
  }

  // Group by phase (item.phase = "Phase 1: Title & Headings")
  const grouped = {};
  items.forEach(item => {
    const ph = item.phase || 'Other';
    if (!grouped[ph]) grouped[ph] = [];
    grouped[ph].push(item);
  });

  const sortedPhases = Object.keys(grouped).sort((a, b) => {
    const na = parseInt((a.match(/\d+/) || [])[0] || '999');
    const nb = parseInt((b.match(/\d+/) || [])[0] || '999');
    return na - nb;
  });

  let html = '';
  sortedPhases.forEach(ph => {
    const phItems = grouped[ph];
    const nE = phItems.filter(i => i.easy).length;
    const nG = phItems.filter(i => i.corrType === 'green').length;
    html += `<tr class="cora-phase-hdr">
      <td colspan="6">
        <span class="cora-phase-label">${escHtml(ph)}</span>
        <span class="cora-phase-meta">${phItems.length} factor${phItems.length !== 1 ? 's' : ''}</span>
        ${nG ? `<span class="cora-phase-tag cora-phase-tag-green">${nG} 🟢</span>` : ''}
        ${nE ? `<span class="cora-phase-tag cora-phase-tag-easy">${nE} ⚡ easy</span>` : ''}
      </td>
    </tr>`;
    html += phItems.map(coraRMRow).join('');
  });

  tbody.innerHTML = html;
}

function coraRenderVariations() {
  const items = coraReport?.variations ?? [];
  const tbody = document.getElementById('cora-var-tbody');
  if (!tbody) return;

  if (!items.length) {
    const sheets = (coraReport.sheets || []).join(', ') || 'none detected';
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px;line-height:1.6">
      No Variations data detected.<br>
      <span style="font-size:12px">Available sheets: <strong>${escHtml(sheets)}</strong></span><br>
      <span style="font-size:11px;color:var(--text-muted)">Cora's Variations data may be on the Overview or Measurement Data sheet.</span>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = items.map(item => `
    <tr>
      <td class="cora-term-cell"><strong>${escHtml(item.term)}</strong></td>
      <td style="text-align:right;color:var(--text-muted);font-size:12px">${item.pages || '—'}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${item.avg ? item.avg.toFixed(1) : '—'}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${item.yours}</td>
      <td style="text-align:right"><strong class="cora-gap-val">${item.deficit > 0 ? '+' + Math.ceil(item.deficit) : '—'}</strong></td>
    </tr>`).join('');
}

function coraRenderLSI() {
  const items = coraReport?.lsi ?? [];
  const tbody = document.getElementById('cora-lsi-tbody');

  if (!items.length) {
    const sheets = (coraReport?.lsiSheets || coraReport?.sheets || []).join(', ') || 'none detected';
    const debug  = (coraReport?.lsiDebug || []).map(escHtml).join('<br>');
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:left;color:var(--text-muted);padding:24px">
      <div style="margin-bottom:8px">No LSI data parsed. Available sheets: <strong>${escHtml(sheets)}</strong></div>
      ${debug ? `<div style="font-size:11px;font-family:monospace;line-height:1.6;color:var(--text-muted)">First rows of LSI sheet:<br>${debug}</div>` : ''}
    </td></tr>`;
    return;
  }

  // Build expert analysis panel above table
  const analysisEl = document.getElementById('cora-lsi-analysis');
  if (analysisEl) {
    const termStrength = t => Math.abs(t.best);
    const isStrong     = t => t.hasCorrData && termStrength(t) >= 0.5;
    const isModerate   = t => t.hasCorrData && termStrength(t) >= 0.25 && termStrength(t) < 0.5;
    const isWeak       = t => t.best < -0.15 && termStrength(t) < 0.25;

    const strongCount   = items.filter(isStrong).length;
    const moderateCount = items.filter(isModerate).length;

    // Top terms to add: negative Best of Both (↑ add signal), must have a deficit
    // Include strong (≥0.5), moderate (≥0.25), and weak (≥0.15) — sorted by priority already
    const addTerms = items.filter(i => i.best < -0.15 && i.deficit > 0).slice(0, 15);

    const chipStrengthClass = t => {
      if (isStrong(t))   return 'cora-term-chip cora-chip-strong';
      if (isModerate(t)) return 'cora-term-chip cora-chip-mod';
      return 'cora-term-chip cora-chip-weak';
    };
    const chipBadge = t => {
      if (isStrong(t))   return '<span class="cora-chip-badge cora-chip-badge-strong">🔥</span>';
      if (isModerate(t)) return '<span class="cora-chip-badge cora-chip-badge-mod">⚡</span>';
      return '';
    };

    // Group by word count, within each group strong→moderate→weak order is preserved
    // (items are already sorted by priority = |best| × log1p(deficit))
    const byWords = {};
    addTerms.forEach(t => {
      const wc  = Math.min(t.words || t.term.split(/\s+/).length, 4);
      const key = wc >= 4 ? '4+' : String(wc);
      (byWords[key] = byWords[key] || []).push(t);
    });
    const wordGroups = Object.entries(byWords).sort((a, b) => a[0].localeCompare(b[0]));

    const sCrit = coraReport?.lsiCritSpearman;
    const pCrit = coraReport?.lsiCritPearson;
    const critNote = (sCrit || pCrit)
      ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
           Cora significance threshold: Spearman |r| ≥ <strong>${sCrit ?? '—'}</strong> · Pearson |r| ≥ <strong>${pCrit ?? '—'}</strong>.
           Terms below threshold are weak signals — add them where they fit naturally, don't force them.
         </div>`
      : '';

    analysisEl.innerHTML = `
      <div class="cora-lsi-analysis-box">
        <h4 style="margin:0 0 8px;font-size:13px;color:var(--text)">📊 LSI Analysis Summary</h4>
        ${critNote}
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px">
          <span class="cora-stat-pill" style="background:rgba(255,100,0,.12);color:#ff6400">🔥 ${strongCount} strong signals</span>
          <span class="cora-stat-pill" style="background:rgba(67,97,238,.12);color:#4361ee">⚡ ${moderateCount} moderate signals</span>
          <span class="cora-stat-pill" style="background:rgba(0,176,80,.12);color:#00B050">↑ ${addTerms.length} terms to add</span>
        </div>
        ${addTerms.length ? `
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">
          Top terms to add — negative Best of Both = more usage → better rank.
          <span style="margin-left:8px">🔥 strong (|r|≥0.5) &nbsp;⚡ moderate (|r|≥0.25) &nbsp;· weak</span>
        </div>
        ${wordGroups.map(([wc, terms]) => `
          <div style="margin-bottom:8px">
            <span style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em">${wc === '1' ? '1-word' : wc === '4+' ? '4+ word' : wc+'-word'} terms</span>
            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">
              ${terms.map(t => `
                <span class="${chipStrengthClass(t)}" title="Best of Both: ${t.best.toFixed(3)} | Spearman: ${t.spearman.toFixed(3)} | Pearson: ${t.pearson.toFixed(3)} | Add ~${Math.ceil(t.deficit)} more mentions">
                  ${chipBadge(t)}${escHtml(t.term)} <em>+${Math.ceil(t.deficit)}</em>
                </span>`).join('')}
            </div>
          </div>`).join('')}
        ` : '<div style="font-size:12px;color:var(--text-muted)">No negative-correlation terms found — review the full table below.</div>'}
      </div>`;
  }

  const miniBar = (v, label) => {
    if (v === 0 && label === undefined) return '<span style="color:var(--text-muted);font-size:11px">—</span>';
    const pct   = Math.min(Math.abs(v) * 100, 100).toFixed(0);
    const color = v < 0 ? '#4361ee' : v > 0 ? '#e05c5c' : '#888';
    const val   = label ?? v.toFixed(3);
    return `<span style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap">
      <span style="display:inline-block;width:36px;height:4px;background:var(--border);border-radius:2px;overflow:hidden;flex-shrink:0">
        <span style="display:block;width:${pct}%;height:100%;background:${color};border-radius:2px"></span>
      </span>
      <span style="font-size:11px;font-variant-numeric:tabular-nums;color:${color}">${val}</span>
    </span>`;
  };

  const priorityBadge = item => {
    const abs = Math.abs(item.best);
    if (abs >= 0.5) return '<span class="cora-pri cora-pri-strong">🔥 Strong</span>';
    if (abs >= 0.25) return '<span class="cora-pri cora-pri-med">⚡ Moderate</span>';
    return '<span class="cora-pri cora-pri-weak">· Weak</span>';
  };

  const dirLabel = v => {
    if (v < -0.15) return '<span title="More usage → better rank — add this term" style="color:#00B050;font-size:11px">↑ add</span>';
    if (v >  0.15) return '<span title="Possible over-optimization signal" style="color:#e05c5c;font-size:11px">⚠ check</span>';
    return '<span style="color:var(--text-muted);font-size:11px">~</span>';
  };

  tbody.innerHTML = items.slice(0, 300).map(item => `
    <tr>
      <td class="cora-term-cell">
        ${priorityBadge(item)}
        <strong style="margin-left:6px">${escHtml(item.term)}</strong>
        ${dirLabel(item.best)}
      </td>
      <td style="text-align:right;color:var(--text-muted);font-size:12px">${item.pages || '—'}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${item.avg ? item.avg.toFixed(1) : '—'}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${item.yours}</td>
      <td style="text-align:right"><strong class="cora-gap-val">+${Math.ceil(item.deficit)}</strong></td>
      <td style="text-align:right">${miniBar(item.spearman)}</td>
      <td style="text-align:right">${miniBar(item.pearson)}</td>
      <td style="text-align:right">${miniBar(item.best)}</td>
    </tr>`).join('');
}

function coraRenderGrades() {
  const grades = coraReport?.grades ?? [];
  const grid   = document.getElementById('cora-grades-grid');

  if (!grades.length) {
    grid.innerHTML = '<div class="cora-grades-empty">No grade data detected. Check that the report has Basic Tunings or Intermediate Tunings sheets.</div>';
    return;
  }

  const gradeColor = {
    'A+':'#00B050','A':'#00B050','A-':'#4EA72A',
    'B+':'#4EA72A','B':'#92D050','B-':'#BFBF00',
    'C+':'#FFC000','C':'#FFC000','C-':'#FF7300',
    'D+':'#FF7300','D':'#C00000','D-':'#C00000',
    'F' :'#A50000',
  };

  const GRADE_RECS = {
    default: {
      A: 'Maintain current level',
      B: 'Minor improvements available',
      C: 'Moderate gaps — worth addressing',
      D: 'Significant gaps — prioritize',
      F: 'Critical gap — fix first',
    },
    'Page Size':          { F:'Reduce page weight vs top 10',           D:'Trim scripts & images for load speed' },
    'Meta Tags':          { F:'Fix title, description & robots meta',   D:'Optimize meta tags with keyword variants' },
    'Title Tags':         { F:'Rewrite title tags with primary keyword', D:'Tune title length & keyword order' },
    'Headings':           { F:'Add keyword-rich H1/H2/H3 structure',    D:'Expand headings with semantic variants' },
    'Navigation':         { F:'Improve internal links & anchor text',   D:'Add keyword-relevant nav links' },
    'Content Tuning':     { F:'Increase on-page keyword coverage',      D:'Add related terms & semantic variations' },
    'Content Formatting': { F:'Add lists, bold & paragraph breaks',     D:'Improve content structure & scannability' },
    'Images':             { F:'Add alt text & keyword file names',      D:'Optimize image context & descriptions' },
    'Videos':             { F:'Embed relevant video content',           D:'Add video with keyword-rich titles' },
    'Sentiment':          { F:'Match tone of top-ranking pages',        D:'Balance positive/neutral sentiment' },
    'Keyword Frequency':  { F:'Increase keyword density in content',    D:'Add keyword variations throughout' },
    'Trust':              { F:'Add author bio, citations & trust signals', D:'Improve credibility indicators' },
    'Forms':              { F:'Add or optimize contact/lead forms',     D:'Improve form visibility & placement' },
    'Ratings & Reviews':  { F:'Add review schema & user ratings',       D:'Improve review content & structured data' },
    'Open Graph':         { F:'Add OG tags for social sharing',         D:'Complete Open Graph metadata' },
    'Authorship':         { F:'Add author markup & credentials',        D:'Strengthen authorship signals' },
    'Social Integration': { F:'Add social sharing & profile links',     D:'Improve social signal indicators' },
    'Fringe':             { F:'Fix canonicals, schema & speed signals', D:'Address technical SEO gaps' },
    'Misc':               { F:'Check remaining miscellaneous factors',  D:'Address lower-priority items' },
  };

  grid.innerHTML = grades.map(({ category, grade }) => {
    const catTips = GRADE_RECS[category] || {};
    const gradeKey = grade.replace(/[+-]$/, ''); // strip +/- for tip lookup
    const rec = catTips[gradeKey] || catTips[grade] || GRADE_RECS.default[gradeKey] || GRADE_RECS.default[grade] || '';
    return `
    <div class="cora-grade-card">
      <div class="cora-grade-letter" style="color:${gradeColor[grade] || '#888'}">${escHtml(grade)}</div>
      <div class="cora-grade-info">
        <div class="cora-grade-cat">${escHtml(category)}</div>
        ${rec ? `<div class="cora-grade-rec">${escHtml(rec)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function coraCopyBrief() {
  if (!coraReport) return;
  const kw   = coraReport.meta?.keyword || '(keyword)';
  const rm   = coraReport.roadMap ?? [];
  const lsi  = coraReport.lsi ?? [];

  const section = (title, rows) =>
    rows.length ? [`\n━━ ${title} ━━`, ...rows].join('\n') : '';

  const text = [
    `SEO ACTION BRIEF — ${kw}`,
    `Source: ${coraReport.fileName} · LLAMASEO · ${new Date().toLocaleDateString()}`,
    section('QUICK WINS (🟢 Universal + ⚡ Easy)',
      rm.filter(i => i.corrType === 'green' && i.easy)
        .map(i => `• ${i.factor}: need +${i.deficit} (yours ${i.yourVal} → target ${i.goal})`)),
    section('🟢 Universal — Hard (dev / off-page)',
      rm.filter(i => i.corrType === 'green' && !i.easy)
        .map(i => `• ${i.factor}: need +${i.deficit}`)),
    section('⚫ Competitor-specific — Easy',
      rm.filter(i => i.corrType === 'black' && i.easy)
        .map(i => `• ${i.factor}: need +${i.deficit}`)),
    section('⚫ Competitor-specific — Hard',
      rm.filter(i => i.corrType === 'black' && !i.easy)
        .map(i => `• ${i.factor}: need +${i.deficit}`)),
    section('🔴 Opportunity factors (test carefully)',
      rm.filter(i => i.corrType === 'red')
        .map(i => `• ${i.factor}: need +${i.deficit}`)),
    section('TOP LSI CONTENT GAPS (add to content)',
      lsi.slice(0, 20)
        .map(t => `• "${t.term}" — add ${Math.ceil(t.deficit)} (yours: ${t.yours}, competitor avg: ${t.avg.toFixed(1)})`)),
  ].filter(Boolean).join('\n');

  navigator.clipboard.writeText(text).then(() => {
    const btn  = document.getElementById('cora-copy-btn');
    const orig = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  });
}

// ── bind upload events ───────────────────────────────────────
function coraBindUpload() {
  const zone  = document.getElementById('cora-upload');
  const btn   = document.getElementById('cora-browse-btn');
  const input = document.getElementById('cora-file-input');

  if (btn)   btn.addEventListener('click',  () => input.click());
  if (input) input.addEventListener('change', e => { if (e.target.files[0]) coraHandleFile(e.target.files[0]); });

  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('cora-drag'); });
  zone.addEventListener('dragleave', ()  => zone.classList.remove('cora-drag'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('cora-drag');
    const f = e.dataTransfer.files[0];
    if (f) coraHandleFile(f);
  });
}

function coraInit() {
  coraBindUpload();

  document.getElementById('cora-new-btn').addEventListener('click', coraReset);
  document.getElementById('cora-watch-btn').addEventListener('click', coraWatchStart);
  document.getElementById('cora-watch-btn-view').addEventListener('click', coraWatchStart);

  document.querySelectorAll('.cora-stab').forEach(btn => {
    btn.addEventListener('click', () => {
      const stab = btn.dataset.stab;
      document.querySelectorAll('.cora-stab').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.cora-section').forEach(s => {
        s.classList.toggle('active', s.id === `cora-sec-${stab}`);
        s.classList.toggle('hidden', s.id !== `cora-sec-${stab}`);
      });
    });
  });

  document.querySelectorAll('.cora-fbtn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.fk;
      document.querySelectorAll(`.cora-fbtn[data-fk="${key}"]`).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      coraFilters[key] = btn.dataset.fv;
      coraRenderRoadMap();
    });
  });

  document.getElementById('cora-phase-toggle').addEventListener('click', btn => {
    coraGroupByPhase = !coraGroupByPhase;
    document.getElementById('cora-phase-toggle').classList.toggle('active', coraGroupByPhase);
    coraRenderRoadMap();
  });

  document.getElementById('cora-copy-btn').addEventListener('click', coraCopyBrief);

  document.getElementById('cora-lsi-copy-btn').addEventListener('click', () => {
    const top = (coraReport?.lsi ?? []).slice(0, 20);
    if (!top.length) return;
    const text = 'TOP LSI GAPS:\n' + top.map(t =>
      `"${t.term}" — add ${Math.ceil(t.deficit)} (yours: ${t.yours}, avg: ${t.avg.toFixed(1)})`).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      const btn  = document.getElementById('cora-lsi-copy-btn');
      const orig = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    });
  });

  document.getElementById('cora-lsi-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#cora-lsi-tbody tr').forEach(tr => {
      tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
}

/* ── START ── */
init();
