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
  dramatic:   'dramatic moody photography, cinematic lighting, rich shadows, high contrast, no text',
  // Illustrated presets — used by the Article Image tool. The two older UIs list
  // their options explicitly in index.html, so these are additive for them.
  vector:     'flat vector illustration, clean geometric shapes, bold flat colors, modern editorial illustration style, no text',
  render3d:   'polished 3D render, soft studio lighting, subtle depth of field, clay-render material feel, no text',
  watercolor: 'soft watercolor illustration, hand-painted texture, gentle color bleeds, light paper grain, no text',
  isometric:  'isometric illustration, 30-degree axonometric view, clean lines, consistent flat lighting, no text',
  lineart:    'minimal line-art illustration, single-weight strokes, generous white space, monochrome, no text'
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

/* ── ACTIVITY LOG ── */
let activityLog   = [];
let actLogPending = [];
let actLogTimer   = null;

function logActivity(entry) {
  const full = { ...entry, ts: new Date().toISOString(), id: '_' + Math.random().toString(36).slice(2, 9) };
  activityLog.unshift(full);
  actLogPending.push(full);
  clearTimeout(actLogTimer);
  actLogTimer = setTimeout(async () => {
    if (!actLogPending.length) return;
    const batch = actLogPending.splice(0);
    try {
      await fetch('/api/activitylog', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: batch }),
      });
    } catch (_) { actLogPending.unshift(...batch); }
  }, 800);
}

/* ── ROUTER ── */
const TAB_ROUTES = {
  dashboard: '/',
  ranks:     '/rank-tracker',
  article:   '/seo-article',
  cora:      '/cora',
  files:     '/files',
  gsc:       '/gsc',
  log:       '/log',
  weekly:    '/weekly-tasks',
  brands:    '/blog-brands',
  images:    '/image-generator',
  indexy:    '/indexy',
  ahrefs:    '/ahrefs',
  artimage:  '/article-image',
};
const ROUTE_TABS  = Object.fromEntries(Object.entries(TAB_ROUTES).map(([tab, path]) => [path, tab]));
const TOOLS_TABS  = new Set(['brands', 'images', 'artimage']);

function switchTab(tab, { pushState = true } = {}) {
  if (!TAB_ROUTES[tab]) tab = 'dashboard';
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  document.getElementById('toolsMenuBtn')?.classList.toggle('active', TOOLS_TABS.has(tab));
  if (tab === 'dashboard') dbRender();
  if (tab === 'files') filesRender();
  if (tab === 'gsc') gscRender();
  if (tab === 'log') logTabRender();
  if (tab === 'weekly') weeklyRender();
  if (tab === 'indexy') { indexyRender(); indexySyncClient(); }
  if (tab === 'ahrefs') ahrefsRender();
  if (tab === 'artimage') aigRender();
  if (pushState) {
    const path = TAB_ROUTES[tab];
    if (window.location.pathname !== path) history.pushState({ tab }, '', path);
  }
}

window.addEventListener('popstate', () => {
  switchTab(ROUTE_TABS[window.location.pathname] || 'dashboard', { pushState: false });
});

/* ── INIT ── */
async function init() {
  const cfg = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
  hasServerKey = !!cfg.hasServerKey;
  hasGcs       = !!cfg.hasGcs;
  hasAA        = !!cfg.hasAA;
  hasPop       = !!cfg.hasPop;
  if (cfg.commit) {
    const el = document.getElementById('build-commit');
    if (el) {
      el.textContent = '#' + cfg.commit;
      if (/^[0-9a-f]{7,}$/i.test(cfg.commit)) el.href = 'https://github.com/pablorgq/seomanager/commit/' + cfg.commit;
      el.style.display = 'inline-block';
    }
  }
  if (hasServerKey) {
    document.getElementById('settingsToggle').style.display = 'none';
  } else {
    apiKey = await Store.get('seomanager_api_key');
    if (apiKey) document.getElementById('apiKeyInput').value = apiKey;
  }
  await rtInit();
  coraInit();
  await weeklyLoadFromServer();
  fetch('/api/auditdata').then(r => r.ok ? r.json() : {}).then(d => { auditData = d || {}; dbRender(); }).catch(() => {});
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

  // Show whichever tab the URL points to (deep link / refresh / back-forward)
  switchTab(ROUTE_TABS[window.location.pathname] || 'dashboard', { pushState: false });
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
  toolsBtn.addEventListener('click', e => {
    e.stopPropagation();
    toolsDrop.classList.toggle('open');
  });
  document.addEventListener('click', () => toolsDrop.classList.remove('open'));
  toolsDrop.addEventListener('click', () => setTimeout(() => toolsDrop.classList.remove('open'), 80));

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
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
let agSavedRun = null;      // kw.popRun carried over from a Rank Tracker "Score" run
let agLastRun  = null;      // params of the report behind the current output, for re-scoring
let agPreTrustText = '';    // article as generated, kept so the trust pass can be reverted
let agTrustNotes   = '';    // the editor's notes from the last trust pass

/* Marker the trust pass uses to split its rewrite from its notes, so the notes
   never leak into the article body, the copy buttons or the saved report. */
const AG_NOTES_MARKER = '===NOTES===';

/* Guardrails folded into every generation prompt. These only stop patterns that
   read as filler or as unverifiable puffery — they never ask the model to add
   anything, so term placement and the POP brief are unaffected. */
const AG_TRUST_RULES = `── TRUST & READABILITY (applies to everything you write) ──
- Never state two different figures for the same fact (years in business, team size, jobs completed). One figure, used consistently.
- No unverifiable superlatives. "The largest fleet in the country", "the first company to do X", "the best in the industry" are not allowed unless the source material backs them up. Use a defensible form instead ("one of the largest fleets serving the region").
- At most 2 calls to action in the whole piece, worded differently. Do NOT end each section with a "Don't let X happen — contact us today" formula.
- Say each idea once. If a cause-and-effect chain (e.g. dust → allergens → health → productivity) belongs to one section, do not restate it in others with new wording.
- Keep one consistent geographic focus from the H1 to the final paragraph. Do not open with a city and close with the whole country.
- Anything that is a genuine enumeration ("A - B - C" run together in a sentence) becomes a real markdown bullet list. Do not invent list items to pad.
- Invent nothing. No certifications, awards, founding years, staff names or testimonials that are not in the source material.`;

/* The full editorial pass, run on demand after generation. Unlike the rules
   above this one is allowed to cut and restructure, so it stays opt-in. */
const AG_TRUST_PASS_PROMPT = `You are editing a local service business's website copy to fix issues that hurt trust with readers and search engines (Google's helpful-content / E-E-A-T signals). Rewrite the content below, applying these fixes:

1. Resolve contradictory or unverifiable credibility claims. If the page states two different "years of experience" figures, or makes an implausible experience claim (e.g. "a century of expertise" for a company that cannot be that old), keep only the specific, verifiable figure and drop the other.
2. Soften or remove unverifiable superlatives. Claims like "the largest fleet in [country]" or "the first company to do X" should either be backed by something checkable or downgraded to a defensible version (e.g. "one of the largest fleets serving [region]").
3. Eliminate repetitive CTA patterns. If the same "Don't let X happen — contact us today" structure repeats across sections, cut it to 1–2 well-placed, naturally varied calls to action.
4. Cut redundant content loops. If the same idea is restated with slightly different wording across sections, consolidate it into one clear section.
5. Fix inconsistent geographic targeting. Keep the location focus consistent throughout — this matters for local SEO relevance.
6. Convert inline dash-separated text into real lists. Anything written as "Item A - Item B - Item C" as running text becomes a proper markdown bulleted list.
7. Preserve all genuine facts. Keep real details like equipment specs, service types, phone numbers, and building/industry types served — only the framing changes, not the underlying facts.

Keep the tone professional and consistent with the original. Do not invent facts that were not in the source. Do not pad sections to hit a word count. Keep the markdown heading structure (# for the H1, ## for section headings).

OUTPUT FORMAT — follow exactly:
First, the rewritten article in markdown. Nothing before it, no preamble.
Then a line containing only ${AG_NOTES_MARKER}
Then a short "Notes" section with two parts:
(a) what was changed and why — one bullet per change
(b) what specific, verifiable details (certifications, real founding year, named staff, local landmarks/neighbourhoods, testimonials) would strengthen the page further if supplied`;

/* Shrink a POP cleanedContentBrief to just what the Article Generator reads.
   rtData is round-tripped whole through /api/rankdata, so the raw brief (which
   carries per-term competitor tables) is far too heavy to persist per keyword. */
function popTrimBrief(cb) {
  if (!cb) return null;
  const trimSection = (arr, limit) => (arr || [])
    .filter(t => t?.contentBrief && t?.term?.phrase)
    .slice(0, limit)
    .map(t => ({
      term: { phrase: t.term.phrase, type: t.term.type || null },
      contentBrief: {
        min:       t.contentBrief.min ?? null,
        max:       t.contentBrief.max ?? null,
        target:    t.contentBrief.target ?? null,
        targetMin: t.contentBrief.targetMin ?? null,
        targetMax: t.contentBrief.targetMax ?? null,
        current:   t.contentBrief.current ?? null,
      },
    }));
  return {
    pageTitle:   trimSection(cb.pageTitle, 20),
    metaTitle:   trimSection(cb.metaTitle || cb.searchEngineTitle, 20),
    subHeadings: trimSection(cb.subHeadings, 30),
    p:           trimSection(cb.p, 60),
  };
}

/* Single source of truth for reading a POP page score out of a create-report
   payload. Score, the Article Generator and the post-generation re-score all
   call this — before, each had its own chain and its own rounding, which is why
   the same page could read 54 in the Rank Tracker and 92.16 in the generator.
   Pass the `.report` object from a create-report poll. Returns a number 0-100
   with one decimal, or null. */
function popPickScore(report) {
  const cb = report?.cleanedContentBrief;

  const unwrap = v => {
    if (v == null) return null;
    if (typeof v === 'number') return v || null;
    if (typeof v === 'string') { const n = parseFloat(v); return (!isNaN(n) && n > 0) ? n : null; }
    if (typeof v !== 'object') return null;
    // prefer a non-zero numeric field; fall back to POP's string variants
    const num = [v.pageScore, v.pScore, v.pTotal, v.current, v.value, v.score, v.percent]
      .map(Number).find(n => !isNaN(n) && n > 0);
    if (num != null) return num;
    const str = [v.pageScoreValue, v.pScoreValue].find(s => s && String(s).trim() !== '');
    return str ? (parseFloat(str) || null) : null;
  };

  const chain = [
    cb?.pageScore, cb?.pTotal, cb?.pScore, cb?.score,
    report?.pageScore, report?.pTotal, report?.pageScoreValue, report?.pScore, report?.score,
  ];
  const raw = chain.find(v => v != null && v !== 0 && v !== '');
  let score = unwrap(raw);
  if (score == null || isNaN(score)) return null;

  // POP returns pageScore two ways: already on 0-100 (54.4, 92.16) or as a
  // fraction of target (1.03 = 103% of target, seen nested as
  // {pageScore: 1.03, pageScoreValue: ""}). Anything <= 5 is read as a ratio —
  // a real page that has content never scores 5/100, so the ambiguous band
  // resolves to the ratio reading. This is the rule the Article Generator
  // already used; the Score button used < 1 instead, which is where the two
  // views diverged.
  if (score > 0 && score <= 5) score = score * 100;
  score = Math.min(100, score);
  return Math.round(score * 100) / 100;              // keep 2dp so every view agrees
}

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
  // The pollers are reused by the post-generation re-score, which runs outside
  // the numbered step list and passes no index.
  if (!agSteps[i]) return;
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

/* The target frequency band for one content-brief term. POP returns the bounds
   as min/max on some payloads and targetMin/targetMax on others — reading only
   one pair silently scored every term against 0. */
function agTermBand(t) {
  const cb = t?.contentBrief || {};
  const num = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
  const min = num(cb.min) ?? num(cb.targetMin) ?? 0;
  const max = num(cb.max) ?? num(cb.targetMax) ?? num(cb.target) ?? 0;
  return { min, max };
}

/* Count whole-word occurrences of a phrase. Without the boundaries "duct"
   matched inside "ducts" and "conduct", inflating every count. */
function agCountPhrase(lowerText, phrase) {
  const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  // \b is useless next to a non-word char, so only anchor the ends that are words
  const pre  = /^\w/.test(phrase) ? '\\b' : '';
  const post = /\w$/.test(phrase) ? '\\b' : '';
  return (lowerText.match(new RegExp(pre + esc + post, 'gi')) || []).length;
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

    // A block whose every line is a bullet becomes a real <ul>. Without this the
    // paragraph branch below joins the lines with spaces, turning a proper list
    // straight back into the "Item A - Item B - Item C" run the trust pass exists
    // to eliminate.
    const rows = line.split('\n').map(r => r.trim()).filter(Boolean);
    if (rows.length && rows.every(r => /^[-*•]\s+/.test(r))) {
      return `<ul>${rows.map(r => `<li>${r.replace(/^[-*•]\s+/, '')}</li>`).join('')}</ul>`;
    }

    let diffCls = '';
    if (origParas.length) {
      const plain = line.replace(/<[^>]+>/g, '');
      const best = Math.max(...origParas.map(op => paraSimScore(plain, op)));
      diffCls = best > 0.72 ? '' : best > 0.22 ? ' diff-modified' : ' diff-added';
    }
    return `<p${diffCls ? ` class="${diffCls.trim()}"` : ''}>${line.replace(/\n/g, ' ')}</p>`;
  }).filter(Boolean).join('\n');
}

/* Local estimate of how well a piece of text covers the POP content brief.
   This is NOT a POP score — it is the share of brief terms whose frequency lands
   in their target band. Use it for a fast, free before/after comparison of two
   texts against the SAME brief; never subtract it from a POP number. The real
   POP score for generated content comes from agRescoreWithPop(). */
function agComputeCoverage(articleText, bodyTerms, titleTerms, h2Items) {
  if (!articleText) return null;
  const lower = articleText.toLowerCase();
  const lines = articleText.split('\n');
  const h1Line = (lines.find(l => l.startsWith('# ')) || '').toLowerCase();
  const h2Lines = lines.filter(l => l.startsWith('## ')).map(l => l.toLowerCase()).join(' ');

  let points = 0, total = 0;

  // Body terms, scored against their target frequency band
  for (const t of bodyTerms) {
    const phrase = (t.term?.phrase || '').toLowerCase().trim();
    const { min, max } = agTermBand(t);
    if (!phrase || max === 0) continue;
    total++;
    const count = agCountPhrase(lower, phrase);
    if (count >= min && count <= max) points += 1;
    else if (count > max)            points += 0.75; // slight over-opt penalty
    else if (count > 0)              points += 0.4;  // present but below target
  }

  // Title terms (should appear in H1)
  for (const t of (titleTerms || [])) {
    if (!t) continue;
    total++;
    if (h1Line.includes(t.toLowerCase())) points += 1;
  }

  // H2 terms
  for (const t of (h2Items || [])) {
    const phrase = (t.term?.phrase || '').toLowerCase().trim();
    if (!phrase) continue;
    total++;
    if (h2Lines.includes(phrase)) points += 1;
  }

  return total ? Math.round((points / total) * 100) : null;
}

/* Renders the score badge. A before → after delta is only ever drawn between two
   POP scores; a local coverage estimate is shown alongside, never subtracted
   from POP's number (that is what produced the meaningless "-39.16"). */
function agRenderScore(popBefore, popAfter, coverage) {
  const badge = document.getElementById('ag-scoreBadge');
  if (!badge) return;
  const bNum = parseFloat(popBefore);
  const cls  = n => n >= 80 ? 'good' : n >= 60 ? 'warn' : 'bad';
  const fmt  = n => Number.isInteger(n) ? String(n) : n.toFixed(2);

  const covChip = coverage && coverage.after != null
    ? `<span class="ag-cov-chip" title="Local estimate: share of brief terms whose frequency lands in its target band. Not a POP score.">Brief coverage: ${
        coverage.before != null ? `${coverage.before}% → ` : ''}<strong>${coverage.after}%</strong></span>`
    : '';

  if (popAfter != null && !isNaN(parseFloat(popAfter))) {
    const aNum  = parseFloat(popAfter);
    const delta = Math.round((aNum - bNum) * 100) / 100;
    const dColor = delta > 0 ? 'var(--green)' : delta < 0 ? 'var(--red)' : 'var(--text-muted)';
    badge.innerHTML =
      `<div class="ag-score-badge ${cls(aNum)}" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span>POP before: <strong>${fmt(bNum)}</strong></span>
        <span style="color:var(--text-muted)">→</span>
        <span>POP after: <strong>${fmt(aNum)} / 100</strong></span>
        <span style="color:${dColor};font-weight:700">${delta >= 0 ? '+' : ''}${delta} pts</span>
        ${covChip}
      </div>`;
  } else {
    badge.innerHTML =
      `<div class="ag-score-badge ${cls(bNum || 0)}" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span>POP score (original page): <strong>${isNaN(bNum) ? '—' : fmt(bNum)} / 100</strong></span>
        ${covChip}
        <button id="ag-verifyBtn" class="ag-verify-btn" title="Publish this article to a temporary URL and run a fresh POP report on it — costs one POP report">Verify score in POP</button>
      </div>`;
    document.getElementById('ag-verifyBtn')?.addEventListener('click', agRescoreWithPop);
  }
}

/* Editorial pass over the generated article: strips contradictory or
   unverifiable claims, collapses repeated CTAs and duplicated ideas, keeps the
   geography consistent and turns inline "A - B - C" runs into real lists.

   Runs on demand rather than automatically because it is allowed to cut text,
   which can move term frequencies — so the coverage estimate is recomputed and
   any POP-verified score is invalidated (the scored text no longer exists). */
async function agTrustPass() {
  if (!agLastRun || !agArticleText) return;
  const btn = document.getElementById('ag-trustBtn');
  const restore = () => { if (btn) { btn.disabled = false; btn.textContent = 'Trust & readability pass'; } };
  if (btn) { btn.disabled = true; btn.textContent = 'Editing…'; }

  const { model, bodyTerms, titleTerms, h2Items, termClassMap, covBefore, popBefore, wcTarget } = agLastRun;

  try {
    const chatHeaders = { 'Content-Type': 'application/json' };
    if (!hasServerKey) {
      const k = apiKey || await Store.get('seomanager_api_key');
      if (k) chatHeaders['x-client-key'] = k;
    }

    agLog('Running trust & readability pass…');
    const res = await fetch('/api/openai/chat', {
      method: 'POST', headers: chatHeaders,
      body: JSON.stringify({
        model, max_tokens: 4000,
        messages: [{ role: 'user', content: `${AG_TRUST_PASS_PROMPT}\n\nCONTENT TO REWRITE:\n---\n${agArticleText}\n---` }],
      }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(`OpenAI ${res.status}: ${err.error?.message || JSON.stringify(err).slice(0, 120)}`);
    }
    const out = (await res.json()).choices[0].message.content || '';

    // Split the rewrite from the editor's notes. If the model ignored the
    // marker, treat the whole reply as article and say the notes are missing
    // rather than silently pasting a "Notes" section into the page copy.
    const idx = out.indexOf(AG_NOTES_MARKER);
    const newText = (idx >= 0 ? out.slice(0, idx) : out).trim();
    agTrustNotes = idx >= 0 ? out.slice(idx + AG_NOTES_MARKER.length).trim() : '';
    if (!newText) throw new Error('The editor returned an empty article');

    agPreTrustText = agPreTrustText || agArticleText;
    agArticleText  = newText;
    agArticleHtml  = agRenderArticle(newText, termClassMap || new Map(), agOriginalContent);
    document.getElementById('ag-articleBox').innerHTML = agArticleHtml;

    // The text changed, so re-measure coverage and drop any POP score that was
    // verified against the previous wording.
    const covAfter = agComputeCoverage(newText, bodyTerms, titleTerms, h2Items);
    agLastRun.covAfter = covAfter;
    agLastRun.popAfter = null;
    const wordCount = newText.split(/\s+/).length;

    agRenderScore(popBefore, null, { before: covBefore, after: covAfter });
    agRenderMetaCards({
      popBefore, popAfter: null, covBefore, covAfter,
      wordCount, wcTarget, termCount: (agLastRun.allTerms || []).length,
    });
    agRenderTrustNotes();
    agLog(`Trust pass done — ${wordCount} words, coverage ${covAfter}%. Re-verify in POP to score the edited text.`);

    // Keep the saved report in step with what is on screen
    agUpdateSavedArticle({ wordCount, covAfter, resetPopAfter: true });
  } catch (e) {
    agLog('Trust pass failed: ' + e.message);
    alert('Trust & readability pass failed:\n\n' + e.message);
  }
  restore();
}

/* Put back the article exactly as generated, before the trust pass. */
function agTrustRevert() {
  if (!agPreTrustText || !agLastRun) return;
  const { bodyTerms, titleTerms, h2Items, termClassMap, covBefore, popBefore, wcTarget } = agLastRun;

  agArticleText = agPreTrustText;
  agArticleHtml = agRenderArticle(agArticleText, termClassMap || new Map(), agOriginalContent);
  document.getElementById('ag-articleBox').innerHTML = agArticleHtml;

  const covAfter  = agComputeCoverage(agArticleText, bodyTerms, titleTerms, h2Items);
  const wordCount = agArticleText.split(/\s+/).length;
  agLastRun.covAfter = covAfter;
  agLastRun.popAfter = null;
  agTrustNotes = '';

  agRenderScore(popBefore, null, { before: covBefore, after: covAfter });
  agRenderMetaCards({ popBefore, popAfter: null, covBefore, covAfter, wordCount, wcTarget, termCount: (agLastRun.allTerms || []).length });
  agRenderTrustNotes();
  agUpdateSavedArticle({ wordCount, covAfter, resetPopAfter: true });
  agLog('Reverted to the article as generated.');
}

/* Keep the auto-saved report in step with the article currently on screen. */
function agUpdateSavedArticle({ wordCount, covAfter, resetPopAfter }) {
  const cid = rtData?.activeClientId;
  const saved = cid && agLastRun ? repGet(cid, agLastRun.keyword) : null;
  if (!saved) return;
  saved.articleText = agArticleText;
  saved.articleHtml = agArticleHtml;
  saved.wordCount   = wordCount;
  saved.covAfter    = covAfter;
  if (resetPopAfter) { saved.scoreAfter = null; saved.scoreAfterSource = null; }
  repSave(saved);
  rtRender(); filesRender();
}

/* The editor's notes panel — what it changed, and what verifiable details would
   strengthen the page. Deliberately outside the article box so it never ends up
   in the copy buttons or the saved page copy. */
function agRenderTrustNotes() {
  const box = document.getElementById('ag-trustNotes');
  if (!box) return;
  if (!agTrustNotes) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'block';
  box.innerHTML =
    `<div class="ag-trust-notes-hd">
      <span>Editor's notes — not part of the article</span>
      <button class="ag-verify-btn" onclick="agTrustRevert()">Revert to generated version</button>
    </div>
    <div class="ag-trust-notes-body">${agRenderNotesHtml(agTrustNotes)}</div>`;
}

/* Minimal markdown for the notes block: headings, bullets, paragraphs. */
function agRenderNotesHtml(text) {
  const lines = String(text).split('\n');
  let html = '', inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { closeList(); continue; }
    const bullet = l.match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${escHtml(bullet[1])}</li>`;
      continue;
    }
    closeList();
    const h = l.match(/^#{1,6}\s+(.*)$/);
    html += h ? `<h4>${escHtml(h[1])}</h4>` : `<p>${escHtml(l)}</p>`;
  }
  closeList();
  return html;
}

/* ═══════════════════════════════════════════════
   SERVICE-PAGE IMAGE GENERATION
   Generate a realistic photo for the page from its keyword + content, at a 3:2
   landscape ratio, downscaled and saved as JPG with an SEO filename + alt text.
   Triggerable from the Article Generator output and from a Rank Tracker row.
   Stored in GCS when configured, so the Rank Tracker only keeps a small URL.
════════════════════════════════════════════════ */

/* Default negatives. OpenAI has no negative-prompt parameter, so these are
   folded into the prompt as "Avoid: …" guidance rather than hard-enforced. */
const IMG_DEFAULT_NEGATIVE = 'AI-generated look, CGI, illustration, cartoon, painting, fake faces, plastic skin, distorted anatomy, extra fingers, duplicate people, unrealistic furniture, dramatic poses, text, logos, watermarks, blurry, low quality';

// Landscape request. gpt-image-1 returns 1536×1024; dall-e-3 remaps to 1792×1024
// (see tryModel). Either way it is a 3:2-ish landscape we then downscale.
const IMG_GEN_SIZE = '1536x1024';
const IMG_DOWNSCALE = 0.5;
const IMG_JPEG_QUALITY = 0.85;

// Context for the currently-open image modal (set by the AG button or an RT row)
let agImageCtx = null;

/* Load a data URL into an <img> element, resolved once decoded. */
function agLoadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode the generated image'));
    img.src = src;
  });
}

/* Downscale a PNG data URL and re-encode as JPEG for a lighter web-ready file. */
async function agDownscaleToJpeg(dataUrl, scale = IMG_DOWNSCALE, quality = IMG_JPEG_QUALITY) {
  const img = await agLoadImage(dataUrl);
  const w = Math.max(1, Math.round((img.naturalWidth  || img.width)  * scale));
  const h = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';            // flatten any transparency for JPEG
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { dataUrl: canvas.toDataURL('image/jpeg', quality), width: w, height: h };
}

/* SEO-friendly filename from the keyword + location, e.g.
   "commercial-duct-cleaning-winnipeg.jpg". */
function agImageFilename(keyword, locName) {
  const cityOnly = String(locName || '').split(',')[0];
  const joined = [keyword, cityOnly].filter(Boolean).join('-').trim();
  // slugify() defaults empty input to "blog"; guard so a missing keyword yields a
  // meaningful name instead.
  const base = joined ? slugify(joined).slice(0, 80) : 'service-image';
  return `${base}.jpg`;
}

/* Build the image prompt from the page's topic, style and negatives. Note this
   does NOT use SAFETY_PREFIX (that is medical-specific) — service pages want a
   generic realistic-workplace scene. */
function agBuildImagePrompt({ keyword, locName, style, negative, extra }) {
  const stylePrompt = STYLE_MAP[style] || STYLE_MAP.realistic;
  const topic = sanitizeTopic(keyword || 'local service');
  const loc = locName ? ` in ${String(locName).split(',')[0]}` : '';
  let p = `Professional real-world photograph for a "${topic}"${loc} service web page. `
        + `Authentic professionals at work in a realistic setting, genuine equipment, natural lighting, candid and trustworthy. `
        + `${stylePrompt}.`;
  if (extra && extra.trim()) p += ` ${extra.trim()}.`;
  if (negative && negative.trim()) p += ` Avoid: ${negative.trim()}.`;
  return p;
}

/* SEO alt text from the content + keyword. Uses a small chat call when a key is
   available; always falls back to a deterministic keyword+location phrase. */
async function agGenerateAltText({ keyword, locName, contentText }) {
  const cityOnly = String(locName || '').split(',')[0];
  const fallback = [keyword, cityOnly].filter(Boolean).join(' in ').slice(0, 120) || keyword || 'service photo';
  try {
    const chatHeaders = { 'Content-Type': 'application/json' };
    if (!hasServerKey) {
      const k = apiKey || await Store.get('seomanager_api_key');
      if (!k) return fallback;
      chatHeaders['x-client-key'] = k;
    }
    const brief = String(contentText || '').replace(/[#*]/g, '').slice(0, 800);
    const prompt = `Write ONE concise alt-text line (max 125 characters) for a realistic photo on a "${keyword}"`
      + `${cityOnly ? ` in ${cityOnly}` : ''} service web page. Describe a plausible real scene. `
      + `No quotes, no "image of"/"photo of", no trailing period.${brief ? `\n\nPage context:\n${brief}` : ''}`;
    const res = await fetch('/api/openai/chat', {
      method: 'POST', headers: chatHeaders,
      body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 60, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) return fallback;
    const out = (await res.json()).choices?.[0]?.message?.content || '';
    const alt = out.trim().replace(/^["']|["']$/g, '').replace(/\.$/, '').slice(0, 125);
    return alt || fallback;
  } catch { return fallback; }
}

/* Find the keyword object + client for a saved keyword, so image results can be
   persisted back onto the Rank Tracker row. */
function agFindKwByKeyword(keyword, clientId) {
  const cid = clientId || rtData?.activeClientId;
  const client = (rtData?.clients || []).find(c => c.id === cid);
  const kw = client?.keywords?.find(k => (k.keyword || '').toLowerCase().trim() === (keyword || '').toLowerCase().trim());
  return { client, kw };
}

/* Open the image modal from the Article Generator output. */
function agOpenImageModalFromArticle() {
  if (!agLastRun) return;
  agImageCtx = {
    keyword:     agLastRun.keyword,
    locName:     agLastRun.locName,
    strategy:    agLastRun.strategy,
    contentText: agArticleText,
    clientId:    rtData?.activeClientId,
    kwId:        agFindKwByKeyword(agLastRun.keyword, rtData?.activeClientId).kw?.id || null,
  };
  agShowImageModal();
}

/* Open the image modal from a Rank Tracker row. Pulls page content from the
   saved report when one exists, so the prompt/alt are content-aware. */
function agOpenImageModal(kwId) {
  const client = rtActiveClient();
  const kw = client?.keywords?.find(k => k.id === kwId);
  if (!kw) return;
  const rep = repGet(client.id, kw.keyword);
  agImageCtx = {
    keyword:     kw.keyword,
    locName:     client?.popLocation,
    strategy:    kw.popStrategy,
    contentText: rep?.articleText || '',
    clientId:    client?.id,
    kwId:        kw.id,
  };
  agShowImageModal();
}

/* Render + open the modal, prefilled from agImageCtx and any existing image. */
function agShowImageModal() {
  const ctx = agImageCtx;
  const { kw } = agFindKwByKeyword(ctx.keyword, ctx.clientId);
  const existing = kw?.image || null;

  document.getElementById('agimg-title').textContent = ctx.keyword || 'Service image';
  document.getElementById('agimg-negative').value = IMG_DEFAULT_NEGATIVE;
  document.getElementById('agimg-prompt').value =
    agBuildImagePrompt({ keyword: ctx.keyword, locName: ctx.locName, style: 'realistic', negative: '' });
  document.getElementById('agimg-alt').value = existing?.alt || '';
  document.getElementById('agimg-style').value = existing?.style || 'realistic';

  const preview = document.getElementById('agimg-preview');
  if (existing?.url) {
    preview.innerHTML = `<img src="${escHtml(existing.url)}" alt="${escHtml(existing.alt || '')}" />
      <div class="agimg-existing-note">Existing image${existing.date ? ` · ${escHtml(existing.date)}` : ''} — <a href="${escHtml(existing.url)}" target="_blank" rel="noopener">open</a></div>`;
  } else {
    preview.innerHTML = '<div class="agimg-placeholder">No image yet — set the options and click Generate.</div>';
  }
  document.getElementById('agimg-actions').style.display = 'none';
  document.getElementById('agimg-status').textContent = '';

  document.getElementById('agImageModal').classList.add('open');
}

function agCloseImageModal() {
  document.getElementById('agImageModal').classList.remove('open');
}

// Holds the freshly generated (pre-persist) result for download/upload actions
let agImageResult = null;

/* Regenerate the prompt from the current keyword + selected style (keeps any
   custom "extra" the user typed after the auto-built base is discarded). */
function agRebuildImagePrompt() {
  if (!agImageCtx) return;
  const style = document.getElementById('agimg-style').value;
  document.getElementById('agimg-prompt').value =
    agBuildImagePrompt({ keyword: agImageCtx.keyword, locName: agImageCtx.locName, style, negative: '' });
}

async function agRunImageGen() {
  if (!agImageCtx) return;
  const btn = document.getElementById('agimg-genBtn');
  const status = document.getElementById('agimg-status');
  const setBusy = (t) => { btn.disabled = true; btn.textContent = t; };

  const style    = document.getElementById('agimg-style').value;
  const promptEl = document.getElementById('agimg-prompt').value.trim();
  const negative = document.getElementById('agimg-negative').value.trim();
  const prompt   = negative && !/avoid:/i.test(promptEl) ? `${promptEl} Avoid: ${negative}.` : promptEl;

  try {
    const key = await getApiKey();
    setBusy('Generating…'); status.textContent = 'Calling the image model…';
    const raw = await generateImage(key, prompt, IMG_GEN_SIZE);

    setBusy('Processing…'); status.textContent = 'Downscaling and converting to JPG…';
    const jpg = await agDownscaleToJpeg(raw);

    // Alt text: keep the user's if they typed one, else generate
    let alt = document.getElementById('agimg-alt').value.trim();
    if (!alt) {
      status.textContent = 'Writing SEO alt text…';
      alt = await agGenerateAltText({ keyword: agImageCtx.keyword, locName: agImageCtx.locName, contentText: agImageCtx.contentText });
      document.getElementById('agimg-alt').value = alt;
    }

    const filename = agImageFilename(agImageCtx.keyword, agImageCtx.locName);
    agImageResult = { dataUrl: jpg.dataUrl, filename, alt, style, width: jpg.width, height: jpg.height };

    document.getElementById('agimg-preview').innerHTML =
      `<img src="${jpg.dataUrl}" alt="${escHtml(alt)}" />
       <div class="agimg-dims">${jpg.width}×${jpg.height} · JPG · ${escHtml(filename)}</div>`;
    document.getElementById('agimg-actions').style.display = 'flex';
    status.textContent = hasGcs
      ? 'Generated. Save to store it on the page record, or just download.'
      : 'Generated. Download it — GCS is not configured, so it is not stored in-app.';
  } catch (e) {
    status.textContent = 'Failed: ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Generate';
  }
}

function agDownloadImage() {
  if (agImageResult) downloadDataUrl(agImageResult.dataUrl, agImageResult.filename);
}

/* Persist the generated image: upload to GCS when available, then record a small
   marker on the keyword and the saved report so the Rank Tracker can show it. */
async function agSaveImage() {
  if (!agImageResult || !agImageCtx) return;
  const btn = document.getElementById('agimg-saveBtn');
  const status = document.getElementById('agimg-status');
  btn.disabled = true; btn.textContent = 'Saving…';

  let url = null;
  try {
    if (hasGcs) {
      status.textContent = 'Uploading to Google Cloud Storage…';
      const client = (rtData?.clients || []).find(c => c.id === agImageCtx.clientId);
      const folder = client?.name ? slugify(client.name) : 'service-images';
      const r = await fetch('/api/gcs/upload-image', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl: agImageResult.dataUrl, filename: agImageResult.filename, folder }),
      });
      const j = await r.json();
      if (!r.ok || !j.url) throw new Error(j.error?.message || 'Upload failed');
      url = j.url;
    }

    const marker = {
      url,                                   // null when GCS is off → indicator is non-clickable
      alt: agImageResult.alt,
      filename: agImageResult.filename,
      style: agImageResult.style,
      date: new Date().toISOString().slice(0, 10),
    };

    // Record on the keyword row (small — no base64 in rank data)
    const { kw } = agFindKwByKeyword(agImageCtx.keyword, agImageCtx.clientId);
    if (kw) { kw.image = marker; rtSave(); }

    // Mirror onto the saved report if one exists
    const rep = agImageCtx.clientId ? repGet(agImageCtx.clientId, agImageCtx.keyword) : null;
    if (rep) {
      rep.imageUrl = url; rep.imageAlt = marker.alt;
      rep.imageFilename = marker.filename; rep.imageStyle = marker.style;
      repSave(rep);
    }

    rtRender(); filesRender();
    status.textContent = url ? 'Saved and stored in GCS.' : 'Marked as generated on the page record.';
    agImageCtx.kwId = kw?.id || agImageCtx.kwId;
  } catch (e) {
    status.textContent = 'Save failed: ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Save to page record';
  }
}

/* One-off discovery helper: does POP expose an endpoint that scores raw content,
   so we could skip the preview-URL round trip entirely?

   Run `agProbePopContentScoring()` from the browser console after a generation.
   It POSTs a few plausible shapes and logs each response. If any returns a score
   instead of a 404/validation error, agRescoreWithPop can call that directly and
   the /api/preview route becomes unnecessary. Costs nothing if they all 404. */
async function agProbePopContentScoring() {
  if (!agLastRun) { console.warn('[probe] generate an article first'); return; }
  const { popKey, keyword, targetUrl } = agLastRun;
  const reportId = agSavedRun?.reportId;
  const sample = (agArticleText || '').slice(0, 4000);

  const attempts = [
    ['/expose/update-report/',     { apiKey: popKey, reportId, content: sample }],
    ['/expose/score-content/',     { apiKey: popKey, keyword, content: sample }],
    ['/expose/content-score/',     { apiKey: popKey, keyword, content: sample }],
    ['/expose/get-page-score/',    { apiKey: popKey, reportId, content: sample }],
    ['/expose/create-report/',     { apiKey: popKey, prepareId: agTermsData?.prepareId, content: sample, targetUrl }],
  ];

  const results = [];
  for (const [path, body] of attempts) {
    try {
      const j = await agPopPost(path, body);
      console.log(`[probe] ✔ ${path}`, j);
      results.push({ path, ok: true, response: j });
    } catch (e) {
      console.log(`[probe] ✘ ${path} — ${e.message}`);
      results.push({ path, ok: false, error: e.message });
    }
  }
  console.table(results.map(r => ({ path: r.path, ok: r.ok, detail: r.error || 'see log' })));
  return results;
}
window.agProbePopContentScoring = agProbePopContentScoring;

/* Get a REAL POP score for the generated article.

   POP scores a live URL, so the article is published to a temporary, unguessable
   preview URL and a fresh report is run against it — using the same keyword,
   location, language and term set as the baseline report, so "before" and
   "after" are the same exam. Costs one POP report, hence the explicit button. */
async function agRescoreWithPop() {
  if (!agLastRun || !agArticleText) return;
  const btn = document.getElementById('ag-verifyBtn');
  const setBtn = txt => { if (btn) { btn.disabled = true; btn.textContent = txt; } };

  const {
    popKey, keyword, locName, targLang, variations, lsaPhrases,
    overOpt, enableNlp, popBefore, covBefore, covAfter,
  } = agLastRun;

  try {
    setBtn('Publishing preview…');
    const pv = await fetch('/api/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: agArticleText, title: keyword }),
    });
    const pvJson = await pv.json();
    if (!pv.ok || !pvJson.url) throw new Error(pvJson.error?.message || 'Could not publish preview');
    agLog('Preview published → ' + pvJson.url);

    // POP crawls the URL from its own servers, so it has to be publicly routable
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)/i.test(pvJson.url)) {
      throw new Error(
        `The preview URL is ${pvJson.url}, which POP's crawler cannot reach.\n\n` +
        `Verifying against POP only works on the deployed app, not on localhost.`
      );
    }

    setBtn('POP: requesting terms…');
    const r1 = await agPopPost('/expose/get-terms/', {
      apiKey: popKey, keyword, locationName: locName,
      targetUrl: pvJson.url, targetLanguage: targLang,
    });
    const tid1 = r1.taskId || r1.task_id || r1.id;
    if (!tid1) throw new Error('No taskId from get-terms');
    const td = await agPollTerms(tid1);

    setBtn('POP: scoring article…');
    const r2 = await agPopPost('/expose/create-report/', {
      apiKey: popKey, prepareId: td.prepareId,
      variations, lsaPhrases,          // identical term set to the baseline
      considerOverOptimization: overOpt, specialLanguageSupport: 0,
      pageNotBuiltYet: 0, googleNlpCalculation: enableNlp,
    });
    const tid2 = r2.taskId || r2.task_id;
    if (!tid2) throw new Error('No taskId from create-report');
    const rd = await agPollReport(tid2);

    const popAfter = popPickScore(rd.report);
    if (popAfter == null) throw new Error('POP returned no page score for the preview');
    agLog(`POP re-score: ${popBefore} → ${popAfter}`);

    agLastRun.popAfter = popAfter;
    agRenderScore(popBefore, popAfter, { before: covBefore, after: covAfter });
    agRenderMetaCards({
      popBefore, popAfter, covBefore, covAfter,
      wordCount: agArticleText.split(/\s+/).length,
      wcTarget: agLastRun.wcTarget ?? '—',
      termCount: (variations || []).length + (lsaPhrases || []).length,
    });

    // Persist the verified score onto the saved report
    const cid = rtData?.activeClientId;
    const saved = cid ? repGet(cid, keyword) : null;
    if (saved) {
      saved.scoreAfter = popAfter;
      saved.scoreAfterSource = 'pop';
      repSave(saved);
      rtRender(); filesRender();
    }
  } catch (e) {
    agLog('Re-score failed: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Verify score in POP — retry'; }
    alert('POP re-score failed:\n\n' + e.message);
  }
}

/* Meta cards under the article. POP scores and the local coverage estimate are
   kept in separate cards so the two scales are never read as one number. */
function agRenderMetaCards({ popBefore, popAfter, covBefore, covAfter, wordCount, wcTarget, termCount }) {
  const el = document.getElementById('ag-metaCards');
  if (!el) return;
  const cls = s => s >= 80 ? 'var(--green)' : s >= 60 ? '#e8a838' : 'var(--red)';
  const muted = 'var(--text-muted)';
  const covDelta = (covBefore != null && covAfter != null) ? covAfter - covBefore : null;

  const cards = [
    { label: 'POP before', value: popBefore ?? '—', sub: 'original page',
      color: popBefore != null ? cls(parseFloat(popBefore) || 0) : muted },
    { label: 'POP after',
      value: popAfter ?? 'not verified',
      sub: popAfter != null ? 'this article' : 'click Verify score in POP',
      color: popAfter != null ? cls(parseFloat(popAfter) || 0) : muted },
    { label: 'Brief coverage',
      value: covAfter != null ? `${covAfter}%` : '—',
      sub: covDelta != null ? `${covDelta >= 0 ? '+' : ''}${covDelta} pts vs original` : 'local estimate',
      color: covAfter != null ? cls(covAfter) : muted },
    { label: 'Word count', value: wordCount, sub: `target ~${wcTarget}`, color: null },
    { label: 'Terms used', value: termCount, sub: 'POP-recommended', color: null },
  ];

  el.innerHTML = cards.map(c => `<div class="ag-meta-card">
    <div class="ag-meta-label">${c.label}</div>
    <div class="ag-meta-value"${c.color ? ` style="color:${c.color}"` : ''}>${escHtml(String(c.value))}</div>
    <div class="ag-meta-sub">${c.sub}</div>
  </div>`).join('');
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

  agSavedRun = null;   // a fresh run never reuses a stored Score report
  document.getElementById('ag-reusedNote')?.style.setProperty('display', 'none');

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

/* Start the generator from a report the Rank Tracker "Score" button already
   built. Steps 1-2 are already paid for, so we jump straight to the term picker
   with everything checked — leaving the selection alone reproduces the exact
   report behind the badge, so "POP before" matches what the Rank Tracker shows. */
async function agStartFromSavedRun(kw, competitors) {
  const run = kw.popRun;
  const popKey = hasPop ? '' : document.getElementById('ag-popKey').value.trim();

  if (!hasServerKey) {
    const k = apiKey || await Store.get('seomanager_api_key');
    if (!k) { alert('Enter your OpenAI API key in Settings first.'); return; }
  }

  agSavedRun = run;

  const btn = document.getElementById('ag-genBtn');
  btn.disabled = true;
  btn.textContent = 'Working…';

  document.getElementById('ag-outputSection').style.display = 'none';

  agInitSteps([
    'Step 1 — Request POP terms',
    'Step 2 — Poll: terms ready',
    'Step 3 — Review & edit terms ✎',
    'Step 4 — Create POP report',
    'Step 5 — Poll: report ready',
    'Step 6 — Fetch recommendations',
    'Step 7 — Generate article with OpenAI',
  ]);

  const ranAt = run.ranAt ? new Date(run.ranAt).toLocaleDateString() : '—';
  agSetStep(0, 'done', `reused from Score · ${ranAt}`);
  agSetStep(1, 'done', `${run.variations.length} vars · ${run.lsaPhrases.length} LSI · reused`);

  agTermsData = { prepareId: run.prepareId, variations: run.variations, lsaPhrases: run.lsaPhrases };

  // No brand filtering here — Score sent every term, and unchecking any of them
  // changes the denominator and therefore the score.
  agShowTermEditors(run.variations, run.lsaPhrases, new Set());

  const ageDays = run.ranAt ? Math.floor((Date.now() - new Date(run.ranAt)) / 86400000) : null;
  const stale = ageDays != null && ageDays > 14;
  agSetStep(2, 'active', 'all terms kept — leave them as-is to match the Rank Tracker score, or uncheck to rebuild');
  agLog(
    `Reusing the POP report from your Score run (${ranAt}, score ${run.score ?? '?'}). ` +
    `Leave the terms untouched and no new POP report is built. ` +
    (stale ? `⚠ That run is ${ageDays} days old — use "Re-run POP fresh" if the page has changed since.` : '')
  );

  document.getElementById('ag-reusedNote')?.style.setProperty('display', 'flex');
  const rn = document.getElementById('ag-reusedNoteText');
  if (rn) rn.textContent = `Reusing the POP report from ${ranAt} (score ${run.score ?? '?'})${stale ? ` — ${ageDays} days old` : ''}.`;

  window._agFlow = {
    popKey, keyword: run.keyword, targetUrl: run.targetUrl, pageNotBuilt: 0,
    locName: run.locName, targLang: run.targLang, competitors,
  };
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

  // The saved Score report is only valid for the exact term set it was built
  // from. Change the selection and the denominator changes, so a new report has
  // to be built — and its score will not match the Rank Tracker badge.
  const sameSet = (a, b) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;
  const reuseRun = agSavedRun
    && sameSet(selectedVars, agSavedRun.variations || [])
    && sameSet(selectedLsi, (agSavedRun.lsaPhrases || []).map(t => t.phrase || String(t)));

  if (agSavedRun && !reuseRun) {
    agLog('Term set changed — building a new POP report. Its score will not match the Rank Tracker badge.');
  }

  try {
    let reportId, wcTarget, h2Target, pageScore, cb, nlpEntities;

    if (reuseRun) {
      agSetStep(3, 'done', 'skipped — reusing the report from Score');
      agSetStep(4, 'done', `reportId:${agSavedRun.reportId} · score:${agSavedRun.score}`);
      reportId    = agSavedRun.reportId;
      wcTarget    = agSavedRun.wordCountTarget || 600;
      h2Target    = agSavedRun.subHeadingsCount || 3;
      pageScore   = agSavedRun.score ?? '?';
      cb          = agSavedRun.contentBrief || {};
      nlpEntities = [];
    } else {
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
      reportId  = rd.report.id;
      wcTarget  = (rd.report.wordCount && rd.report.wordCount.target) || 600;
      h2Target  = rd.report.subHeadingsCount || 3;
      // Same extractor the Rank Tracker "Score" button uses, so the two numbers
      // are on one scale (see popPickScore).
      pageScore = popPickScore(rd.report) ?? '?';
      console.log('[POP report] pageScore:', pageScore, '| pTotal:', rd.report.cleanedContentBrief?.pTotal);
      cb = rd.report.cleanedContentBrief || {};
      nlpEntities = enableNlp && rd.report.googleNlpSchemaData
        ? (rd.report.googleNlpSchemaData.entities || []).slice(0, 20) : [];
      agSetStep(4, 'done', `reportId:${reportId} · score:${pageScore} · wc:${wcTarget}`);
    }

    const cbTerms = cb.p || [];

    agSetStep(5, 'active');
    agLog('Fetching recommendations → reportId: ' + reportId);
    const recResp = await agPopPost('/expose/get-custom-recommendations/', { apiKey: popKey, reportId, strategy, approach });
    const recs = recResp.recommendations || {};
    agSetStep(5, 'done', `exact:${(recs.exactKeyword||[]).length} lsi:${(recs.lsi||[]).length} vars:${(recs.variations||[]).length}`);

    agSetStep(6, 'active');

    // Page title (H1) terms
    const titleTerms = (cb.pageTitle || [])
      .filter(t => agTermBand(t).max > 0).map(t => t.term.phrase);

    // Meta/SEO title terms
    const metaTitleTerms = (cb.metaTitle || cb.searchEngineTitle || [])
      .filter(t => agTermBand(t).max > 0).map(t => t.term.phrase);

    // H2 subheading terms with targets
    const h2Items = (cb.subHeadings || []).filter(t => t.contentBrief);
    const h2Lines = h2Items.length
      ? h2Items.map(t => {
          const { min, max } = agTermBand(t);
          return `  "${t.term.phrase}" → ${min}-${max} times in H2s`;
        }).join('\n')
      : '';

    // Body paragraph terms with targets
    const bodyTerms = (cb.p || cbTerms || []).filter(t => agTermBand(t).max > 0).slice(0, 30);
    const bodyLines = bodyTerms.length > 0
      ? bodyTerms.map(t => {
          const { min, max } = agTermBand(t);
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
${AG_TRUST_RULES}

── FORMAT ───────────────────────────────────────────────
- Output: one # H1 title, ${h2Target} ## H2 sections, one conclusion paragraph
- Prefer flowing paragraphs; use a markdown bullet list only where the content is a genuine enumeration
- Every term must read naturally — never forced or stuffed
- Do NOT include the meta title in the article body
- Do NOT mention SEO, word counts, or these instructions`;

    // Build term insertion list for the edit prompt
    const insertTermLines = [
      ...bodyTerms.map(t => {
        const { min, max } = agTermBand(t);
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
• While inserting terms, do not introduce new calls to action, superlatives ("the largest", "the first"), or credibility claims. Nothing you add may be an unverifiable claim.
  (Contradictions and repetition already in the original are left alone here — the "Trust & readability pass" button handles those.)

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

    // Local brief-coverage estimate for BOTH texts against the same brief, so the
    // pair is comparable. The real POP score for the new article comes from the
    // "Verify score in POP" button (agRescoreWithPop).
    const covAfter  = agComputeCoverage(articleText, bodyTerms, titleTerms, h2Items);
    const covBefore = agOriginalContent
      ? agComputeCoverage(agOriginalContent, bodyTerms, titleTerms, h2Items) : null;

    // Everything the re-score and the trust pass need to work on this article
    agLastRun = {
      popKey, keyword, targetUrl, locName, targLang,
      variations: selectedVars, lsaPhrases: fullLsa,
      overOpt, enableNlp, strategy, approach, model,
      popBefore: pageScore, bodyTerms, titleTerms, h2Items,
      covBefore, covAfter, wcTarget,
    };
    agPreTrustText = articleText;   // revert target for the trust pass
    agTrustNotes   = '';
    agRenderTrustNotes();

    document.getElementById('ag-outputTitle').textContent = keyword;
    agRenderScore(pageScore, null, { before: covBefore, after: covAfter });

    agRenderMetaCards({
      popBefore: pageScore, popAfter: null,
      covBefore, covAfter, wordCount, wcTarget, termCount: allTerms.length,
    });

    const termClassMap = buildTermClassMap(allTerms, coraReport?.lsi);
    agLastRun.termClassMap = termClassMap;
    agLastRun.allTerms = allTerms;
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
        score:          pageScore,     // POP score of the ORIGINAL page
        scoreAfter:     null,          // set only once verified against POP
        scoreAfterSource: null,
        covBefore,
        covAfter,
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

function populateGlobalClientSelect() {
  const sel = document.getElementById('global-client-select');
  if (!sel || !rtData) return;
  const active = rtData.activeClientId;
  sel.innerHTML = (rtData.clients || [])
    .map(c => `<option value="${escHtml(c.id)}"${c.id === active ? ' selected' : ''}>${escHtml(c.name)}</option>`)
    .join('') || '<option value="">No clients yet</option>';
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
  populateGlobalClientSelect();

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

  const mkKws     = keywords.filter(kw => kw.mainKeyword);
  const otherKws  = keywords.filter(kw => !kw.mainKeyword);
  const emptyRow  = msg => `<tr class="rt-group-empty-row"><td colspan="13" class="rt-group-empty">${escHtml(msg)}</td></tr>`;

  document.getElementById('rt-tbody-mk').innerHTML = mkKws.length
    ? mkKws.map(kw => rtRowHtml(kw, client)).join('')
    : emptyRow('No main keywords yet — click MK on a row below to add one');

  document.getElementById('rt-tbody-all').innerHTML = otherKws.length
    ? otherKws.map(kw => rtRowHtml(kw, client)).join('')
    : emptyRow('No other keywords');
}

const TASK_FIELDS = [
  { key: 'spc',     label: 'SPC',  title: 'Support Pages Creation' },
  { key: 'schema',  label: 'SCH',  title: 'Schema Optimization' },
  { key: 'co',      label: 'CO',   title: 'Content Optimization' },
  { key: 'offpage', label: 'OPG',  title: 'Off-Page Campaign' },
];
const TASK_STATES = [
  { val: 0, icon: '—',  cls: 'rt-task-none', tip: 'Not started' },
  { val: 1, icon: '~',  cls: 'rt-task-prog', tip: 'In progress' },
  { val: 2, icon: '✓',  cls: 'rt-task-done', tip: 'Done' },
];

function rtTaskCell(kw, taskKey, taskTitle) {
  const v   = kw[taskKey] ?? 0;
  const st  = TASK_STATES[v] || TASK_STATES[0];
  return `<td class="rt-td-task"><button class="rt-task-btn ${st.cls}"
    data-id="${escHtml(kw.id)}" data-task="${escHtml(taskKey)}"
    title="${escHtml(taskTitle + ': ' + st.tip)}">${st.icon}</button></td>`;
}

function rtRowHtml(kw, client) {
  const coraCell = kw.coraFileName
    ? `<td class="rt-td-cora"><button class="rt-cora-btn" data-id="${escHtml(kw.id)}" title="View Cora report: ${escHtml(kw.coraFileName)}">📊</button></td>`
    : `<td class="rt-td-cora"><button class="rt-run-cora-btn" data-id="${escHtml(kw.id)}" title="Run Cora analysis for this keyword">▶</button></td>`;
  const savedRep = repGet(client.id, kw.keyword);
  const repDate  = savedRep?.savedAt ? new Date(savedRep.savedAt).toLocaleDateString() : '';
  const repTip   = savedRep ? `SEO report — saved ${repDate}` : 'No report yet';
  const hasImg   = !!kw.image;
  const imgTip   = kw.image
    ? `Service image${kw.image.date ? ` — ${kw.image.date}` : ''}${kw.image.url ? ' (click to view / regenerate)' : ' (downloaded; click to regenerate)'}`
    : 'Generate a service-page image for this keyword';
  const repCell  = `<td class="rt-td-rep"><button class="rt-rep-btn${savedRep ? ' rt-rep-has' : ''}"
    data-client="${escHtml(client.id)}" data-kw="${escHtml(kw.keyword || '')}"
    title="${escHtml(repTip)}"${savedRep ? '' : ' disabled'}>📄</button><button class="rt-img-btn${hasImg ? ' rt-img-has' : ''}"
    data-kwid="${escHtml(kw.id)}" title="${escHtml(imgTip)}">🖼</button></td>`;
  const taskCells = TASK_FIELDS.map(t => rtTaskCell(kw, t.key, t.title)).join('');
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
      ${taskCells}
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
  const scoreCls = s => s >= 80 ? 'var(--green)' : s >= 60 ? '#e8a838' : 'var(--red)';
  const before = parseFloat(rep.score) || 0;
  // Only a POP-verified after-score earns a delta — a local coverage estimate is
  // a different scale and gets its own card.
  const after  = rep.scoreAfterSource === 'pop' && rep.scoreAfter != null ? parseFloat(rep.scoreAfter) : null;
  const delta  = after !== null ? Math.round((after - before) * 100) / 100 : null;
  const covDelta = (rep.covBefore != null && rep.covAfter != null) ? rep.covAfter - rep.covBefore : null;
  document.getElementById('rep-meta').innerHTML =
    `<span class="ag-meta-card" style="min-width:80px"><div class="ag-meta-label">POP before</div><div class="ag-meta-value" style="color:${scoreCls(before)}">${escHtml(String(rep.score ?? '—'))}</div></span>` +
    (after !== null
      ? `<span class="ag-meta-card" style="min-width:80px"><div class="ag-meta-label">POP after</div><div class="ag-meta-value" style="color:${scoreCls(after)}">${after}<span style="font-size:13px;color:${delta>=0?'var(--green)':'var(--red)'}"> (${delta>=0?'+':''}${delta})</span></div></span>`
      : `<span class="ag-meta-card" style="min-width:80px"><div class="ag-meta-label">POP after</div><div class="ag-meta-value" style="color:var(--text-muted);font-size:13px">not verified</div></span>`) +
    (rep.covAfter != null
      ? `<span class="ag-meta-card" style="min-width:80px"><div class="ag-meta-label">Brief coverage</div><div class="ag-meta-value" style="color:${scoreCls(rep.covAfter)}">${rep.covAfter}%${covDelta != null ? `<span style="font-size:13px;color:${covDelta>=0?'var(--green)':'var(--red)'}"> (${covDelta>=0?'+':''}${covDelta})</span>` : ''}</div></span>`
      : '') +
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
  const scoreBadge = kw.popScore != null
    ? `<span class="rt-pop-score-badge ${kw.popScore >= 80 ? 'pop-green' : kw.popScore >= 60 ? 'pop-yellow' : 'pop-red'}" title="POP page score: ${kw.popScore}">${Math.round(kw.popScore)}/100</span>`
    : '';
  const scoreDate = kw.popScoreDate ? `<span class="rt-pop-date"> ${escHtml(kw.popScoreDate)}</span>` : '';
  const detailBtn = kw.popReport
    ? ` <button class="rt-pop-detail-btn" data-kwid="${escHtml(kw.id)}" title="View content brief breakdown">Details</button>`
    : '';
  const wdBadge = kw.watchdog?.enabled
    ? ` <span class="rt-pop-wd-badge" title="POP watchdog on — auto re-score ${escHtml(kw.watchdog.repeat || 'weekly')}">⏱ ${escHtml(kw.watchdog.repeat || 'weekly')}</span>`
    : '';
  const scoreBtn = `<button class="rt-pop-score-btn" data-kwid="${escHtml(kw.id)}" title="Score existing page in POP">Score</button>`;
  const optimBtn = `<button class="rt-run-pop-btn" data-kwid="${escHtml(kw.id)}" data-kw="${escHtml(kw.keyword||'')}" data-url="${escHtml(kw.targetUrl||kw.url||'')}" title="Improve this page in the Article Generator using its POP score">Optimize</button>`;
  return `${scoreBadge}${scoreDate}${wdBadge}${detailBtn}${scoreBadge || scoreDate ? '<br>' : ''}${scoreBtn} ${optimBtn}`;
}

function rtPopShowDetails(kwId) {
  let kw;
  for (const c of rtData.clients || []) {
    const found = c.keywords?.find(k => k.id === kwId);
    if (found) { kw = found; break; }
  }
  if (!kw?.popReport) return;
  const pr = kw.popReport;
  const score = kw.popScore;
  const scoreColor = score >= 80 ? '#2d9e6b' : score >= 60 ? '#c48a00' : '#dc3c3c';

  function termRows(terms) {
    if (!terms?.length) return '<tr><td colspan="4" style="color:var(--text-secondary);font-size:11px;padding:4px 0">No data</td></tr>';
    return terms.map(t => {
      const inRange = t.current >= t.min && (t.max === 0 || t.current <= t.max);
      const over    = t.max > 0 && t.current > t.max;
      const icon = inRange ? '✓' : over ? '↑' : '✗';
      const col  = inRange ? '#2d9e6b' : over ? '#c48a00' : '#dc3c3c';
      return `<tr>
        <td style="width:14px;font-size:11px;color:${col};vertical-align:top">${icon}</td>
        <td style="font-size:11px;padding:2px 6px">${escHtml(t.phrase)}</td>
        <td style="font-size:11px;text-align:center;width:50px">${t.current}</td>
        <td style="font-size:11px;text-align:center;width:70px;color:var(--text-secondary)">${t.min}–${t.max}</td>
      </tr>`;
    }).join('');
  }

  function sectionBlock(title, terms) {
    if (!terms?.length) return '';
    const okCount = terms.filter(t => t.current >= t.min && (t.max === 0 || t.current <= t.max)).length;
    const badgeCol = okCount === terms.length ? '#2d9e6b' : okCount >= terms.length * 0.6 ? '#c48a00' : '#dc3c3c';
    return `<div style="margin-bottom:14px">
      <div style="font-size:12px;font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:6px">
        ${title}
        <span style="font-size:10px;font-weight:400;padding:1px 6px;border-radius:3px;background:rgba(0,0,0,.07);color:${badgeCol}">${okCount}/${terms.length} in range</span>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="font-size:10px;color:var(--text-secondary)">
          <th></th><th style="text-align:left;padding:2px 6px">Term</th>
          <th style="width:50px">Current</th><th style="width:70px">Target</th>
        </tr></thead>
        <tbody>${termRows(terms)}</tbody>
      </table>
    </div>`;
  }

  const wcHtml = pr.wordCountTarget != null
    ? `<div style="font-size:11px;margin-top:2px">Word count: <strong>${pr.wordCountCurrent != null ? Number(pr.wordCountCurrent).toLocaleString() : '?'}</strong> / target <strong>${Number(pr.wordCountTarget).toLocaleString()}</strong></div>`
    : '';

  const customComps = kw.customCompetitors || [];

  function competitorsBlock(all) {
    const popComps   = all || [];
    const focusUrls  = popComps.slice(0, 3);
    const otherUrls  = popComps.slice(3);
    const hasAny     = popComps.length || customComps.length;
    if (!hasAny) {
      return `<div style="margin-bottom:14px">
        <div style="font-size:12px;font-weight:600;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between">
          Competitors
          <button class="rt-pop-set-comp-btn" data-kwid="${escHtml(kwId)}" style="font-size:10px;padding:2px 8px;border-radius:12px;border:1px solid var(--border);background:transparent;cursor:pointer;color:var(--text-secondary)">+ Add your SERP picks</button>
        </div>
        <div style="font-size:11px;color:var(--text-muted);font-style:italic">No competitor data yet — run Score to detect POP's picks, or add yours manually.</div>
      </div>`;
    }
    const row = (url, badge, badgeStyle) => {
      const host = (() => { try { return new URL(url.startsWith('http') ? url : 'https://' + url).hostname; } catch { return url; } })();
      return `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:9px;padding:1px 5px;border-radius:3px;white-space:nowrap;${badgeStyle}">${badge}</span>
        <a href="${escHtml(url.startsWith('http') ? url : 'https://' + url)}" target="_blank" rel="noopener"
           style="font-size:11px;color:var(--accent);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1"
           title="${escHtml(url)}">${escHtml(host)}</a>
        <span style="font-size:10px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px">${escHtml(url.replace(/^https?:\/\/[^/]+/, '') || '/')}</span>
      </div>`;
    };
    return `<div style="margin-bottom:14px">
      <div style="font-size:12px;font-weight:600;margin-bottom:4px;display:flex;align-items:center;justify-content:space-between">
        <span>Competitors <span style="font-size:10px;font-weight:400;color:var(--text-secondary)">${focusUrls.length} focus · ${otherUrls.length} other · ${customComps.length} custom</span></span>
        <button class="rt-pop-set-comp-btn" data-kwid="${escHtml(kwId)}" style="font-size:10px;padding:2px 8px;border-radius:12px;border:1px solid var(--border);background:transparent;cursor:pointer;color:var(--text-secondary)">✏ My picks</button>
      </div>
      ${focusUrls.map(u  => row(u, 'Focus', 'background:rgba(67,97,238,.12);color:var(--accent);font-weight:600')).join('')}
      ${otherUrls.map(u  => row(u, 'POP',   'background:rgba(0,0,0,.06);color:var(--text-secondary)')).join('')}
      ${customComps.map(u => row(u, 'Mine',  'background:rgba(45,158,107,.12);color:#2d9e6b;font-weight:600')).join('')}
    </div>`;
  }

  const strategyPickerHtml = `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap">
    <span style="font-size:11px;color:var(--text-secondary)">Next run:</span>
    <select id="rt-pop-strategy-sel" style="font-size:11px;padding:2px 6px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text)">
      <option value="target">Target – all competitors</option>
      <option value="adjusted">Adjusted – by word count</option>
      <option value="focus">Focus – top 3 competitors</option>
      <option value="max">Max – highest signal</option>
    </select>
    <select id="rt-pop-approach-sel" style="font-size:11px;padding:2px 6px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text)">
      <option value="regular">Regular</option>
      <option value="conservative">Conservative</option>
      <option value="aggressive">Aggressive</option>
    </select>
  </div>`;

  // What POP's crawler read from the live target URL (server-side scrape).
  // The API returns no raw page text — these are the structural signals POP extracted.
  function scrapedBlock(s) {
    if (!s) return '';
    const wc = s.wordCurrent != null
      ? `<strong>${Number(s.wordCurrent).toLocaleString()}</strong> words${s.wordTarget != null ? ` <span style="color:var(--text-secondary)">/ target ${Number(s.wordTarget).toLocaleString()}</span>` : ''}`
      : '—';
    const tagRows = (s.tags || []).map(t => {
      const over  = t.max > 0 && t.current > t.max;
      const under = t.current < t.min;
      const col   = over ? '#c48a00' : under ? '#dc3c3c' : '#2d9e6b';
      const icon  = over ? '↑' : under ? '✗' : '✓';
      return `<tr>
        <td style="width:14px;font-size:11px;color:${col};vertical-align:top">${icon}</td>
        <td style="font-size:11px;padding:2px 6px">${escHtml(t.label)}</td>
        <td style="font-size:11px;text-align:center;width:56px;font-weight:600">${t.current}</td>
        <td style="font-size:11px;text-align:center;width:90px;color:var(--text-secondary)">${t.min}–${t.max} <span style="opacity:.6">(μ${t.mean})</span></td>
      </tr>`;
    }).join('');
    const tagTable = tagRows ? `
      <table style="width:100%;border-collapse:collapse;margin-top:6px">
        <thead><tr style="font-size:10px;color:var(--text-secondary)">
          <th></th><th style="text-align:left;padding:2px 6px">Element on your page</th>
          <th style="width:56px">Yours</th><th style="width:90px">Competitors</th>
        </tr></thead>
        <tbody>${tagRows}</tbody>
      </table>` : '';
    const entities = (s.entities || []).length
      ? `<div style="margin-top:8px">
          <div style="font-size:10px;font-weight:600;color:var(--text-secondary);margin-bottom:3px">Google NLP entities POP detected on your page</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px">
            ${s.entities.map(e => `<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:var(--bg);border:1px solid var(--border)">${escHtml(e)}</span>`).join('')}
          </div>
        </div>`
      : '';
    return `<details style="margin-bottom:14px" open>
      <summary style="font-size:12px;font-weight:600;cursor:pointer;padding:4px 0;user-select:none">
        What POP scraped from your page
      </summary>
      <div style="margin-top:6px;font-size:10px;color:var(--text-muted);line-height:1.4">
        POP fetched your live URL server-side. The API returns no raw HTML — these are the signals it extracted from your page and compared to the ${escHtml(s.location || '')} SERP.
      </div>
      <div style="font-size:11px;margin-top:6px;line-height:1.6">
        <div>URL: <a href="${escHtml(s.url)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">${escHtml(s.url)}</a></div>
        <div>Keyword: <strong>${escHtml(s.keyword || '')}</strong> · Location: <strong>${escHtml(s.location || '')}</strong> · Language: <strong>${escHtml((s.language || '').replace(/^./, c => c.toUpperCase()))}</strong></div>
        <div>Content read: ${wc}</div>
      </div>
      ${tagTable}
      ${entities}
    </details>`;
  }

  function recsBlock(recs) {
    if (!recs) return '';
    const groups = [
      { label: 'Exact keyword', key: 'exactKeyword', col: 'var(--accent)' },
      { label: 'LSI terms', key: 'lsi', col: '#2d9e6b' },
      { label: 'Variations', key: 'variations', col: '#c48a00' },
      { label: 'Page structure', key: 'pageStructure', col: '#8a63d2' },
    ].filter(g => (recs[g.key] || []).length > 0);
    if (!groups.length) return '';
    // POP items may be plain strings or rich objects ({signal, comment, target, …})
    const recLabel = t => typeof t === 'string'
      ? t
      : (t.phrase || t.term || t.keyword || t.signal || t.comment || '');
    return `<details style="margin-bottom:14px">
      <summary style="font-size:12px;font-weight:600;cursor:pointer;padding:4px 0;user-select:none">
        POP Recommendations <span style="font-size:10px;font-weight:400;color:var(--text-secondary)">(strategy: ${escHtml(pr.strategy||'focus')} · ${escHtml(pr.approach||'regular')})</span>
      </summary>
      <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px">
        ${groups.map(g => `<div>
          <div style="font-size:10px;font-weight:600;color:${g.col};margin-bottom:3px">${g.label}</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px">
            ${(recs[g.key]||[]).slice(0,30).map(recLabel).filter(Boolean).map(lbl => `<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:var(--bg);border:1px solid var(--border)">${escHtml(lbl)}</span>`).join('')}
          </div>
        </div>`).join('')}
      </div>
    </details>`;
  }

  const body = `
    <div style="display:flex;align-items:flex-start;gap:16px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--border)">
      <div style="font-size:44px;font-weight:800;color:${scoreColor};line-height:1;flex-shrink:0" title="${score ?? ''}">${score != null ? Math.round(score) : '?'}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600">${escHtml(kw.keyword || '')}</div>
        <div style="font-size:11px;color:var(--text-secondary)">${escHtml(kw.targetUrl || kw.url || '')} · ${kw.popScoreDate || ''}</div>
        ${wcHtml}
        ${strategyPickerHtml}
      </div>
    </div>
    ${competitorsBlock(pr.competitors)}
    ${rtWatchdogBlock(kw)}
    <details style="margin-bottom:14px">
      <summary style="font-size:12px;font-weight:600;cursor:pointer;padding:4px 0;user-select:none">
        SERP titles <span style="font-size:10px;font-weight:400;color:var(--text-secondary)">— real Google results via Ahrefs (1 API call)</span>
      </summary>
      <div style="margin-top:8px">
        <button id="rt-serp-load" style="font-size:11px;padding:3px 12px;border-radius:6px;border:1px solid var(--border);background:transparent;cursor:pointer;color:var(--text-secondary)">Load SERP titles</button>
        <div id="rt-serp-body" style="margin-top:8px"></div>
      </div>
    </details>
    <div style="font-size:10px;color:var(--text-secondary);margin-bottom:10px">
      Terms &amp; targets from Page Optimizer Pro · strategy: <strong>${escHtml(pr.strategy || 'focus')}</strong> · approach: <strong>${escHtml(pr.approach || 'regular')}</strong>
    </div>
    ${scrapedBlock(pr.scraped)}
    ${recsBlock(pr.recommendations)}
    ${sectionBlock('Search Engine Title', pr.sections?.searchEngineTitle)}
    ${sectionBlock('Page Title', pr.sections?.pageTitle)}
    ${sectionBlock('Sub-headings', pr.sections?.subHeadings)}
    ${sectionBlock('Main Content', pr.sections?.mainContent)}`;

  let modal = document.getElementById('rt-pop-detail-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'rt-pop-detail-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px';
    modal.innerHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;max-width:580px;width:100%;max-height:85vh;overflow-y:auto;position:relative">
      <button id="rt-pop-detail-close" style="position:absolute;top:10px;right:14px;background:none;border:none;font-size:22px;cursor:pointer;color:var(--text-secondary);line-height:1">×</button>
      <h3 style="margin:0 0 14px;font-size:14px">POP Content Brief</h3>
      <div id="rt-pop-detail-body"></div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
    document.getElementById('rt-pop-detail-close').addEventListener('click', () => { modal.style.display = 'none'; });
  }
  document.getElementById('rt-pop-detail-body').innerHTML = body;
  modal.style.display = 'flex';

  // Wire strategy + approach selects
  const strategySel = document.getElementById('rt-pop-strategy-sel');
  if (strategySel) {
    strategySel.value = kw.popStrategy || 'focus';
    strategySel.addEventListener('change', () => { kw.popStrategy = strategySel.value; rtSave(); });
  }
  const approachSel = document.getElementById('rt-pop-approach-sel');
  if (approachSel) {
    approachSel.value = kw.popApproach || 'regular';
    approachSel.addEventListener('change', () => { kw.popApproach = approachSel.value; rtSave(); });
  }

  // Wire the "Edit / Add SERP picks" button inside the freshly-rendered body
  document.getElementById('rt-pop-detail-body').querySelector('.rt-pop-set-comp-btn')
    ?.addEventListener('click', () => rtPopEditCompetitors(kwId));

  // Wire watchdog + SERP-titles controls
  rtWireWatchdogControls(kwId);
  document.getElementById('rt-serp-load')
    ?.addEventListener('click', () => rtLoadSerpTitles(kwId));
}

/* Generic POST to the POP API from the Rank Tracker context. Mirrors the inner
   popPost in rtPopScoreCheck: server key via the proxy, else the client key. */
async function rtPopApiPost(path, body) {
  const base = hasPop ? POP_API_PROXY : POP_API_DIRECT;
  const payload = { ...body };
  if (!hasPop) {
    const k = document.getElementById('ag-popKey')?.value || await Store.get('seomanager_pop_key');
    if (k) payload.apiKey = k;
  }
  const r = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error || j.detail) {
    const s = v => !v ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    throw new Error(s(j.error) || s(j.detail) || s(j.message) || `HTTP ${r.status}`);
  }
  return j;
}

/* POP Watchdog: ask POP to automatically re-score this page on a schedule.
   Attaches to the reportId saved during Score. Notifications are left off per
   the current UI (no emails). Each watchdog run costs 1 POP API call. */
async function rtSetWatchdog(kwId, enable, repeat) {
  let kw;
  for (const c of rtData.clients || []) {
    const found = c.keywords?.find(k => k.id === kwId);
    if (found) { kw = found; break; }
  }
  if (!kw) return;

  const reportId = kw.popRun?.reportId;
  if (!reportId) {
    alert('Score this page in POP first — the watchdog needs a POP report to attach to.');
    return;
  }

  const btn = document.getElementById('rt-wd-save');
  const status = document.getElementById('rt-wd-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }

  try {
    await rtPopApiPost('/expose/watchdog-setup/', {
      reportId,
      shouldWatchdogEnable: !!enable,
      repeat: repeat || 'weekly',
      isNotificationEnabled: false,
      notificationEmails: [],
    });
    kw.watchdog = { enabled: !!enable, repeat: repeat || 'weekly', updatedAt: new Date().toISOString() };
    rtSave();
    if (status) {
      status.textContent = enable ? `On · ${kw.watchdog.repeat}` : 'Off';
      status.style.color = enable ? 'var(--green)' : 'var(--text-secondary)';
    }
    // Refresh the row so the POP cell shows the watchdog badge
    const cell = document.querySelector(`tr[data-id="${CSS.escape(kwId)}"] .rt-td-pop`);
    if (cell) cell.outerHTML = `<td class="rt-td-pop">${rtPopCell(kw)}</td>`;
  } catch (e) {
    if (status) { status.textContent = 'Failed: ' + e.message; status.style.color = 'var(--red)'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Apply'; }
  }
}

/* Build the watchdog control block for the POP Details panel. */
function rtWatchdogBlock(kw) {
  if (!kw.popRun?.reportId) {
    return `<div style="margin-bottom:14px;padding:10px;border:1px dashed var(--border);border-radius:6px;font-size:11px;color:var(--text-secondary)">
      <strong>POP Watchdog</strong> — score this page first, then you can have POP auto-re-score it on a schedule.
    </div>`;
  }
  const wd = kw.watchdog || {};
  const opt = (v, l) => `<option value="${v}"${(wd.repeat || 'weekly') === v ? ' selected' : ''}>${l}</option>`;
  const setAt = wd.updatedAt ? new Date(wd.updatedAt).toLocaleDateString() : '';
  return `<div style="margin-bottom:14px;padding:10px;border:1px solid var(--border);border-radius:6px">
    <div style="font-size:12px;font-weight:600;margin-bottom:2px">POP Watchdog</div>
    <div style="font-size:10px;color:var(--text-muted);margin-bottom:8px;line-height:1.4">
      POP re-scores this page automatically on the chosen schedule. Each run costs 1 POP API call. No email notifications.
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <label style="display:flex;align-items:center;gap:5px;font-size:11px;cursor:pointer">
        <input type="checkbox" id="rt-wd-enable"${wd.enabled ? ' checked' : ''}> Enabled
      </label>
      <select id="rt-wd-repeat" style="font-size:11px;padding:2px 6px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text)">
        ${opt('weekly', 'Weekly')}${opt('monthly', 'Monthly')}${opt('quarterly', 'Quarterly')}
      </select>
      <button id="rt-wd-save" style="font-size:11px;padding:3px 12px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer">Apply</button>
      <span id="rt-wd-status" style="font-size:11px;color:${wd.enabled ? 'var(--green)' : 'var(--text-secondary)'}">${wd.enabled ? `On · ${wd.repeat}${setAt ? ` · ${setAt}` : ''}` : 'Off'}</span>
    </div>
  </div>`;
}

function rtWireWatchdogControls(kwId) {
  const btn = document.getElementById('rt-wd-save');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const enable = document.getElementById('rt-wd-enable')?.checked;
    const repeat = document.getElementById('rt-wd-repeat')?.value || 'weekly';
    rtSetWatchdog(kwId, enable, repeat);
  });
}

/* Common country names → Ahrefs ISO-2 codes, derived from a POP location string
   like "Winnipeg, Manitoba, Canada". Falls back to US. */
const AHREFS_COUNTRY_MAP = {
  'canada': 'ca', 'united states': 'us', 'usa': 'us', 'us': 'us',
  'united kingdom': 'gb', 'uk': 'gb', 'england': 'gb', 'scotland': 'gb', 'wales': 'gb',
  'australia': 'au', 'new zealand': 'nz', 'ireland': 'ie', 'india': 'in',
  'germany': 'de', 'france': 'fr', 'spain': 'es', 'italy': 'it', 'netherlands': 'nl',
  'mexico': 'mx', 'brazil': 'br', 'south africa': 'za', 'singapore': 'sg', 'uae': 'ae',
  'united arab emirates': 'ae',
};
function ahrefsCountryFromLocation(loc) {
  const last = String(loc || '').split(',').pop().trim().toLowerCase();
  return AHREFS_COUNTRY_MAP[last] || 'us';
}

/* Load the real Google SERP titles for this keyword via the existing Ahrefs key
   (serp-overview). Costs one Ahrefs API call, so it is triggered on demand. */
async function rtLoadSerpTitles(kwId) {
  let kw, client;
  for (const c of rtData.clients || []) {
    const found = c.keywords?.find(k => k.id === kwId);
    if (found) { kw = found; client = c; break; }
  }
  if (!kw) return;

  const box = document.getElementById('rt-serp-body');
  const btn = document.getElementById('rt-serp-load');
  const keyword = kw.keyword || '';
  const country = ahrefsCountryFromLocation(client?.popLocation);
  if (box) box.innerHTML = `<div style="font-size:11px;color:var(--text-secondary)">Loading SERP for “${escHtml(keyword)}” (${country.toUpperCase()})…</div>`;
  if (btn) btn.disabled = true;

  try {
    const res = await ahrefsQuery('serp-overview/serp-overview', {
      country, keyword,
      select: 'position,url,title,domain_rating',
      top_positions: 10,
    });
    // Ahrefs v3 responses wrap rows under a data-ish key; find the first array
    const rows = Array.isArray(res) ? res
      : (res.positions || res.pages || res.serp || res.data
         || Object.values(res).find(v => Array.isArray(v)) || []);
    if (!rows.length) {
      if (box) box.innerHTML = `<div style="font-size:11px;color:var(--text-secondary)">No SERP rows returned for this keyword/country.</div>`;
      return;
    }
    const yourHost = (() => { try { return new URL(kw.targetUrl || kw.url || '').hostname.replace(/^www\./, ''); } catch { return ''; } })();
    const rowsHtml = rows.slice(0, 10).map(r => {
      const pos = r.position ?? r.pos ?? '';
      const url = r.url || r.page || '';
      const title = r.title || '(no title)';
      const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } })();
      const mine = yourHost && host === yourHost;
      return `<div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)${mine ? ';background:rgba(45,158,107,.08)' : ''}">
        <span style="font-size:11px;font-weight:700;color:var(--text-secondary);width:20px;text-align:right">${escHtml(String(pos))}</span>
        <div style="min-width:0;flex:1">
          <div style="font-size:11px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escHtml(title)}">${escHtml(title)}${mine ? ' <span style="color:#2d9e6b;font-weight:600">· you</span>' : ''}</div>
          <a href="${escHtml(url)}" target="_blank" rel="noopener" style="font-size:10px;color:var(--accent);text-decoration:none">${escHtml(host)}</a>
        </div>
      </div>`;
    }).join('');
    if (box) box.innerHTML = rowsHtml;
  } catch (e) {
    const msg = e.message || 'request failed';
    const hint = /not configured|AHREFS_API_KEY/.test(msg)
      ? 'Ahrefs API key not set on the server (Railway → Variables → AHREFS_API_KEY).'
      : /subscription|plan|not allowed|forbidden|403/i.test(msg)
        ? 'Your Ahrefs plan may not include SERP overview.'
        : msg;
    if (box) box.innerHTML = `<div style="font-size:11px;color:var(--red)">SERP titles unavailable: ${escHtml(hint)}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* Open the Article Generator pre-loaded with everything from this keyword's POP
   score (keyword, URL, location, language, strategy, approach, competitors),
   auto-fetch the current page, and kick off the improve flow so the article is
   rewritten against POP's recommendations. */
async function rtOptimizeInAG(kwId) {
  let kw, client;
  for (const c of rtData.clients || []) {
    const found = c.keywords?.find(k => k.id === kwId);
    if (found) { kw = found; client = c; break; }
  }
  if (!kw) return;

  const setSelect = (id, val) => {
    const sel = document.getElementById(id);
    if (!sel || !val) return;
    if (![...sel.options].some(o => o.value === val)) {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = val;
      sel.appendChild(opt);
    }
    sel.value = val;
  };

  switchTab('article');

  // Core identity
  document.getElementById('ag-keyword').value   = kw.keyword || '';
  document.getElementById('ag-targetUrl').value = kw.targetUrl || kw.url || '';

  // Location + language come from the client's POP settings (same source as Score)
  setSelect('ag-locationName',   client?.popLocation);
  setSelect('ag-targetLanguage', String(client?.popLanguage || 'english').toLowerCase());

  // Strategy + approach carry over from the score's chosen settings
  setSelect('ag-strategy', kw.popStrategy || 'focus');
  setSelect('ag-approach', kw.popApproach || 'regular');

  // Competitors: POP's picks from the score + the user's own SERP picks (deduped)
  const comps = [...new Set([...(kw.popReport?.competitors || []), ...(kw.customCompetitors || [])])];
  document.getElementById('ag-competitors').value = comps.join('\n');

  // We're improving an existing page → ensure "page not built" is off and the
  // existing-content box is shown, then auto-fetch the live copy.
  const pnb = document.getElementById('ag-pageNotBuilt');
  if (pnb) { pnb.checked = false; pnb.dispatchEvent(new Event('change')); }

  // Flash the pre-filled fields so it's clear what was carried over
  ['ag-keyword','ag-targetUrl','ag-locationName','ag-targetLanguage','ag-strategy','ag-approach','ag-competitors'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('ag-prefill-flash');
    setTimeout(() => el.classList.remove('ag-prefill-flash'), 1200);
  });

  // Auto-fetch the current page content, then start the POP improve flow
  const url = (kw.targetUrl || kw.url || '').trim();
  if (url && /^https?:\/\//i.test(url)) {
    try { await agFetchPageContent(); } catch { /* non-fatal — user can paste/fetch manually */ }
  }

  // Reuse the report the Score button already built rather than paying for a
  // second one — that second report was the reason "before" never matched the
  // Rank Tracker badge. "Re-run POP fresh" falls back to the full flow.
  if (kw.popRun?.prepareId && kw.popRun?.reportId) {
    agStartFromSavedRun(kw, comps);
  } else {
    agStartFlow();
  }
}

/* Force a full get-terms → create-report run, discarding the saved Score report. */
function agRerunFresh() {
  agSavedRun = null;
  document.getElementById('ag-reusedNote')?.style.setProperty('display', 'none');
  agStartFlow();
}

function rtPopEditCompetitors(kwId) {
  let kw;
  for (const c of rtData.clients || []) {
    const found = c.keywords?.find(k => k.id === kwId);
    if (found) { kw = found; break; }
  }
  if (!kw) return;

  let modal = document.getElementById('rt-pop-comp-edit-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'rt-pop-comp-edit-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1100;display:flex;align-items:center;justify-content:center;padding:16px';
    modal.innerHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;max-width:500px;width:100%;position:relative">
      <button id="rt-pop-comp-edit-close" style="position:absolute;top:10px;right:14px;background:none;border:none;font-size:22px;cursor:pointer;color:var(--text-secondary);line-height:1">×</button>
      <h3 style="margin:0 0 6px;font-size:14px">Your SERP Competitor Picks</h3>
      <p style="margin:0 0 10px;font-size:11px;color:var(--text-secondary)">Search Google for your keyword in your target city, then paste the top competitor URLs below — one per line. These are shown in your Details report alongside POP's auto-detected picks.</p>
      <textarea id="rt-pop-comp-edit-ta" rows="10" style="width:100%;box-sizing:border-box;font-size:11px;font-family:monospace;padding:8px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);resize:vertical" placeholder="https://competitor1.com/commercial-renovations&#10;https://competitor2.com/page&#10;https://competitor3.com"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
        <button id="rt-pop-comp-edit-clear" style="padding:6px 14px;border-radius:6px;border:1px solid var(--border);background:transparent;cursor:pointer;font-size:12px;color:var(--text-secondary)">Clear</button>
        <button id="rt-pop-comp-edit-save" style="padding:6px 16px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:12px;font-weight:600">Save</button>
      </div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
    document.getElementById('rt-pop-comp-edit-close').addEventListener('click', () => modal.style.display = 'none');
    document.getElementById('rt-pop-comp-edit-clear').addEventListener('click', () => {
      document.getElementById('rt-pop-comp-edit-ta').value = '';
    });
    document.getElementById('rt-pop-comp-edit-save').addEventListener('click', () => {
      const lines = document.getElementById('rt-pop-comp-edit-ta').value
        .split('\n').map(l => l.trim()).filter(l => l.length > 0);
      kw.customCompetitors = lines;
      rtSave();
      modal.style.display = 'none';
      // Refresh Details modal if open
      if (document.getElementById('rt-pop-detail-modal')?.style.display !== 'none') {
        rtPopShowDetails(kwId);
      }
    });
  }
  document.getElementById('rt-pop-comp-edit-ta').value = (kw.customCompetitors || []).join('\n');
  modal.style.display = 'flex';
}

async function rtPopScoreCheck(kwId) {
  let kw, client;
  for (const c of rtData.clients || []) {
    const found = c.keywords?.find(k => k.id === kwId);
    if (found) { kw = found; client = c; break; }
  }
  if (!kw) return;

  const targetUrl  = kw.targetUrl || kw.url || '';
  const keyword    = kw.keyword || '';
  let   locName    = client?.popLocation || '';
  // POP languages are all lowercase (english, spanish, …) — normalise to the accepted case
  let   targLang   = String(client?.popLanguage || 'english').toLowerCase();
  const gnl        = !!client?.popGnl;

  if (!targetUrl) { alert('Add a Target URL for this keyword first (click the Target URL cell to edit).'); return; }
  if (!locName) { alert('Add a Target Location for this client first.\n\nEdit Client → POP Settings → Target Location\nExample: "Winnipeg, Manitoba" or "Dallas, TX"'); return; }

  // Location/language must be the exact case-sensitive values POP validates against.
  // Normalise both against POP's own lists so everything sent comes straight from POP.
  try {
    if (!_popLocations) { const r = await fetch('/api/pop-locations'); _popLocations = await r.json(); }
    if (Array.isArray(_popLocations) && locName) {
      const hit = _popLocations.find(l => l.toLowerCase() === locName.toLowerCase());
      if (hit) locName = hit;
      else { alert(`"${locName}" is not a valid POP location.\n\nEdit Client → POP Settings → Target Location and pick one from the list (values come from Page Optimizer Pro, e.g. "Winnipeg, Manitoba, Canada").`); return; }
    }
  } catch { /* offline — fall through and let POP validate server-side */ }
  try {
    if (!_popLanguages) { const r = await fetch('/api/pop-languages'); _popLanguages = await r.json(); }
    if (Array.isArray(_popLanguages) && _popLanguages.length && !_popLanguages.includes(targLang)) {
      const hit = _popLanguages.find(l => l.toLowerCase() === targLang.toLowerCase());
      targLang = hit || 'english';
    }
  } catch { /* offline — fall through */ }
  if (!hasPop && !document.getElementById('ag-popKey')?.value) {
    alert('No POP API key configured. Add it in Settings or ask your admin to set POP_API_KEY on the server.');
    return;
  }

  const cell = document.querySelector(`tr[data-id="${CSS.escape(kwId)}"] .rt-td-pop`);
  const kwLabel = keyword ? `"${keyword}"` : 'keyword';
  const setStatus = msg => { if (cell) cell.innerHTML = `<span class="rt-pop-checking">${msg}</span>`; };
  setStatus(`Requesting terms for ${kwLabel} [${locName}]…`);

  const base   = hasPop ? POP_API_PROXY : POP_API_DIRECT;
  const apiKey = hasPop ? '' : (document.getElementById('ag-popKey')?.value || '');

  async function popPost(path, body) {
    if (!hasPop && apiKey) body.apiKey = apiKey;
    const r = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok || j.error || j.detail) {
      const toStr = v => !v ? '' : typeof v === 'string' ? v : JSON.stringify(v);
      throw new Error(toStr(j.error) || toStr(j.detail) || toStr(j.message) || JSON.stringify(j).slice(0, 300));
    }
    return j;
  }

  // get-terms poll: done when d.prepareId is set
  async function pollTerms(taskId) {
    for (let i = 1; i <= 40; i++) {
      await new Promise(r => setTimeout(r, 4000));
      setStatus(`Generating terms for ${kwLabel}… (${i}/40)`);
      const d = await fetch(`${base}/task/${taskId}/results/`).then(r => r.json());
      console.log(`[POP terms poll ${i}]`, JSON.stringify(d).slice(0, 300));
      if (d.status === 'FAILURE') throw new Error('get-terms task failed: ' + JSON.stringify(d).slice(0, 200));
      if (d.prepareId) return d;
    }
    throw new Error('get-terms timed out');
  }

  // create-report poll: done when d.report.id is set (top-level, not nested under result)
  async function pollReport(taskId) {
    for (let i = 1; i <= 40; i++) {
      await new Promise(r => setTimeout(r, 4000));
      setStatus(`Analysing ${kwLabel}… (${i}/40)`);
      const d = await fetch(`${base}/task/${taskId}/results/`).then(r => r.json());
      console.log(`[POP report poll ${i}]`, JSON.stringify(d).slice(0, 300));
      if (d.status === 'FAILURE') throw new Error('create-report task failed: ' + JSON.stringify(d).slice(0, 200));
      if (d.report && d.report.id) return d;
    }
    throw new Error('create-report timed out');
  }

  try {
    const r1 = await popPost('/expose/get-terms/', { keyword, targetUrl, locationName: locName, targetLanguage: targLang });
    const tid1 = r1.taskId || r1.task_id || r1.id;
    if (!tid1) throw new Error('No taskId from get-terms — ' + JSON.stringify(r1).slice(0, 200));
    const terms = await pollTerms(tid1);

    // Log all top-level keys so we can find the competitor field name
    console.log('[POP terms keys]', Object.keys(terms).join(', '));
    const termsCompUrls = terms?.urls || terms?.competitors || terms?.competitorUrls
      || terms?.competitorPages || terms?.topCompetitorUrls || terms?.competitorList || [];
    const termsFocusUrls = terms?.focusCompetitors || terms?.focusUrls
      || terms?.topCompetitors || terms?.focusCompetitorUrls || [];
    console.log('[POP terms competitors]', JSON.stringify(termsCompUrls).slice(0, 600));
    console.log('[POP terms focus]', JSON.stringify(termsFocusUrls).slice(0, 300));

    // variations = strings; lsaPhrases = full objects (POP requires objects, not strings)
    // Pass ALL terms — same as POP's "Pro run" which includes everything
    const prepareId  = terms.prepareId;
    const variations = (terms.variations || []).map(v => typeof v === 'string' ? v : (v.phrase || v.variation || String(v)));
    const lsaPhrases = (terms.lsaPhrases || []);

    const strategy = kw.popStrategy || 'focus';
    const approach = kw.popApproach || 'regular';
    setStatus(`Creating report for ${kwLabel}…`);
    const r2 = await popPost('/expose/create-report/', {
      prepareId, variations, lsaPhrases,
      pageNotBuiltYet: 0, considerOverOptimization: 1,
      googleNlpCalculation: gnl ? 1 : 0, specialLanguageSupport: 0,
    });
    const tid2 = r2.taskId || r2.task_id || r2.id;
    if (!tid2) throw new Error('No taskId from create-report — ' + JSON.stringify(r2).slice(0, 200));
    const report = await pollReport(tid2);

    const rep = report.report;

    // Fetch recommendations (non-fatal — strategy + approach apply here, not create-report)
    let recommendations = null;
    const reportId = r2.reportId || rep?.id;
    if (reportId) {
      try {
        setStatus(`Getting recommendations for ${kwLabel}…`);
        const recResp = await popPost('/expose/get-custom-recommendations/', { reportId, strategy });
        recommendations = recResp.recommendations || null;
      } catch { /* non-fatal */ }
    }

    // Scan all numeric leaves in the report to find where ~74 lives
    (function scanScore(obj, path) {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        const p = `${path}.${k}`;
        if (typeof v === 'number') {
          console.log(`[POP field] ${p} = ${v}`);
        } else if (v && typeof v === 'object' && !Array.isArray(v)) {
          scanScore(v, p);
        }
      }
    })(rep, 'report');

    console.log('[POP score] keys at report.report:', Object.keys(rep || {}).join(', '));
    console.log('[POP score] cleanedContentBrief keys:', Object.keys(rep?.cleanedContentBrief || {}).join(', '));
    console.log('[POP score] cb.pageScore raw:', JSON.stringify(rep?.cleanedContentBrief?.pageScore));

    const cb = rep?.cleanedContentBrief;

    const score = popPickScore(rep);
    console.log('[POP score] final:', score);

    // Extract section-level term data for the Details panel
    function extractTerms(arr) {
      return (arr || []).map(t => ({
        phrase: t.term?.phrase || '',
        current: t.contentBrief?.current ?? 0,
        min: t.contentBrief?.targetMin ?? t.contentBrief?.min ?? 0,
        max: t.contentBrief?.targetMax ?? t.contentBrief?.max ?? t.contentBrief?.target ?? 0,
      }));
    }

    // Competitors — try all known field names POP uses
    const allComps = rep?.competitorUrls || rep?.competitors || rep?.competitorPages
      || rep?.topCompetitors || rep?.urls || [];
    const focusComps = rep?.focusCompetitors || rep?.focusCompetitorUrls
      || rep?.topFocusCompetitors || [];
    console.log('[POP competitors] all:', JSON.stringify(allComps).slice(0, 500));
    console.log('[POP competitors] focus:', JSON.stringify(focusComps).slice(0, 300));

    // Normalise: each entry may be a string URL or an object with a url field
    function normUrls(arr) {
      return (arr || []).map(c => (typeof c === 'string' ? c : (c?.url || c?.competitorUrl || c?.domain || JSON.stringify(c)))).filter(Boolean);
    }

    // First 3 competitors are always POP's focus competitors
    const allCompsList = normUrls(termsCompUrls).length ? normUrls(termsCompUrls) : normUrls(allComps);

    // What POP's crawler actually read from the live target URL. The API returns no
    // raw HTML/text — these are the structural signals POP extracted server-side:
    // total words, per-tag counts (H1/H2/paragraphs/images…) and Google NLP entities.
    function extractEntities(nlp) {
      if (!nlp) return [];
      let ents = Array.isArray(nlp) ? nlp
        : (nlp.entities || nlp.googleNlpEntities || nlp.nlpEntities || []);
      if (!Array.isArray(ents)) return [];
      return ents.map(e => typeof e === 'string' ? e : (e.name || e.entity || e.text || e.phrase || ''))
        .filter(Boolean).slice(0, 40);
    }
    const scraped = {
      url:         rep?.url || targetUrl,
      keyword:     rep?.keyword || keyword,
      location:    rep?.googleLocation || locName,
      language:    rep?.language || targLang,
      wordCurrent: rep?.wordCount?.current ?? rep?.wordCount?.total ?? null,
      wordTarget:  rep?.wordCount?.target ?? null,
      tags: (rep?.tagCounts || []).map(t => ({
        label:   t.tagLabel || '',
        current: t.signalCnt ?? 0,
        min:     t.min ?? 0,
        mean:    t.mean ?? 0,
        max:     t.max ?? 0,
        comment: t.comment || '',
      })).filter(t => t.label),
      entities: extractEntities(rep?.googleNlpSchemaData),
    };

    kw.popReport = {
      wordCountCurrent: rep?.wordCount?.current ?? rep?.wordCount?.total ?? null,
      wordCountTarget:  rep?.wordCount?.target ?? null,
      competitors:      allCompsList,
      scraped,
      strategy,
      approach,
      recommendations,
      sections: {
        searchEngineTitle: extractTerms(cb?.metaTitle || cb?.searchEngineTitle),
        pageTitle:         extractTerms(cb?.pageTitle),
        subHeadings:       extractTerms(cb?.subHeadings),
        mainContent:       extractTerms(cb?.p).slice(0, 50),
      },
    };

    // Everything the Article Generator would otherwise have to re-fetch. Saving it
    // lets "Optimize" reuse THIS report instead of building a second one, so the
    // generator's "before" is the exact number on this badge.
    kw.popRun = {
      prepareId, reportId,
      variations,
      lsaPhrases,
      contentBrief:     popTrimBrief(cb),
      wordCountTarget:  rep?.wordCount?.target ?? null,
      subHeadingsCount: rep?.subHeadingsCount ?? null,
      keyword, targetUrl, locName, targLang,
      overOpt: 1, pageNotBuiltYet: 0, gnl: gnl ? 1 : 0,
      strategy, approach,
      score,
      ranAt: new Date().toISOString(),
    };

    kw.popScore     = score;
    kw.popScoreDate = new Date().toISOString().slice(0, 10);
    rtSave();

    if (cell) cell.outerHTML = `<td class="rt-td-pop">${rtPopCell(kw)}</td>`;
  } catch (e) {
    if (cell) cell.innerHTML =
      `<span class="rt-pop-err" title="${escHtml(e.message)}">⚠ ${escHtml(e.message.slice(0, 60))}</span><br>` +
      `<button class="rt-pop-score-btn" data-kwid="${escHtml(kwId)}">Retry</button>`;
  }
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

    // SEO task completion %  per TASK_FIELDS across all MK keywords
    const taskPct = {};
    for (const tf of TASK_FIELDS) {
      const done = mkKws.filter(k => (k[tf.key] ?? 0) === 2).length;
      taskPct[tf.key] = mkKws.length ? Math.round((done / mkKws.length) * 100) : null;
    }

    return { c, mkKws, ranked, avgRank, avgDelta, top3, top10, topKws, avgLocalRank, avgTotal, taskPct };
  });

  scored.sort((a, b) => {
    if (a.avgTotal === null && b.avgTotal === null) return 0;
    if (a.avgTotal === null) return 1;
    if (b.avgTotal === null) return -1;
    return a.avgTotal - b.avgTotal;
  });

  grid.innerHTML = scored.map(({ c, mkKws, ranked, avgRank, avgDelta, top3, top10, topKws, avgLocalRank, avgTotal, taskPct }, i) => {
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
      ${dbTaskChipsHtml(c)}
      ${mkKws.length ? `<div class="db-seo-tasks">${TASK_FIELDS.map(tf => {
        const pct = taskPct[tf.key];
        const cls = pct === null ? '' : pct === 100 ? 'db-st-done' : pct > 0 ? 'db-st-prog' : 'db-st-none';
        const label = pct === null ? '—' : pct + '%';
        return `<div class="db-st-item ${cls}" title="${escHtml(tf.title + ': ' + label)}">
          <div class="db-st-label">${escHtml(tf.label)}</div>
          <div class="db-st-val">${label}</div>
          <div class="db-st-bar"><div class="db-st-fill" style="width:${pct ?? 0}%"></div></div>
        </div>`;
      }).join('')}${(() => {
        const aud = auditData[c.id];
        if (!aud?.todoText) return '';
        const total   = (aud.todoText.match(/^- \[/gm) || []).length;
        const checked = (aud.checkedItems || []).length;
        const pct     = total ? Math.round(checked / total * 100) : 0;
        const cls     = pct === 100 ? 'db-st-done' : pct > 0 ? 'db-st-prog' : 'db-st-none';
        return `<div class="db-st-item ${cls}" title="SEO Audit: ${checked}/${total} tasks done">
          <div class="db-st-label">Audit</div>
          <div class="db-st-val">${pct}%</div>
          <div class="db-st-bar"><div class="db-st-fill" style="width:${pct}%"></div></div>
        </div>`;
      })()}</div>` : ''}
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
      switchTab('ranks');
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

/* ═══════════════════════════════════════════════
   WEEKLY CLIENT TASKS
════════════════════════════════════════════════ */

const WEEKLY_DAYS = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
];
const WEEKLY_CATEGORIES = [
  { key: 'supportPages', label: 'Support Pages Creation', short: 'Pages',    scope: 'mk' },
  { key: 'schemaOpt',    label: 'Schema Optimization',    short: 'Schema',   scope: 'page' },
  { key: 'contentOpt',   label: 'Content Optimization',   short: 'Content', scope: 'page' },
  { key: 'offPage',      label: 'Off-Page Campaign',      short: 'Off-Page', scope: 'mk' },
];
const WEEKLY_STATUSES = [
  { key: 'not_started', label: 'Not Started', cls: 'wk-status-not' },
  { key: 'in_progress', label: 'In Progress', cls: 'wk-status-progress' },
  { key: 'done',        label: 'Done',        cls: 'wk-status-done' },
  { key: 'blocked',     label: 'Blocked',      cls: 'wk-status-blocked' },
];

const SEONEO_STRATEGIES = [
  { id: 'das-v2',      name: 'DAS v2',                   type: 'organic', desc: 'First campaign for any site — plain URLs only, 4–5 runs in month 1. Passes link juice and creates content depth.' },
  { id: 'elias-cloud', name: 'Elias Cloud',              type: 'organic', desc: 'Most powerful Cloud Stacking strategy, used by top SEO experts. Great for established sites.' },
  { id: 'rd100',       name: 'RD100',                    type: 'organic', desc: 'Builds 100 Referring Domains to each T1 link. Ideal for boosting existing T1 links.' },
  { id: 'hydra',       name: 'Neo - Hydra',              type: 'organic', desc: 'Most powerful diagram. Use for Moneysite, PBNs or Social links.' },
  { id: 'hercules',    name: 'Neo - Hercules',           type: 'organic', desc: "One of the favourites. For established websites — use with Omega Indexer for faster rankings." },
  { id: 'cl2',         name: 'Neo - Cloud Level 2',      type: 'organic', desc: 'Advanced Cloud Level 1 — a Ranking Machine. Use with Omega Indexer.' },
  { id: 'cl1',         name: 'Neo - Cloud Level 1',      type: 'organic', desc: 'Basic Cloud for new or middle-aged websites. Creates Cloud Blogs.' },
  { id: 'ctx-adv',     name: 'Neo - Contextual (Adv)',   type: 'organic', desc: 'VERY Powerful for High Competition Keywords. One of the favourite diagrams.' },
  { id: 'ctx',         name: 'Neo - Contextual to Text', type: 'organic', desc: 'Use for Branded URLs: Homepage, About Us, Contact Us, Social Media.' },
  { id: 'daredevil',   name: 'Neo - Daredevil',          type: 'organic', desc: 'For established websites with max 40% Primary Keywords.' },
  { id: 'gnosis',      name: 'Neo - Gnosis',             type: 'organic', desc: 'PDF Groups as T1. Diversifies Link Profile and passes authority.' },
  { id: 'rma',         name: 'Neo - Respect my Auth',    type: 'organic', desc: 'Super High-Quality backlinks fast from Authority websites. Boosts DA/PA/DR/UR.' },
  { id: 't1-booster',  name: 'Neo - T1 Booster',        type: 'organic', desc: 'Ideal for boosting T1 links. Part of the RD100 strategy.' },
  { id: 'zero-hero',   name: 'Zero To Hero',             type: 'organic', desc: 'Starting strategy for brand-new websites. Run 4–5 campaigns in month 1.' },
  { id: 'gbp-blast',   name: 'GBP Blast',                type: 'gbp',     desc: 'Google Business Profile — broad blast campaign to boost GBP rankings.' },
  { id: 'gbp-sniper',  name: 'GBP Sniper',               type: 'gbp',     desc: 'Google Business Profile — precision targeting for competitive GBP keywords.' },
  { id: 'citation',    name: 'Citation',                  type: 'citation', desc: 'Build consistent NAP citations across directories to strengthen local authority and trust signals.' },
  { id: 'net-agg',     name: 'Network Aggregator',        type: 'citation', desc: 'Submit to data aggregators (Foursquare, Localeze, etc.) to distribute business info across the citation network.' },
  { id: 'cit-net-agg', name: 'Citation + Network Aggregator', type: 'citation', desc: 'Combined approach — manual citations plus aggregator submission for maximum local citation coverage.' },
];

function opgSuggestStrategies(kw) {
  const rank    = parseInt(kw.rank ?? 0) || 0;
  const keyword = (kw.keyword || '').toLowerCase();
  const isGBP   = /\bgbp\b|\bgoogle business\b|\bgmb\b/i.test(keyword);
  if (isGBP)      return ['gbp-blast', 'gbp-sniper'];
  if (!rank || rank > 100) return ['zero-hero', 'das-v2', 'cl1'];
  if (rank > 50)  return ['das-v2', 'cl1', 'ctx-adv'];
  if (rank > 30)  return ['das-v2', 'cl2', 'hercules'];
  if (rank > 20)  return ['elias-cloud', 'hercules', 'ctx-adv'];
  if (rank > 10)  return ['elias-cloud', 'rd100', 'ctx-adv'];
  return ['elias-cloud', 'rd100', 'hercules'];
}

function offPageRowHtml(client, category, kwObj) {
  const kwid      = kwObj.id;
  const label     = kwObj.keyword || '(blank)';
  const rank      = kwObj.rank;
  const rankLabel = rank ? `#${rank}` : '—';
  const suggested = opgSuggestStrategies(kwObj);
  const selected  = kwObj.opgStrategy || '';
  const selStrat  = SEONEO_STRATEGIES.find(s => s.id === selected);

  const stratOptions = `<option value="">— None selected —</option>` +
    SEONEO_STRATEGIES.map(s =>
      `<option value="${s.id}"${selected === s.id ? ' selected' : ''}>${escHtml(s.name)}</option>`
    ).join('');

  const badges = suggested.map(id => {
    const s = SEONEO_STRATEGIES.find(x => x.id === id);
    return `<span class="wk-opg-badge${selected === id ? ' wk-opg-badge-active' : ''}" data-strat-id="${id}" title="${escHtml(s?.desc || '')}">${escHtml(s?.name || id)}</span>`;
  }).join('');

  return `
    <div class="wk-item-row wk-item-offpage">
      <div class="wk-item-main">
        <button class="wk-opg-toggle" data-kwid="${escHtml(kwid)}" title="Off-page strategy">▸</button>
        <span class="wk-item-label" title="${escHtml(label)}">${escHtml(label)}</span>
        ${weeklyStatusSelectHtml(client.id, category.key, kwid)}
      </div>
      <div class="wk-opg-accordion" id="wk-opg-${escHtml(kwid)}">
        <div class="wk-opg-inner">
          <div class="wk-opg-row">
            <span class="wk-opg-meta">Rank ${escHtml(rankLabel)}</span>
            <select class="wk-opg-strategy-select" data-kwid="${escHtml(kwid)}">${stratOptions}</select>
          </div>
          <div class="wk-opg-desc" style="${selStrat?.desc ? '' : 'display:none'}">${escHtml(selStrat?.desc || '')}</div>
          <div class="wk-opg-suggest">
            <span class="wk-opg-suggest-label">Suggested for rank ${escHtml(rankLabel)}:</span>
            ${badges}
          </div>
        </div>
      </div>
    </div>`;
}

let auditData         = {};    // { [clientId]: { ts, sourceFiles, todoText, checkedItems: string[] } }
let weeklyData        = null;  // null = still loading; { schedule, tasks } once loaded
let weeklySelectedDay  = null;  // which day's checklist is shown; defaults to today

function weeklyTodayKey() {
  return ['sun','mon','tue','wed','thu','fri','sat'][new Date().getDay()];
}

let weeklySyncTimer = null;
function weeklyScheduleServerSync() {
  if (weeklySyncTimer) clearTimeout(weeklySyncTimer);
  weeklySyncTimer = setTimeout(weeklySyncToServer, 600);
}
async function weeklySyncToServer() {
  weeklySyncTimer = null;
  try {
    await fetch('/api/weeklydata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(weeklyData),
    });
  } catch (_) {}
}

function weeklyDefaultData() {
  return { schedule: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }, tasks: {} };
}

async function weeklyLoadFromServer() {
  try {
    const r = await fetch('/api/weeklydata');
    if (!r.ok) throw new Error('bad response');
    const server = await r.json();
    // Normalize in case old single-clientId-per-day data is still around
    const schedule = {};
    for (const d of WEEKLY_DAYS) {
      const v = server.schedule?.[d.key];
      schedule[d.key] = Array.isArray(v) ? v : (v ? [v] : []);
    }
    weeklyData = { schedule, tasks: server.tasks || {} };
  } catch (_) {
    weeklyData = weeklyDefaultData();
  }
}

// Unique target pages derived from a client's Main Keywords
function weeklyClientPages(client) {
  const pages = new Set();
  (client?.keywords || []).filter(k => k.mainKeyword).forEach(k => {
    const page = (k.targetUrl || k.url || '').trim();
    if (page) pages.add(page);
  });
  return [...pages];
}

function weeklyGetStatus(clientId, category, itemKey) {
  return weeklyData?.tasks?.[clientId]?.[category]?.[itemKey] || 'not_started';
}

// { [categoryKey]: { done, total, blocked } } across all 4 categories for one client
function weeklyClientTaskCounts(client) {
  const counts = {};
  for (const cat of WEEKLY_CATEGORIES) {
    const itemKeys = cat.scope === 'mk'
      ? (client.keywords || []).filter(k => k.mainKeyword).map(k => k.id)
      : weeklyClientPages(client);
    let done = 0, blocked = 0;
    for (const itemKey of itemKeys) {
      const status = weeklyGetStatus(client.id, cat.key, itemKey);
      if (status === 'done') done++;
      if (status === 'blocked') blocked++;
    }
    counts[cat.key] = { done, total: itemKeys.length, blocked };
  }
  return counts;
}

// Compact per-category task-completion chips for a Dashboard client card
function dbTaskChipsHtml(client) {
  if (weeklyData === null) return '';
  const counts = weeklyClientTaskCounts(client);
  const totalItems = WEEKLY_CATEGORIES.reduce((s, cat) => s + counts[cat.key].total, 0);
  if (!totalItems) return '';

  const chips = WEEKLY_CATEGORIES.map(cat => {
    const { done, total, blocked } = counts[cat.key];
    if (!total) return '';
    const cls = blocked ? 'db-task-blocked' : done === total ? 'db-task-done' : 'db-task-partial';
    const tip = `${cat.label}: ${done}/${total} done${blocked ? ` · ${blocked} blocked` : ''}`;
    return `<span class="db-task-chip ${cls}" title="${escHtml(tip)}">${escHtml(cat.short)} ${done}/${total}</span>`;
  }).join('');

  return `<div class="db-tasks-row">${chips}</div>`;
}

function weeklySetStatus(clientId, category, itemKey, status) {
  const from = weeklyData.tasks?.[clientId]?.[category]?.[itemKey] ?? 'not_started';
  if (from !== status) {
    const client    = rtData?.clients?.find(c => c.id === clientId);
    const cat       = WEEKLY_CATEGORIES.find(c => c.key === category);
    const kw        = client?.keywords?.find(k => k.id === itemKey);
    logActivity({
      type: 'weekly', clientId, clientName: client?.name || clientId,
      category, categoryLabel: cat?.label || category,
      itemKey,  itemLabel: kw?.keyword || itemKey,
      from, to: status,
      fromLabel: WEEKLY_STATUSES.find(s => s.key === from)?.label  || from,
      toLabel:   WEEKLY_STATUSES.find(s => s.key === status)?.label || status,
    });
  }
  if (!weeklyData.tasks[clientId]) weeklyData.tasks[clientId] = {};
  if (!weeklyData.tasks[clientId][category]) weeklyData.tasks[clientId][category] = {};
  weeklyData.tasks[clientId][category][itemKey] = status;
  weeklyScheduleServerSync();
}

function weeklyAddDayClient(day, clientId) {
  if (!clientId) return;
  if (!weeklyData.schedule[day].includes(clientId)) weeklyData.schedule[day].push(clientId);
  weeklyScheduleServerSync();
  weeklyRender();
}

function weeklyRemoveDayClient(day, clientId) {
  weeklyData.schedule[day] = weeklyData.schedule[day].filter(id => id !== clientId);
  weeklyScheduleServerSync();
  weeklyRender();
}

function weeklyStatusSelectHtml(clientId, category, itemKey) {
  const status = weeklyGetStatus(clientId, category, itemKey);
  const meta = WEEKLY_STATUSES.find(s => s.key === status) || WEEKLY_STATUSES[0];
  const options = WEEKLY_STATUSES.map(s =>
    `<option value="${s.key}"${s.key === status ? ' selected' : ''}>${s.label}</option>`
  ).join('');
  return `<select class="wk-status-select ${meta.cls}" data-client="${escHtml(clientId)}" data-category="${category}" data-item="${escHtml(itemKey)}">${options}</select>`;
}

function weeklyCategorySectionHtml(client, category) {
  const mkKws = (client.keywords || []).filter(k => k.mainKeyword);
  const items = category.scope === 'mk'
    ? mkKws.map(k => ({ key: k.id, label: k.keyword || '(blank)', kw: k }))
    : weeklyClientPages(client).map(page => ({ key: page, label: page, kw: null }));

  if (!items.length) {
    const emptyMsg = category.scope === 'mk'
      ? 'No Main Keywords set for this client'
      : "No target pages set on this client's Main Keywords";
    return `<div class="wk-category">
      <div class="wk-category-title">${escHtml(category.label)}</div>
      <div class="wk-category-empty">${escHtml(emptyMsg)}</div>
    </div>`;
  }

  const rows = items.map(item => {
    if (category.key === 'offPage' && item.kw) {
      return offPageRowHtml(client, category, item.kw);
    }
    return `
      <div class="wk-item-row">
        <span class="wk-item-label" title="${escHtml(item.label)}">${escHtml(item.label)}</span>
        ${weeklyStatusSelectHtml(client.id, category.key, item.key)}
      </div>`;
  }).join('');

  return `<div class="wk-category">
    <div class="wk-category-title">${escHtml(category.label)} <span class="wk-category-count">(${items.length})</span></div>
    <div class="wk-item-list">${rows}</div>
  </div>`;
}

function weeklyRender() {
  const strip = document.getElementById('wk-scheduleStrip');
  const body  = document.getElementById('wk-dayBody');
  if (!strip || !body) return;

  if (weeklyData === null) {
    body.innerHTML = '<div class="db-empty">Loading…</div>';
    return;
  }
  if (!weeklySelectedDay) weeklySelectedDay = weeklyTodayKey();

  const clients  = rtData?.clients ?? [];
  const todayKey = weeklyTodayKey();

  strip.innerHTML = WEEKLY_DAYS.map(d => {
    const dayClientIds = weeklyData.schedule[d.key] || [];
    const dayClients   = dayClientIds.map(id => clients.find(c => c.id === id)).filter(Boolean);
    const unassigned   = clients.filter(c => !dayClientIds.includes(c.id));
    const isToday      = d.key === todayKey;
    const isSelected   = d.key === weeklySelectedDay;

    const chips = dayClients.map(c => `
      <span class="wk-day-chip">${escHtml(c.name)}<button class="wk-chip-remove" data-day="${d.key}" data-client="${escHtml(c.id)}" title="Remove">×</button></span>
    `).join('');

    return `<div class="wk-day-card${isSelected ? ' wk-day-selected' : ''}${isToday ? ' wk-day-today' : ''}" data-day="${d.key}">
      <div class="wk-day-label">${d.label}${isToday ? ' <span class="wk-today-dot">•</span>' : ''}</div>
      <div class="wk-day-chips">${chips}</div>
      <select class="wk-day-add-select" data-day="${d.key}">
        <option value="">+ add client</option>
        ${unassigned.map(c => `<option value="${escHtml(c.id)}">${escHtml(c.name)}</option>`).join('')}
      </select>
    </div>`;
  }).join('');

  const selDay        = WEEKLY_DAYS.find(d => d.key === weeklySelectedDay);
  const selClientIds  = weeklyData.schedule[weeklySelectedDay] || [];
  const selClients    = selClientIds.map(id => clients.find(c => c.id === id)).filter(Boolean);

  body.innerHTML = !selClients.length
    ? `<div class="db-empty">No client assigned to ${escHtml(selDay?.label || weeklySelectedDay)} yet — pick one above.</div>`
    : selClients.map(client => `
        <div class="wk-client-block">
          <div class="wk-day-header">
            <span class="wk-day-header-day">${escHtml(selDay?.label || '')}</span>
            <span class="wk-day-header-client">${escHtml(client.name)}</span>
          </div>
          <div class="wk-categories">
            ${WEEKLY_CATEGORIES.map(cat => weeklyCategorySectionHtml(client, cat)).join('')}
          </div>
        </div>`).join('');

  strip.querySelectorAll('.wk-day-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('select, button')) return;
      weeklySelectedDay = card.dataset.day;
      weeklyRender();
    });
  });
  strip.querySelectorAll('.wk-day-add-select').forEach(sel => {
    sel.addEventListener('click', e => e.stopPropagation());
    sel.addEventListener('change', e => {
      e.stopPropagation();
      weeklyAddDayClient(sel.dataset.day, sel.value);
    });
  });
  strip.querySelectorAll('.wk-chip-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      weeklyRemoveDayClient(btn.dataset.day, btn.dataset.client);
    });
  });
  body.querySelectorAll('.wk-status-select').forEach(sel => {
    sel.addEventListener('change', e => {
      weeklySetStatus(sel.dataset.client, sel.dataset.category, sel.dataset.item, sel.value);
      const meta = WEEKLY_STATUSES.find(s => s.key === sel.value);
      sel.className = 'wk-status-select ' + (meta?.cls || '');
      // Collapse off-page accordion when marked Done
      if (sel.value === 'done' && sel.dataset.category === 'offPage') {
        const accordion = document.getElementById('wk-opg-' + sel.dataset.item);
        if (accordion) {
          accordion.classList.remove('wk-opg-open');
          const toggleBtn = accordion.closest('.wk-item-offpage')?.querySelector('.wk-opg-toggle');
          if (toggleBtn) toggleBtn.textContent = '▸';
        }
      }
    });
  });

  body.querySelectorAll('.wk-opg-toggle').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const accordion = document.getElementById('wk-opg-' + btn.dataset.kwid);
      if (!accordion) return;
      const open = accordion.classList.toggle('wk-opg-open');
      btn.textContent = open ? '▾' : '▸';
    });
  });

  body.querySelectorAll('.wk-opg-strategy-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const client = rtData?.clients?.find(c => c.id === (sel.closest('.wk-client-block') ? sel.dataset.kwid : null))
                  ?? rtActiveClient();
      const kw = client?.keywords?.find(k => k.id === sel.dataset.kwid)
              ?? rtData?.clients?.flatMap(c => c.keywords || []).find(k => k.id === sel.dataset.kwid);
      if (kw) { kw.opgStrategy = sel.value; rtSave(); }
      const inner  = sel.closest('.wk-opg-inner');
      if (!inner) return;
      const strat  = SEONEO_STRATEGIES.find(s => s.id === sel.value);
      const descEl = inner.querySelector('.wk-opg-desc');
      if (descEl) { descEl.textContent = strat?.desc || ''; descEl.style.display = strat?.desc ? '' : 'none'; }
      inner.querySelectorAll('.wk-opg-badge').forEach(b =>
        b.classList.toggle('wk-opg-badge-active', b.dataset.stratId === sel.value));
    });
  });

  body.querySelectorAll('.wk-opg-badge').forEach(badge => {
    badge.addEventListener('click', () => {
      const inner = badge.closest('.wk-opg-inner');
      const stratSel = inner?.querySelector('.wk-opg-strategy-select');
      if (stratSel) { stratSel.value = badge.dataset.stratId; stratSel.dispatchEvent(new Event('change')); }
    });
  });
}

/* ════════════════════════════════════════════════
   ACTIVITY LOG TAB
════════════════════════════════════════════════ */

let logFilterClient   = '';
let logFilterCategory = '';
let logFilterDays     = 0;   // 0 = all time

function logFmtTs(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function logStatusPill(label, type, value) {
  let cls = 'log-pill';
  if (type === 'weekly') {
    const m = WEEKLY_STATUSES.find(s => s.label === label || s.key === value);
    if (m) cls += ' ' + m.cls;
  } else {
    const state = TASK_STATES.find(s => s.tip === label || s.val === value);
    if (state) cls += ' rt-task-' + (state.val === 0 ? 'none' : state.val === 1 ? 'prog' : 'done');
  }
  return `<span class="${cls}">${escHtml(label)}</span>`;
}

function logApplyFilters(entries) {
  let list = entries;
  if (logFilterClient)   list = list.filter(e => e.clientId === logFilterClient);
  if (logFilterCategory) list = list.filter(e => e.category === logFilterCategory);
  if (logFilterDays) {
    const cutoff = Date.now() - logFilterDays * 86400000;
    list = list.filter(e => new Date(e.ts).getTime() >= cutoff);
  }
  return list;
}

function logRenderList() {
  const listEl = document.getElementById('log-list');
  if (!listEl) return;
  const filtered = logApplyFilters(activityLog);
  if (!filtered.length) {
    listEl.innerHTML = '<div class="log-empty">No log entries yet — status changes will appear here.</div>';
    return;
  }
  listEl.innerHTML = filtered.map(e => `
    <div class="log-entry">
      <span class="log-entry-ts">${escHtml(logFmtTs(e.ts))}</span>
      <span class="log-entry-client">${escHtml(e.clientName || e.clientId || '—')}</span>
      <span class="log-entry-cat">${escHtml(e.categoryLabel || e.category)}</span>
      <span class="log-entry-item" title="${escHtml(e.itemLabel || e.itemKey || '')}">${escHtml(e.itemLabel || e.itemKey || '—')}</span>
      <span class="log-entry-arrow">→</span>
      ${logStatusPill(e.fromLabel, e.type, e.from)}
      <span class="log-entry-arrow">→</span>
      ${logStatusPill(e.toLabel, e.type, e.to)}
    </div>`).join('');
}

function logBuildControls() {
  const controlsEl = document.getElementById('log-controls');
  if (!controlsEl) return;

  const clients    = rtData?.clients ?? [];
  const categories = [
    ...WEEKLY_CATEGORIES.map(c => ({ key: c.key, label: c.label })),
    ...TASK_FIELDS.map(f => ({ key: f.key, label: f.title })),
  ];

  const clientOpts = `<option value="">All clients</option>` +
    clients.map(c => `<option value="${escHtml(c.id)}"${logFilterClient === c.id ? ' selected' : ''}>${escHtml(c.name)}</option>`).join('');
  const catOpts = `<option value="">All categories</option>` +
    categories.map(c => `<option value="${escHtml(c.key)}"${logFilterCategory === c.key ? ' selected' : ''}>${escHtml(c.label)}</option>`).join('');
  const dayOpts = [
    { v: 0, l: 'All time' }, { v: 7, l: 'Last 7 days' },
    { v: 30, l: 'Last 30 days' }, { v: 90, l: 'Last 90 days' },
  ].map(o => `<option value="${o.v}"${logFilterDays === o.v ? ' selected' : ''}>${o.l}</option>`).join('');

  controlsEl.innerHTML = `
    <select id="log-filter-client"   class="log-filter-select">${clientOpts}</select>
    <select id="log-filter-category" class="log-filter-select">${catOpts}</select>
    <select id="log-filter-days"     class="log-filter-select">${dayOpts}</select>
    <span class="log-count">${escHtml(String(logApplyFilters(activityLog).length))} entries</span>`;

  document.getElementById('log-filter-client')?.addEventListener('change', e => {
    logFilterClient = e.target.value; logRenderList();
    controlsEl.querySelector('.log-count').textContent = logApplyFilters(activityLog).length + ' entries';
  });
  document.getElementById('log-filter-category')?.addEventListener('change', e => {
    logFilterCategory = e.target.value; logRenderList();
    controlsEl.querySelector('.log-count').textContent = logApplyFilters(activityLog).length + ' entries';
  });
  document.getElementById('log-filter-days')?.addEventListener('change', e => {
    logFilterDays = parseInt(e.target.value) || 0; logRenderList();
    controlsEl.querySelector('.log-count').textContent = logApplyFilters(activityLog).length + ' entries';
  });
}

async function logTabRender() {
  if (!activityLog.length) {
    try {
      const r = await fetch('/api/activitylog');
      if (r.ok) { const d = await r.json(); activityLog = d.entries || []; }
    } catch (_) {}
  }
  logBuildControls();
  logRenderList();
}

/* ════════════════════════════════════════════════
   GSC INSIGHTS
════════════════════════════════════════════════ */

let gscStatus  = { configured: false, connected: false };
let gscSites   = [];
let gscRows    = [];        // raw GSC query rows
let gscLoaded  = false;

function gscDateRange(days) {
  const end = new Date(); end.setDate(end.getDate() - 1);
  const start = new Date(end); start.setDate(start.getDate() - (days - 1));
  const fmt = d => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}

function gscTagRow(row) {
  const pos = row.position;
  const ctr = row.ctr;
  const imp = row.impressions;
  if (pos >= 4  && pos <= 15 && imp >= 50)  return 'quick-win';
  if (pos >= 1  && pos <= 3  && ctr < 0.03) return 'ctr-issue';
  if (pos >= 11 && pos <= 30 && imp >= 100) return 'gap';
  return '';
}

function gscAllTrackedKeywords() {
  return (rtData?.clients ?? [])
    .flatMap(c => (c.keywords || []).map(k => (k.keyword || '').toLowerCase().trim()))
    .filter(Boolean);
}

async function gscCheckStatus() {
  try {
    const r = await fetch('/api/gsc/status');
    if (r.ok) gscStatus = await r.json();
  } catch (_) {}
}

async function gscLoadSites() {
  try {
    const r = await fetch('/api/gsc/sites');
    if (!r.ok) { const d = await r.json(); throw new Error(d.error || `HTTP ${r.status}`); }
    const d = await r.json();
    gscSites = d.sites || [];
    const sel = document.getElementById('gsc-site-select');
    if (!sel) return;
    sel.innerHTML = gscSites.length
      ? gscSites.map(s => `<option value="${escHtml(s.url)}">${escHtml(s.url)}</option>`).join('')
      : '<option value="">No verified properties found</option>';
  } catch (e) {
    const sel = document.getElementById('gsc-site-select');
    if (sel) sel.innerHTML = `<option value="">Error loading sites: ${escHtml(e.message)}</option>`;
  }
}

async function gscLoadData() {
  const siteUrl = document.getElementById('gsc-site-select')?.value;
  const days    = parseInt(document.getElementById('gsc-range-select')?.value || '28');
  const results = document.getElementById('gsc-results');
  if (!siteUrl) { if (results) results.innerHTML = '<div class="gsc-msg">Select a property first.</div>'; return; }
  if (results) results.innerHTML = '<div class="gsc-msg">Loading GSC data…</div>';

  try {
    const { startDate, endDate } = gscDateRange(days);
    const r = await fetch('/api/gsc/queries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteUrl, startDate, endDate, rowLimit: 500 }),
    });
    if (!r.ok) { const d = await r.json(); throw new Error(d.error || `HTTP ${r.status}`); }
    const d = await r.json();
    gscRows   = d.rows || [];
    gscLoaded = true;
    gscRenderResults(siteUrl, days, startDate, endDate);
  } catch (e) {
    if (results) results.innerHTML = `<div class="gsc-msg gsc-error">Error: ${escHtml(e.message)}</div>`;
  }
}

function gscRenderResults(siteUrl, days, startDate, endDate) {
  const results = document.getElementById('gsc-results');
  if (!results || !gscRows.length) {
    if (results) results.innerHTML = '<div class="gsc-msg">No data returned for this property / date range.</div>';
    return;
  }

  const tracked  = new Set(gscAllTrackedKeywords());
  const total    = gscRows.length;
  const totClicks = gscRows.reduce((s, r) => s + r.clicks, 0);
  const totImpr   = gscRows.reduce((s, r) => s + r.impressions, 0);
  const avgCTR    = totImpr ? (totClicks / totImpr * 100).toFixed(1) : '0';
  const avgPos    = gscRows.length ? (gscRows.reduce((s, r) => s + r.position, 0) / gscRows.length).toFixed(1) : '—';

  const quickWins  = gscRows.filter(r => gscTagRow(r) === 'quick-win');
  const ctrIssues  = gscRows.filter(r => gscTagRow(r) === 'ctr-issue');
  const gaps       = gscRows.filter(r => gscTagRow(r) === 'gap');
  const untracked  = gscRows.filter(r => r.clicks > 0 && !tracked.has((r.keys?.[0] || '').toLowerCase().trim()));

  const tagBadge = tag => {
    if (tag === 'quick-win') return '<span class="gsc-tag gsc-tag-win">Quick Win</span>';
    if (tag === 'ctr-issue') return '<span class="gsc-tag gsc-tag-ctr">Low CTR</span>';
    if (tag === 'gap')       return '<span class="gsc-tag gsc-tag-gap">Content Gap</span>';
    return '';
  };

  const tableRows = gscRows.slice(0, 200).map(row => {
    const q   = row.keys?.[0] || '';
    const tag = gscTagRow(row);
    const isUntracked = row.clicks > 0 && !tracked.has(q.toLowerCase().trim());
    return `<tr class="${tag ? 'gsc-tr-' + tag : ''}">
      <td class="gsc-td-kw">${escHtml(q)}${tagBadge(tag)}${isUntracked ? '<span class="gsc-tag gsc-tag-new">+Track</span>' : ''}</td>
      <td class="gsc-td-num">${row.clicks}</td>
      <td class="gsc-td-num">${row.impressions}</td>
      <td class="gsc-td-num">${(row.ctr * 100).toFixed(1)}%</td>
      <td class="gsc-td-pos ${row.position <= 3 ? 'gsc-pos-top' : row.position <= 10 ? 'gsc-pos-p1' : row.position <= 20 ? 'gsc-pos-p2' : 'gsc-pos-deep'}">${row.position.toFixed(1)}</td>
    </tr>`;
  }).join('');

  results.innerHTML = `
    <div class="gsc-stab-nav">
      <button class="gsc-stab active" data-stab="performance">Performance Report</button>
      <button class="gsc-stab"        data-stab="ai">AI Analysis</button>
    </div>

    <div class="gsc-stab-panel active" id="gsc-tab-performance">
      <div class="gsc-summary-row">
        <div class="gsc-stat"><div class="gsc-stat-val">${total}</div><div class="gsc-stat-lbl">Queries</div></div>
        <div class="gsc-stat"><div class="gsc-stat-val">${totClicks.toLocaleString()}</div><div class="gsc-stat-lbl">Clicks</div></div>
        <div class="gsc-stat"><div class="gsc-stat-val">${totImpr.toLocaleString()}</div><div class="gsc-stat-lbl">Impressions</div></div>
        <div class="gsc-stat"><div class="gsc-stat-val">${avgCTR}%</div><div class="gsc-stat-lbl">Avg CTR</div></div>
        <div class="gsc-stat"><div class="gsc-stat-val">${avgPos}</div><div class="gsc-stat-lbl">Avg Position</div></div>
      </div>

      <div class="gsc-insight-cards">
        <div class="gsc-insight-card gsc-card-win">
          <div class="gsc-insight-n">${quickWins.length}</div>
          <div class="gsc-insight-label">Quick Wins</div>
          <div class="gsc-insight-desc">Pos 4–15, 50+ impressions — one push from page 1</div>
        </div>
        <div class="gsc-insight-card gsc-card-ctr">
          <div class="gsc-insight-n">${ctrIssues.length}</div>
          <div class="gsc-insight-label">Low CTR</div>
          <div class="gsc-insight-desc">Top 3 position but CTR &lt;3% — title/meta fix needed</div>
        </div>
        <div class="gsc-insight-card gsc-card-gap">
          <div class="gsc-insight-n">${gaps.length}</div>
          <div class="gsc-insight-label">Content Gaps</div>
          <div class="gsc-insight-desc">Pos 11–30, 100+ impressions — needs content targeting</div>
        </div>
        <div class="gsc-insight-card gsc-card-new">
          <div class="gsc-insight-n">${untracked.length}</div>
          <div class="gsc-insight-label">Untracked</div>
          <div class="gsc-insight-desc">Clicks but not in Rank Tracker — add to monitoring</div>
        </div>
      </div>

      <div class="gsc-table-wrap">
        <table class="gsc-table">
          <thead><tr>
            <th>Query</th>
            <th>Clicks</th>
            <th>Impressions</th>
            <th>CTR</th>
            <th>Position</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>

    <div class="gsc-stab-panel" id="gsc-tab-ai">
      <div class="gsc-ai-bar">
        <button id="gsc-ai-btn" class="btn-sm btn-accent">Run Full SEO Audit</button>
        <span class="gsc-ai-note">Powered by Claude · analyses top queries against a 13-section senior SEO framework</span>
      </div>
      <div id="gsc-ai-result" class="gsc-ai-result" style="display:none"></div>
    </div>`;

  document.getElementById('gsc-ai-btn')?.addEventListener('click', () => gscRunAI(siteUrl, days));
  document.querySelectorAll('.gsc-stab').forEach(btn => {
    btn.addEventListener('click', () => {
      const stab = btn.dataset.stab;
      document.querySelectorAll('.gsc-stab').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.gsc-stab-panel').forEach(p =>
        p.classList.toggle('active', p.id === `gsc-tab-${stab}`));
    });
  });
}

async function gscRunAI(siteUrl, days) {
  const btn    = document.getElementById('gsc-ai-btn');
  const result = document.getElementById('gsc-ai-result');
  if (!btn || !result) return;
  btn.disabled = true; btn.textContent = 'Analyzing…';
  result.style.display = 'none';

  if (!gscRows.length) {
    result.style.display = '';
    result.innerHTML = '<div class="gsc-msg gsc-error">Load GSC data first before running AI analysis.</div>';
    btn.disabled = false; btn.textContent = 'Run Full SEO Audit';
    return;
  }

  const tracked   = gscAllTrackedKeywords();
  const top50     = gscRows.slice(0, 50);
  const tableText = top50.map(r =>
    `${r.keys?.[0] || ''} | clicks:${r.clicks} | imp:${r.impressions} | ctr:${(r.ctr*100).toFixed(1)}% | pos:${r.position.toFixed(1)}`
  ).join('\n');

  const systemPrompt = `You are a senior SEO analyst with 10+ years of hands-on experience auditing Google Search Console (GSC) data for clients across e-commerce, SaaS, content, and local business sites. You think like a consultant, not a report generator: you prioritize findings by business impact, flag what's urgent vs. nice-to-have, and always translate raw numbers into a clear action plan a non-technical client can understand.

You are precise, evidence-based, and never invent data. If a metric isn't in the data provided, say so explicitly rather than guessing. If a report is missing, note the gap and skip that section rather than fabricating numbers.

Work through every section below that you have data for. For each finding, state: what you found → why it matters → recommended action. Use bullet points and tables where useful. Cite the actual numbers from the data for every claim.

## 1. Performance Report — Query Analysis
- Query segmentation: branded vs. non-branded, and by intent (transactional / informational / navigational).
- CTR vs. position benchmarking: compare actual CTR against typical curves (pos 1 ≈ 25-35%, pos 2-3 ≈ 10-20%). Flag underperformers (title/meta issue) and overperformers at low positions (quick-win candidates).
- Long-tail vs. head-term ratio: healthy growth usually shows long-tail queries outpacing head terms.

## 2. Striking-Distance Keywords
- Queries at position 8-20 with meaningful impression volume (top 20% of impressions in this band).
- Rank by estimated opportunity (impressions × realistic CTR uplift if moved to position 5 or better — label as estimate).
- Note which already have a matching page vs. need new content.

## 3. Keyword Cannibalization
- Queries where multiple URLs from the site may be competing — infer from query patterns and position volatility.
- Recommend consolidation, canonicalization, or internal linking fixes where likely.

## 4. Decay Patterns
- Flag queries/keywords showing signs of click or impression decline based on current position and CTR data.
- Distinguish real decay from likely seasonality where possible.

## 5. New/Unplanned Query Opportunities & Impression Spikes
- Surface queries generating meaningful impressions with no obviously targeted page.
- Flag queries where impressions are high but clicks are disproportionately low (possible algo testing, irrelevant match, or SERP feature stealing clicks).

## 6. Untracked Performers
- Keywords getting clicks that aren't in the Rank Tracker list — recommend adding to monitoring.

## Output Structure
1. **Executive Summary** (3-5 bullets, plain language, client-facing tone)
2. **Findings by Category** (sections 1-6 above, only include where data supports a finding)
3. **Priority Action Plan** — table with columns: Finding | Impact (High/Med/Low) | Effort (High/Med/Low) | Recommended Action
4. **Data Gaps** — note any analysis that would benefit from a longer date range or a comparison period, and flag where the query sample size is too small to draw a reliable conclusion

Be direct and specific — cite real numbers, not vague language. Never present an estimate as a fact; label projections as estimates. If the data shows a clearly positive trend, say so.`;

  const userMessage = `SITE: ${siteUrl}
PERIOD: Last ${days} days

TOP QUERIES (by impressions):
Query | Clicks | Impressions | CTR | Avg Position
${tableText}

KEYWORDS CURRENTLY IN RANK TRACKER:
${tracked.slice(0, 40).join(', ') || 'none'}

Please run the full GSC audit on this data. Be specific — cite query names and actual numbers for every finding.`;

  try {
    const r = await fetch('/api/claude/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:      'claude-haiku-4-5',
        max_tokens: 4000,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userMessage }],
      }),
    });
    if (!r.ok) {
      let msg;
      try { const d = await r.json(); msg = d.error?.message; } catch {}
      throw new Error(msg || `HTTP ${r.status} — server may be restarting, try again`);
    }
    const d = await r.json();
    const text = d.content?.find(b => b.type === 'text')?.text || '';
    if (!text) {
      result.style.display = '';
      result.innerHTML = '<div class="gsc-msg gsc-error">AI returned no content. Check ANTHROPIC_API_KEY is set in Railway and try again.</div>';
      return;
    }
    result.style.display = '';
    const inl = s => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    let mdHtml = escHtml(text);
    // Convert markdown tables before the newline→<br> pass
    mdHtml = mdHtml.replace(/^\|.+\|\n\|[-| :]+\|\n(?:\|.+\|(?:\n|$))*/gm, blk => {
      const lines = blk.trim().split('\n');
      const hdrs = lines[0].split('|').slice(1, -1).map(s => s.trim());
      const rows = lines.slice(2).filter(Boolean).map(r => r.split('|').slice(1, -1).map(s => s.trim()));
      return '<div class="gsc-ai-table-wrap"><table class="gsc-ai-table"><thead><tr>' +
        hdrs.map(h => `<th>${inl(h)}</th>`).join('') +
        '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => `<td>${inl(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>';
    });
    mdHtml = mdHtml
      .replace(/^## (.+)$/gm, '</div><h3 class="gsc-ai-h3">$1</h3><div class="gsc-ai-body">')
      .replace(/^### (.+)$/gm, '<h4 class="gsc-ai-h4">$1</h4>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
    result.innerHTML = '<div class="gsc-ai-content">' + mdHtml + '</div>';
  } catch (e) {
    result.style.display = '';
    result.innerHTML = `<div class="gsc-msg gsc-error">AI error: ${escHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Run Full SEO Audit';
  }
}

async function gscRender() {
  const bar      = document.getElementById('gsc-connect-bar');
  const controls = document.getElementById('gsc-controls');
  if (!bar) return;

  await gscCheckStatus();

  if (!gscStatus.configured) {
    bar.innerHTML = `
      <div class="gsc-setup-card">
        <h3 class="gsc-setup-title">Connect Google Search Console</h3>
        <p class="gsc-setup-desc">To connect GSC, you need a Google OAuth app. Set these Railway env vars:</p>
        <ol class="gsc-setup-steps">
          <li>Go to <strong>Google Cloud Console → APIs &amp; Services → Credentials</strong></li>
          <li>Create an <strong>OAuth 2.0 Client ID</strong> (Web application type)</li>
          <li>Add Authorized Redirect URI: <code class="gsc-code">${location.origin}/api/gsc/callback</code></li>
          <li>Set Railway vars: <code class="gsc-code">GOOGLE_CLIENT_ID</code>, <code class="gsc-code">GOOGLE_CLIENT_SECRET</code>, <code class="gsc-code">APP_URL=${location.origin}</code></li>
          <li>Enable the <strong>Google Search Console API</strong> in your Cloud project</li>
        </ol>
      </div>`;
    if (controls) controls.style.display = 'none';
    return;
  }

  if (!gscStatus.connected) {
    bar.innerHTML = `
      <div class="gsc-connect-prompt">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <span>Not connected to Google Search Console</span>
        <a href="/api/gsc/auth" class="btn-sm btn-accent">Connect Google Account</a>
      </div>`;
    if (controls) controls.style.display = 'none';
    return;
  }

  bar.innerHTML = `
    <div class="gsc-connected-bar">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
      Connected to Google Search Console
      <button id="gsc-disconnect-btn" class="gsc-disconnect-btn">Disconnect</button>
    </div>`;
  if (controls) controls.style.display = 'flex';

  document.getElementById('gsc-disconnect-btn')?.addEventListener('click', async () => {
    await fetch('/api/gsc/disconnect', { method: 'POST' });
    gscStatus.connected = false; gscRows = []; gscLoaded = false;
    document.getElementById('gsc-results').innerHTML = '';
    gscRender();
  });

  if (!gscSites.length) await gscLoadSites();

  document.getElementById('gsc-load-btn')?.addEventListener('click', gscLoadData);
  if (gscLoaded) {
    const siteUrl  = document.getElementById('gsc-site-select')?.value;
    const days     = parseInt(document.getElementById('gsc-range-select')?.value || '28');
    const { startDate, endDate } = gscDateRange(days);
    gscRenderResults(siteUrl, days, startDate, endDate);
  }
}

/* ── init rank tracker ── */
async function rtInit() {
  await rtLoadFromServer();

  // Events
  document.getElementById('rt-clientSelect').addEventListener('change', e => {
    rtData.activeClientId = e.target.value;
    rtSave();
    rtRender();
    const gs = document.getElementById('global-client-select');
    if (gs) gs.value = e.target.value;
  });

  // Global client selector (header bar) — wire change event here since rtData is loaded
  document.getElementById('global-client-select')?.addEventListener('change', e => {
    if (!rtData) return;
    rtData.activeClientId = e.target.value;
    rtSave();
    const rtSel = document.getElementById('rt-clientSelect');
    if (rtSel) rtSel.value = e.target.value;
    const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
    if (activeTab === 'ranks') rtRender();
    if (activeTab === 'ahrefs') ahrefsRender();
    if (activeTab === 'indexy') { indexyLoadSaved(e.target.value); indexyAltTextPrefill(); }
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
      const kw = rtActiveClient()?.keywords?.find(k => k.id === coraBtn.dataset.id);
      if (kw) coraOpenForKeyword(kw, false);
      return;
    }

    const runCoraBtn = e.target.closest('.rt-run-cora-btn');
    if (runCoraBtn) {
      const kw = rtActiveClient()?.keywords?.find(k => k.id === runCoraBtn.dataset.id);
      if (kw) coraOpenForKeyword(kw, true);
      return;
    }

    const repBtn = e.target.closest('.rt-rep-btn');
    if (repBtn && !repBtn.disabled) {
      showPopReport(repBtn.dataset.client, repBtn.dataset.kw);
      return;
    }

    const imgBtn = e.target.closest('.rt-img-btn');
    if (imgBtn) { agOpenImageModal(imgBtn.dataset.kwid); return; }

    const taskBtn = e.target.closest('.rt-task-btn');
    if (taskBtn) {
      const kw = rtActiveClient()?.keywords?.find(k => k.id === taskBtn.dataset.id);
      if (kw) {
        const field  = taskBtn.dataset.task;
        const from   = kw[field] ?? 0;
        const to     = (from + 1) % 3;
        const tf     = TASK_FIELDS.find(f => f.key === field);
        const client = rtActiveClient();
        logActivity({
          type: 'rt', clientId: client?.id || '', clientName: client?.name || '',
          category: field, categoryLabel: tf?.title || field,
          itemKey: kw.id, itemLabel: kw.keyword || kw.id,
          from, to,
          fromLabel: TASK_STATES.find(s => s.val === from)?.tip || String(from),
          toLabel:   TASK_STATES.find(s => s.val === to)?.tip   || String(to),
        });
        kw[field] = to;
        rtSave(); rtRender(); dbRender();
      }
      return;
    }

    const scoreBtn = e.target.closest('.rt-pop-score-btn');
    if (scoreBtn) { rtPopScoreCheck(scoreBtn.dataset.kwid); return; }

    const detailBtn = e.target.closest('.rt-pop-detail-btn');
    if (detailBtn) { rtPopShowDetails(detailBtn.dataset.kwid); return; }

    const popBtn = e.target.closest('.rt-run-pop-btn');
    if (popBtn) {
      rtOptimizeInAG(popBtn.dataset.kwid);
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

/* Load POP locations into datalist once, cache in memory */
let _popLocations = null;
async function rtLoadPopLocations() {
  const dl = document.getElementById('pop-locations-list');
  if (!dl || dl.children.length > 0) return; // already populated
  try {
    if (!_popLocations) {
      const r = await fetch('/api/pop-locations');
      _popLocations = await r.json();
    }
    dl.innerHTML = (_popLocations || []).map(l => `<option value="${escHtml(l)}">`).join('');
  } catch { /* silently skip — user can still type manually */ }
}

let _popLanguages = null;
async function rtLoadPopLanguages() {
  const sel = document.getElementById('rt-popLanguage');
  if (!sel) return;
  try {
    if (!_popLanguages) {
      const r = await fetch('/api/pop-languages');
      _popLanguages = await r.json();
    }
    if (!Array.isArray(_popLanguages) || !_popLanguages.length) return;
    const cur = (sel.value || 'english').toLowerCase();
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    // All language options come straight from POP (exact case-sensitive values)
    sel.innerHTML = _popLanguages.map(l => `<option value="${escHtml(l)}">${escHtml(cap(l))}</option>`).join('');
    sel.value = _popLanguages.includes(cur) ? cur : 'english';
  } catch { /* keep the hardcoded options as fallback */ }
}

function rtShowAddClient() {
  document.getElementById('rt-modalTitle').textContent     = 'Add Client';
  document.getElementById('rt-clientName').value           = '';
  document.getElementById('rt-campaignId').value           = '';
  document.getElementById('rt-wpUrl').value                = '';
  document.getElementById('rt-wpUser').value               = '';
  document.getElementById('rt-wpPass').value               = '';
  document.getElementById('rt-popLocation').value          = '';
  document.getElementById('rt-popLanguage').value          = 'english';
  document.getElementById('rt-popGnl').checked             = false;
  document.getElementById('rt-deleteClientBtn').classList.add('hidden');
  document.getElementById('rt-saveClientBtn').dataset.mode = 'add';
  if (hasAA) rtLoadCampaigns();
  else document.getElementById('rt-campaignPickWrap').classList.add('hidden');
  rtLoadPopLocations();
  rtLoadPopLanguages();
  rtOpenModal('rt-clientModal');
}

function rtShowEditClient() {
  const c = rtActiveClient();
  if (!c) return;
  document.getElementById('rt-modalTitle').textContent     = 'Edit Client';
  document.getElementById('rt-clientName').value           = c.name;
  document.getElementById('rt-campaignId').value           = c.aaCampaignId || '';
  document.getElementById('rt-wpUrl').value                = c.wpUrl  || '';
  document.getElementById('rt-wpUser').value               = c.wpUser || '';
  document.getElementById('rt-wpPass').value               = c.wpPass || '';
  document.getElementById('rt-popLocation').value          = c.popLocation || '';
  document.getElementById('rt-popLanguage').value          = c.popLanguage || 'english';
  document.getElementById('rt-popGnl').checked             = !!c.popGnl;
  document.getElementById('rt-deleteClientBtn').classList.remove('hidden');
  document.getElementById('rt-saveClientBtn').dataset.mode = 'edit';
  if (hasAA) rtLoadCampaigns(c.aaCampaignId);
  else document.getElementById('rt-campaignPickWrap').classList.add('hidden');
  rtLoadPopLocations();
  rtLoadPopLanguages();
  rtOpenModal('rt-clientModal');
}

function rtSaveClient() {
  const name        = document.getElementById('rt-clientName').value.trim();
  const cid         = document.getElementById('rt-campaignId').value.trim();
  const wpUrl       = document.getElementById('rt-wpUrl').value.trim();
  const wpUser      = document.getElementById('rt-wpUser').value.trim();
  const wpPass      = document.getElementById('rt-wpPass').value.trim();
  const popLocation = document.getElementById('rt-popLocation').value;
  const popLanguage = document.getElementById('rt-popLanguage').value;
  const popGnl      = document.getElementById('rt-popGnl').checked;
  const mode        = document.getElementById('rt-saveClientBtn').dataset.mode;
  if (!name) return;
  if (mode === 'add') {
    const client = { id: rtUid(), name, aaCampaignId: cid, wpUrl, wpUser, wpPass, popLocation, popLanguage, popGnl, keywords: [] };
    rtData.clients.push(client);
    rtData.activeClientId = client.id;
  } else {
    const c = rtActiveClient();
    if (c) { c.name = name; c.aaCampaignId = cid; c.wpUrl = wpUrl; c.wpUser = wpUser; c.wpPass = wpPass; c.popLocation = popLocation; c.popLanguage = popLanguage; c.popGnl = popGnl; }
  }
  rtSave();
  rtRender();
  populateGlobalClientSelect();
  rtCloseModal('rt-clientModal');
}

function rtDeleteClient() {
  const c = rtActiveClient();
  if (!c || !confirm(`Delete "${c.name}" and all its keywords?`)) return;
  rtData.clients = rtData.clients.filter(x => x.id !== c.id);
  rtData.activeClientId = rtData.clients[0]?.id || null;
  rtSave();
  rtRender();
  populateGlobalClientSelect();
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
    .map(t => (typeof t === 'string' ? t : (t?.label || t?.name || t?.tag || ''))
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
    const today  = new Date().toISOString().slice(0, 10);
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

    // "tags" isn't reliably populated off the `keyword` asset — also pull it
    // from campaign-rankings (confirmed to expose a tags field there),
    // keyed by keyword_id, and check both sources.
    let tagsByKwId = {};
    try {
      const tagRows = await aaQuery({
        asset: 'campaign-rankings',
        operation: 'read',
        fields: ['keyword_id', 'keyword_phrase', 'tags'],
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
      for (const r of tagRows) if (r.keyword_id != null) tagsByKwId[r.keyword_id] = r.tags;
      console.log('[AA import] tags by keyword_id (from campaign-rankings):', tagsByKwId);
    } catch (e) {
      console.warn('[AA import] campaign-rankings tags lookup failed, falling back to keyword asset only:', e.message);
    }

    console.log('[AA import] starredRows ids:', starredRows.map(r => r.id),
      '| tagsByKwId keys:', Object.keys(tagsByKwId));

    const existingByPhrase = new Map(c.keywords.map(k => [(k.keyword || '').toLowerCase(), k]));
    let added = 0, markedMk = 0, skipped = 0;
    for (const row of starredRows) {
      const phrase = (row.keyword_phrase || '').trim();
      if (!phrase) continue;
      const key    = phrase.toLowerCase();
      const fromKwAsset = aaTagNames(row);
      const fromRankings = aaTagNames({ tags: tagsByKwId[row.id] });
      const wantMk = fromKwAsset.includes('sm') || fromRankings.includes('sm');
      if (fromKwAsset.length || fromRankings.length) {
        console.log('[AA import] row', row.id, phrase, '| keyword-asset tags:', fromKwAsset,
          '| campaign-rankings tags:', fromRankings, '| wantMk:', wantMk);
      }

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
let coraTargetKwId   = null;   // which keyword an upload/report is associated with

// Injects a "which keyword is this for" picker into the upload zone, since
// Cora reports are now associated per-keyword instead of per-client.
function coraRenderTargetSelect() {
  const upload = document.getElementById('cora-upload');
  const inner  = upload?.querySelector('.cora-upload-inner');
  if (!inner) return;

  const existing = document.getElementById('cora-targetKwWrap');
  if (existing) existing.remove();

  const client = rtActiveClient();
  if (!client || !client.keywords?.length) return;

  const wrap = document.createElement('div');
  wrap.id = 'cora-targetKwWrap';
  wrap.className = 'form-group';
  wrap.style.cssText = 'max-width:340px;margin:0 auto 14px;text-align:left';
  wrap.innerHTML = `
    <label class="form-label">Associate with keyword</label>
    <select id="cora-targetKeyword" class="form-select">
      ${client.keywords.map(k =>
        `<option value="${escHtml(k.id)}"${k.id === coraTargetKwId ? ' selected' : ''}>${escHtml(k.keyword || '(blank)')}</option>`
      ).join('')}
    </select>`;

  const fileInput = inner.querySelector('input[type=file]');
  inner.insertBefore(wrap, fileInput || inner.firstChild);

  document.getElementById('cora-targetKeyword').addEventListener('change', e => {
    coraTargetKwId = e.target.value;
  });

  if (!coraTargetKwId) coraTargetKwId = client.keywords[0].id;
}

// Opens the Cora tab scoped to one keyword — shows its report if it's
// already the one loaded in memory, otherwise prompts a (re-)upload since
// parsed Cora data isn't persisted, only the filename/domain tag is.
function coraOpenForKeyword(kw, forceUpload) {
  coraTargetKwId = kw.id;
  switchTab('cora');

  const alreadyLoaded = !forceUpload && coraReport && kw.coraFileName && coraReport.fileName === kw.coraFileName;
  if (alreadyLoaded) {
    coraRender();
  } else {
    coraReset();
  }
}

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
  // Capture the chosen target keyword before the upload zone gets wiped by the spinner
  const targetKwId = document.getElementById('cora-targetKeyword')?.value || coraTargetKwId;
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
    // Validate domain matches the target keyword's URL, then tag it onto that keyword
    const rtClient = rtActiveClient();
    const targetKw = rtClient?.keywords?.find(k => k.id === targetKwId);
    if (targetKw) {
      const normalize = d => String(d || '').toLowerCase().replace(/^www\./, '').replace(/\/.*$/, '').trim();
      const coraDomain = normalize(coraReport.meta?.domain);

      if (coraDomain) {
        const kwDomains = new Set();
        [targetKw.url, targetKw.targetUrl].forEach(u => {
          try { kwDomains.add(normalize(new URL(u).hostname)); } catch {}
        });

        const matched = kwDomains.size === 0
          || [...kwDomains].some(d => d === coraDomain || d.includes(coraDomain) || coraDomain.includes(d));

        if (!matched) {
          const kwList = [...kwDomains].join(', ') || '(no URL set on this keyword)';
          const proceed = confirm(
            `⚠️ Domain mismatch\n\nThis Cora report is for:  ${coraDomain}\nKeyword URL:              ${kwList}\n\nAssociate this report with "${targetKw.keyword}" anyway?`
          );
          if (!proceed) return;
        }
      }

      coraTargetKwId       = targetKw.id;
      targetKw.coraFileName = file.name;
      targetKw.coraDomain   = coraDomain;
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

  coraRenderTargetSelect();
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

/* ── INDEXY ── */
let indexySaveTimer = null;

function indexyRender() {
  const area = document.getElementById('indexy-upload-area');
  if (!area || area.dataset.ready) return;
  area.dataset.ready = '1';

  area.innerHTML = `
    <div class="indexy-subnav">
      <button class="indexy-subbtn active" data-sub="audit">📋 Audit Extractor</button>
      <button class="indexy-subbtn" data-sub="alttext">🖼️ Alt Text Generator</button>
    </div>

    <div id="indexy-sub-audit" class="indexy-subpanel active">
      <div class="indexy-form">
        <label class="indexy-file-label">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span id="indexy-pdf-name">Audit Report (PDF)</span>
          <input type="file" id="indexy-pdf" accept=".pdf">
        </label>
        <label class="indexy-file-label">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span id="indexy-xlsx-name">Workbook (XLSX / CSV)</span>
          <input type="file" id="indexy-xlsx" accept=".xlsx,.xls,.csv">
        </label>
        <button id="indexy-btn" class="btn-sm btn-accent">Extract To-Do List</button>
        <span class="indexy-note">Upload one or both files — Claude reads all sheets and pages</span>
      </div>
      <div id="indexy-progress" class="indexy-progress" style="display:none">
        <div class="indexy-prog-bar"><div id="indexy-prog-fill" class="indexy-prog-fill"></div></div>
        <span id="indexy-prog-label" class="indexy-prog-label"></span>
      </div>
    </div>

    <div id="indexy-sub-alttext" class="indexy-subpanel">
      <div class="indexy-form">
        <input id="alttext-url" type="url" placeholder="https://example.com" class="indexy-url-input">
        <label class="indexy-label-inline">
          Pages to scan:
          <select id="alttext-maxpages" class="indexy-select-sm">
            <option value="1">Homepage only</option>
            <option value="5" selected>Up to 5 pages</option>
            <option value="10">Up to 10 pages</option>
          </select>
        </label>
        <button id="alttext-btn" class="btn-sm btn-accent">Scan &amp; Generate Alt Text</button>
        <span class="indexy-note">Crawls the site, finds images missing or with vague alt text, generates recommendations</span>
      </div>
      <div id="alttext-result"></div>
    </div>`;

  // Sub-tab switching
  area.querySelectorAll('.indexy-subbtn').forEach(btn => {
    btn.addEventListener('click', () => {
      area.querySelectorAll('.indexy-subbtn').forEach(b => b.classList.remove('active'));
      area.querySelectorAll('.indexy-subpanel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('indexy-sub-' + btn.dataset.sub)?.classList.add('active');
    });
  });

  // Audit extractor wiring
  document.getElementById('indexy-pdf').addEventListener('change', e => {
    document.getElementById('indexy-pdf-name').textContent = e.target.files[0]?.name || 'Audit Report (PDF)';
  });
  document.getElementById('indexy-xlsx').addEventListener('change', e => {
    document.getElementById('indexy-xlsx-name').textContent = e.target.files[0]?.name || 'Workbook (XLSX / CSV)';
  });
  document.getElementById('indexy-btn').addEventListener('click', indexyExtract);

  // Alt text wiring
  document.getElementById('alttext-btn').addEventListener('click', indexyAltTextScrape);
}

function indexySyncClient() {
  indexyLoadSaved(rtData.activeClientId);
  indexyAltTextPrefill();
}

async function indexyAltTextScrape() {
  const btn       = document.getElementById('alttext-btn');
  const result    = document.getElementById('alttext-result');
  const url       = document.getElementById('alttext-url').value.trim();
  const maxPages  = document.getElementById('alttext-maxpages').value;
  const clientId  = rtData.activeClientId;
  const client    = rtData?.clients?.find(c => c.id === clientId);

  if (!url) { result.innerHTML = '<div class="gsc-msg gsc-error">Enter the website URL first.</div>'; return; }

  btn.disabled = true;
  btn.textContent = 'Scanning…';
  result.innerHTML = '<div class="gsc-msg">Crawling site and generating alt text — this may take 20–30 seconds…</div>';

  try {
    const r = await fetch('/api/alttext/scrape', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, maxPages: parseInt(maxPages), clientName: client?.name || '' }),
    });
    let data;
    try { data = await r.json(); } catch { throw new Error(`HTTP ${r.status} — server may be restarting`); }
    if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);

    const images = data.images || [];
    const debug  = data.debug  || [];
    if (!images.length) {
      const debugHtml = debug.length
        ? '<details class="alttext-debug"><summary>Debug — pages crawled</summary><ul>' +
          debug.map(p => `<li>${escHtml(p.url)} — <strong>${p.imgs} images found</strong> (${escHtml(p.status)})</li>`).join('') +
          '</ul></details>'
        : '';
      result.innerHTML = `<div class="gsc-msg">No images with missing or vague alt text found.<br><small>If this seems wrong, check the debug info below.</small></div>${debugHtml}`;
      return;
    }

    result.innerHTML = indexyAltTextTable(images, url);
    result.querySelectorAll('.alttext-copy-btn').forEach(b => {
      b.addEventListener('click', () => {
        navigator.clipboard.writeText(b.dataset.text).then(() => {
          const orig = b.textContent; b.textContent = 'Copied!';
          setTimeout(() => b.textContent = orig, 1500);
        });
      });
    });
    document.getElementById('alttext-csv-btn')?.addEventListener('click', () => indexyAltTextCsv(images));
    document.getElementById('alttext-push-btn')?.addEventListener('click', () => indexyAltTextPushWP(images));
  } catch (e) {
    result.innerHTML = `<div class="gsc-msg gsc-error">Error: ${escHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan & Generate Alt Text';
  }
}

function indexyAltTextTable(images, siteUrl) {
  const issueBadge = issue => {
    const cls = issue === 'Missing' ? 'alttext-badge-red' : issue === 'Vague' ? 'alttext-badge-yellow' : issue === 'Too long' ? 'alttext-badge-yellow' : 'alttext-badge-ok';
    return `<span class="alttext-badge ${cls}">${escHtml(issue)}</span>`;
  };
  const rows = images.map(img => {
    const pagePath = img.page?.replace(/^https?:\/\/[^/]+/, '') || '/';
    const imgName  = img.src?.split('/').pop()?.split('?')[0] || img.src || '';
    return `<tr>
      <td title="${escHtml(img.page)}">${escHtml(pagePath)}</td>
      <td class="alttext-img-cell" title="${escHtml(img.src)}">${escHtml(imgName)}</td>
      <td class="alttext-current">${escHtml(img.currentAlt || '(missing)')}</td>
      <td>${issueBadge(img.issue)}</td>
      <td class="alttext-recommended">${escHtml(img.recommended || '')}
        <button class="alttext-copy-btn" data-text="${escHtml(img.recommended || '')}">Copy</button>
      </td>
    </tr>`;
  }).join('');

  return `
    <div class="alttext-toolbar">
      <span class="alttext-count">${images.length} image${images.length !== 1 ? 's' : ''} need attention</span>
      <div style="display:flex;gap:6px">
        <button id="alttext-csv-btn" class="btn-sm">Download CSV</button>
        <button id="alttext-push-btn" class="btn-sm btn-accent">Push to WordPress</button>
      </div>
    </div>
    <div id="alttext-wp-panel" class="alttext-wp-panel" style="display:none">
      <p class="alttext-wp-help">Go to <strong>WP Admin → Users → Profile → Application Passwords</strong>, create one named "SEOManager", copy it below.</p>
      <div class="alttext-wp-form">
        <input id="alttext-wp-url"  type="url"  placeholder="https://example.com (WordPress site URL)" class="indexy-url-input">
        <input id="alttext-wp-user" type="text" placeholder="WordPress username" class="indexy-url-input" style="max-width:200px">
        <input id="alttext-wp-pass" type="password" placeholder="Application Password (xxxx xxxx xxxx)" class="indexy-url-input" style="max-width:260px">
        <button id="alttext-wp-go" class="btn-sm btn-accent">Apply Alt Text to Site</button>
      </div>
      <div id="alttext-wp-status"></div>
    </div>
    <div class="gsc-ai-table-wrap">
      <table class="gsc-ai-table alttext-table" id="alttext-main-table">
        <thead><tr>
          <th>Page</th><th>Image</th><th>Current Alt</th><th>Issue</th><th>Recommended Alt Text</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function indexyAltTextPrefill() {
  const clientId = rtData.activeClientId;
  const c = rtData?.clients?.find(cl => cl.id === clientId);
  // Auto-fill scan URL from client's WP site URL
  const scanUrl = document.getElementById('alttext-url');
  if (scanUrl && c?.wpUrl) scanUrl.value = c.wpUrl;
  // Auto-fill WP credentials panel
  const urlEl  = document.getElementById('alttext-wp-url');
  const userEl = document.getElementById('alttext-wp-user');
  const passEl = document.getElementById('alttext-wp-pass');
  if (!urlEl) return;
  if (c?.wpUrl)  urlEl.value  = c.wpUrl;
  if (c?.wpUser) userEl.value = c.wpUser;
  if (c?.wpPass) passEl.value = c.wpPass;
}

function indexyAltTextPushWP(images) {
  const panel = document.getElementById('alttext-wp-panel');
  if (!panel) return;
  // Pre-fill from saved client credentials before toggling
  indexyAltTextPrefill();
  const isVisible = panel.style.display !== 'none';
  panel.style.display = isVisible ? 'none' : 'block';
  if (!isVisible) {
    document.getElementById('alttext-wp-go').onclick = async () => {
      const siteUrl    = document.getElementById('alttext-wp-url').value.trim();
      const username   = document.getElementById('alttext-wp-user').value.trim();
      const appPassword = document.getElementById('alttext-wp-pass').value.trim();
      const status     = document.getElementById('alttext-wp-status');
      if (!siteUrl || !username || !appPassword) {
        status.innerHTML = '<div class="gsc-msg gsc-error">Fill in all three fields.</div>'; return;
      }
      const btn = document.getElementById('alttext-wp-go');
      btn.disabled = true; btn.textContent = 'Pushing…';
      status.innerHTML = '<div class="gsc-msg">Connecting to WordPress and updating images…</div>';
      try {
        const r = await fetch('/api/alttext/push-wp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ siteUrl, username, appPassword, images }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);

        const results = data.results || [];
        let updated = 0, notFound = 0, errors = 0;
        results.forEach(res => {
          if (res.status === 'updated') updated++;
          else if (res.status === 'not_found') notFound++;
          else if (res.status === 'error') errors++;

          // Update status cell in table row
          const tbl = document.getElementById('alttext-main-table');
          if (tbl) {
            tbl.querySelectorAll('tbody tr').forEach(tr => {
              const copyBtn = tr.querySelector('.alttext-copy-btn');
              if (copyBtn?.dataset.text === res.recommended || tr.cells[1]?.title?.endsWith(res.src?.split('/').pop()?.split('?')[0])) {
                const cell = tr.cells[5] || tr.insertCell(5);
                cell.innerHTML = res.status === 'updated'
                  ? '<span class="alttext-badge alttext-badge-ok">✓ Updated</span>'
                  : res.status === 'not_found'
                  ? '<span class="alttext-badge alttext-badge-yellow">Not found</span>'
                  : '<span class="alttext-badge alttext-badge-red">Error</span>';
              }
            });
          }
        });
        status.innerHTML = `<div class="gsc-msg" style="color:var(--success,#2d9e6b)">✓ ${updated} updated · ${notFound} not found in media library · ${errors} errors</div>`;
      } catch (e) {
        status.innerHTML = `<div class="gsc-msg gsc-error">Error: ${escHtml(e.message)}</div>`;
      } finally {
        btn.disabled = false; btn.textContent = 'Apply Alt Text to Site';
      }
    };
  }
}

function indexyAltTextCsv(images) {
  const header = ['Page', 'Image', 'Current Alt', 'Issue', 'Recommended Alt Text'];
  const rows   = images.map(img => [
    img.page || '',
    img.src?.split('/').pop()?.split('?')[0] || '',
    img.currentAlt || '',
    img.issue || '',
    img.recommended || '',
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
  const csv  = [header.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = 'alt-text-audit.csv';
  a.click();
}

function indexyLoadSaved(clientId) {
  const result = document.getElementById('indexy-result');
  if (!result) return;
  const saved = auditData[clientId];
  if (!saved?.todoText) {
    result.innerHTML = '';
    document.getElementById('indexy-progress').style.display = 'none';
    return;
  }
  result.innerHTML = '<div class="indexy-output">' + indexyRenderMd(saved.todoText, saved.checkedItems || []) + '</div>';
  indexyWireCheckboxes(clientId);
  indexyWireRTButtons(result);
  indexyWireTabs(result);
  indexyUpdateProgress(clientId);
}

function indexyWireCheckboxes(clientId) {
  const result  = document.getElementById('indexy-result');
  const client  = rtData?.clients?.find(c => c.id === clientId);
  result?.querySelectorAll('.indexy-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const li       = cb.closest('li');
      const taskText = li.querySelector('label')?.textContent?.trim() || '';
      li.classList.toggle('indexy-done', cb.checked);

      const rec = auditData[clientId] || {};
      const set = new Set(rec.checkedItems || []);
      cb.checked ? set.add(taskText) : set.delete(taskText);
      if (!auditData[clientId]) auditData[clientId] = { todoText: '' };
      auditData[clientId].checkedItems = [...set];

      indexyUpdateProgress(clientId);
      indexyScheduleSave(clientId);

      if (client) {
        logActivity({
          type:          'indexy',
          clientId,
          clientName:    client.name,
          category:      'audit',
          categoryLabel: 'SEO Audit',
          itemLabel:     taskText.slice(0, 120),
          from:          cb.checked ? 'pending' : 'done',
          to:            cb.checked ? 'done'    : 'pending',
          fromLabel:     cb.checked ? 'Pending' : 'Done',
          toLabel:       cb.checked ? 'Done'    : 'Pending',
        });
      }
    });
  });
}

function indexyUpdateProgress(clientId) {
  const progEl   = document.getElementById('indexy-progress');
  const fillEl   = document.getElementById('indexy-prog-fill');
  const labelEl  = document.getElementById('indexy-prog-label');
  const result   = document.getElementById('indexy-result');
  if (!progEl || !result) return;
  const total   = result.querySelectorAll('.indexy-check').length;
  const checked = result.querySelectorAll('.indexy-check:checked').length;
  if (!total) { progEl.style.display = 'none'; return; }
  const pct = Math.round(checked / total * 100);
  progEl.style.display = 'flex';
  fillEl.style.width   = pct + '%';
  labelEl.textContent  = `${checked} / ${total} tasks complete (${pct}%)`;
}

function indexyScheduleSave(clientId) {
  clearTimeout(indexySaveTimer);
  indexySaveTimer = setTimeout(() => indexySaveAudit(clientId), 800);
}

async function indexySaveAudit(clientId) {
  if (!clientId || !auditData[clientId]) return;
  try {
    await fetch('/api/auditdata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [clientId]: auditData[clientId] }),
    });
  } catch (_) {}
}

async function indexyExtract() {
  const btn       = document.getElementById('indexy-btn');
  const result    = document.getElementById('indexy-result');
  const pdfInput  = document.getElementById('indexy-pdf');
  const xlsxInput = document.getElementById('indexy-xlsx');
  const clientId  = rtData.activeClientId || '';
  if (!pdfInput.files.length && !xlsxInput.files.length) {
    result.innerHTML = '<div class="gsc-msg gsc-error">Upload at least one file first.</div>';
    return;
  }
  btn.disabled = true; btn.textContent = 'Reading files…';
  result.innerHTML = '';
  const sourceFiles = [pdfInput.files[0]?.name, xlsxInput.files[0]?.name].filter(Boolean).join(', ');
  const fd = new FormData();
  if (pdfInput.files[0])  fd.append('pdf',  pdfInput.files[0]);
  if (xlsxInput.files[0]) fd.append('xlsx', xlsxInput.files[0]);
  try {
    const r = await fetch('/api/indexy/extract', { method: 'POST', body: fd });
    if (!r.ok) {
      let msg; try { const d = await r.json(); msg = d.error?.message; } catch {}
      throw new Error(msg || `HTTP ${r.status}`);
    }
    const d    = await r.json();
    const text = d.content?.find(b => b.type === 'text')?.text || '';
    if (!text) throw new Error('No content returned — try again.');

    // Save to auditData and server
    if (clientId) {
      auditData[clientId] = { ts: new Date().toISOString(), sourceFiles, todoText: text, checkedItems: [] };
      indexySaveAudit(clientId);
    }

    result.innerHTML = '<div class="indexy-output">' + indexyRenderMd(text, []) + '</div>';
    indexyWireRTButtons(result);
    indexyWireTabs(result);
    if (clientId) indexyWireCheckboxes(clientId);
    else {
      result.querySelectorAll('.indexy-check').forEach(cb => {
        cb.addEventListener('change', () => cb.closest('li').classList.toggle('indexy-done', cb.checked));
      });
    }
    indexyUpdateProgress(clientId);
    dbRender();
  } catch (e) {
    result.innerHTML = `<div class="gsc-msg gsc-error">Error: ${escHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Extract To-Do List';
  }
}

function indexyRenderMd(rawText, checkedItems = []) {
  const checkedSet = new Set(checkedItems);
  const inl = s => escHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  function renderLines(lines, sectionTitle) {
    const out = [];
    let inList = false, inTable = false, tableLines = [];

    const isContentPlan = hdrs => {
      const low = hdrs.map(h => h.toLowerCase());
      return (sectionTitle || '').toLowerCase().includes('new content') ||
        low.some(h => h === 'keyword' || h === 'recommended title' || h.includes('parent topic'));
    };

    const flushTable = () => {
      if (!tableLines.length) return;
      const hdrs = tableLines[0].split('|').slice(1, -1).map(s => s.trim());
      const rows = tableLines.slice(2).filter(Boolean).map(r => r.split('|').slice(1, -1).map(s => s.trim()));
      const cp = isContentPlan(hdrs);
      const headCells = hdrs.map(h => `<th>${inl(h)}</th>`).join('') + (cp ? '<th>RT</th>' : '');
      const bodyRows = rows.map(r => {
        const cells = r.map(c => `<td>${inl(c)}</td>`).join('');
        if (cp) {
          const kwIdx  = hdrs.findIndex(h => /^keyword$/i.test(h));
          const ptIdx  = hdrs.findIndex(h => /parent.?topic/i.test(h));
          const volIdx = hdrs.findIndex(h => /volume|traffic/i.test(h));
          const kw  = r[kwIdx >= 0 ? kwIdx : ptIdx] || '';
          const vol = r[volIdx >= 0 ? volIdx : -1] || '';
          const btn = kw ? `<button class="indexy-rt-btn" data-kw="${escHtml(kw)}" data-vol="${escHtml(vol)}" title="Add to Rank Tracker">+ RT</button>` : '';
          return `<tr>${cells}<td>${btn}</td></tr>`;
        }
        return `<tr>${cells}</tr>`;
      }).join('');
      out.push(`<div class="gsc-ai-table-wrap"><table class="gsc-ai-table"><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>`);
      tableLines = []; inTable = false;
    };

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (line.startsWith('|')) {
        if (inList) { out.push('</ul>'); inList = false; }
        inTable = true; tableLines.push(line); continue;
      }
      if (inTable) flushTable();

      if (/^#{1,2} /.test(line)) {
        if (inList) { out.push('</ul>'); inList = false; }
        out.push(`<h3 class="indexy-h3">${inl(line.replace(/^#{1,2} /, ''))}</h3>`); continue;
      }
      if (/^### /.test(line)) {
        if (inList) { out.push('</ul>'); inList = false; }
        out.push(`<h4 class="indexy-h4">${inl(line.replace(/^### /, ''))}</h4>`); continue;
      }

      const cbMatch = line.match(/^- \[([ xX])\] (.+)/);
      if (cbMatch) {
        if (!inList) { out.push('<ul class="indexy-list">'); inList = true; }
        const taskText = cbMatch[2].replace(/\s*\[([^\]]{0,80})\]\s*$/, ' ($1)').trim();
        const checked  = cbMatch[1].toLowerCase() === 'x' || checkedSet.has(taskText);
        out.push(`<li class="${checked ? 'indexy-done' : ''}"><label><input type="checkbox" class="indexy-check"${checked ? ' checked' : ''}> ${inl(taskText)}</label></li>`);
        continue;
      }
      if (/^- /.test(line)) {
        if (!inList) { out.push('<ul class="indexy-list">'); inList = true; }
        out.push(`<li>${inl(line.slice(2).replace(/\s*\[([^\]]{0,80})\]\s*$/, ' ($1)').trim())}</li>`);
        continue;
      }
      if (inList) { out.push('</ul>'); inList = false; }
      if (!line.trim()) { out.push('<br>'); continue; }
      out.push(`<p>${inl(line.replace(/\s*\[([^\]]{0,80})\]\s*$/, ' ($1)').trim())}</p>`);
    }
    if (inList)  out.push('</ul>');
    if (inTable) flushTable();
    return out.join('');
  }

  // Split rawText into sections at ## headings
  const sections = [];
  let cur = { title: null, lines: [] };
  for (const raw of rawText.split('\n')) {
    if (/^## /.test(raw.trimEnd())) {
      if (cur.title !== null || cur.lines.some(l => l.trim())) sections.push(cur);
      cur = { title: raw.trimEnd().replace(/^## /, ''), lines: [] };
    } else {
      cur.lines.push(raw);
    }
  }
  if (cur.title !== null || cur.lines.some(l => l.trim())) sections.push(cur);

  const preamble    = sections.find(s => s.title === null);
  const tabSections = sections.filter(s => s.title !== null);

  // Fallback: no ## headings — render flat
  if (!tabSections.length) return renderLines(rawText.split('\n'), '');

  const tabLabel = title =>
    title
      .replace(/HIGH PRIORITY/i,   '🔴 High Priority')
      .replace(/MEDIUM PRIORITY/i, '🟡 Medium')
      .replace(/LOW PRIORITY/i,    '🟢 Low Priority')
      .replace(/ON HOLD/i,         '⚠️ On Hold')
      .replace(/NEW CONTENT PAGES[^$]*/i, '📄 New Pages')
      .replace(/EXISTING PAGES[^$]*/i,    '🔧 On-Page Fixes')
      .replace(/DATA CAVEATS/i,    'ℹ️ Caveats')
      .replace(/\s*[—–-]\s*.+$/, '')   // strip " — subtitle"
      .trim();

  const uid = 'itab' + Date.now();
  const parts = [];

  if (preamble) {
    const pre = renderLines(preamble.lines, '').replace(/<br>/g, ' ').trim();
    if (pre) parts.push(`<p class="indexy-preamble">${pre}</p>`);
  }

  parts.push('<div class="indexy-tab-nav">');
  tabSections.forEach((s, i) =>
    parts.push(`<button class="indexy-stab${i === 0 ? ' active' : ''}" data-panel="${uid}-${i}">${escHtml(tabLabel(s.title))}</button>`)
  );
  parts.push('</div>');

  tabSections.forEach((s, i) => {
    parts.push(`<div class="indexy-stab-panel${i === 0 ? ' active' : ''}" id="${uid}-${i}">`);
    parts.push(renderLines(s.lines, s.title));
    parts.push('</div>');
  });

  return parts.join('');
}

function indexyAddToRT(kw, vol) {
  const clientId = rtData.activeClientId;
  const c = rtData?.clients?.find(cl => cl.id === clientId);
  if (!c) { alert('Select a client first (header dropdown).'); return false; }
  const exists = c.keywords.some(k => k.keyword.toLowerCase() === kw.toLowerCase());
  if (exists) { alert(`"${kw}" is already in Rank Tracker for ${c.name}.`); return false; }
  c.keywords.push({ id: rtUid(), url: '', keyword: kw, volume: vol ? parseInt(vol) || null : null, note: 'Added from Indexy', popStatus: '', popDate: '', rank: null, prevRank: null, lastCheck: null });
  rtSave();
  return true;
}

function indexyWireRTButtons(container) {
  container.querySelectorAll('.indexy-rt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (indexyAddToRT(btn.dataset.kw, btn.dataset.vol)) {
        btn.textContent = '✓ Added';
        btn.disabled = true;
        btn.classList.add('indexy-rt-added');
      }
    });
  });
}

function indexyWireTabs(container) {
  container.querySelectorAll('.indexy-tab-nav .indexy-stab').forEach(btn => {
    btn.addEventListener('click', () => {
      const output = btn.closest('.indexy-output');
      btn.closest('.indexy-tab-nav').querySelectorAll('.indexy-stab').forEach(b => b.classList.remove('active'));
      output.querySelectorAll('.indexy-stab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      output.querySelector('#' + btn.dataset.panel)?.classList.add('active');
    });
  });
}

/* ══════════════════════════════════════════════════════
   AHREFS SEO HUB
══════════════════════════════════════════════════════ */
let ahrefsCache = {};   // domain → { overview, backlinks, keywords, pages, broken }
let ahrefsDomain = '';

function ahrefsRender() {
  const root = document.getElementById('ahrefs-root');
  if (!root) return;

  // Sync domain from active client's wpUrl
  const c = rtActiveClient();
  const domainFromClient = c?.wpUrl ? (() => { try { return new URL(c.wpUrl).hostname; } catch { return ''; } })() : '';
  if (!ahrefsDomain && domainFromClient) ahrefsDomain = domainFromClient;

  root.innerHTML = `
    <div class="db-header" style="margin-bottom:0">
      <h2 class="db-title">Ahrefs SEO Hub</h2>
      <p class="db-sub">Pull live data from Ahrefs and get AI-powered strategy recommendations.</p>
    </div>
    <div class="ah-toolbar">
      <input id="ah-domain" type="text" class="ah-domain-input" placeholder="example.com" value="${escHtml(ahrefsDomain)}">
      <select id="ah-country" class="indexy-select-sm">
        <option value="us">US</option><option value="ca">CA</option><option value="gb">GB</option>
        <option value="au">AU</option><option value="global">Global</option>
      </select>
      <button id="ah-pull-btn" class="btn-sm btn-accent">Pull Data</button>
      <span id="ah-status" class="ah-status"></span>
    </div>

    <div class="gsc-stab-nav" id="ah-tab-nav">
      <button class="gsc-stab active" data-ahtab="overview">📊 Overview</button>
      <button class="gsc-stab" data-ahtab="backlinks">🔗 Backlinks</button>
      <button class="gsc-stab" data-ahtab="keywords">🔑 Keywords</button>
      <button class="gsc-stab" data-ahtab="pages">📄 Top Pages</button>
      <button class="gsc-stab" data-ahtab="opportunities">⚡ Opportunities</button>
      <button class="gsc-stab" data-ahtab="strategy">🤖 AI Strategy</button>
    </div>

    <div id="ah-panel-overview"      class="gsc-stab-panel active"><div class="ah-empty">Pull data to see overview.</div></div>
    <div id="ah-panel-backlinks"     class="gsc-stab-panel"><div class="ah-empty">Pull data to see backlinks.</div></div>
    <div id="ah-panel-keywords"      class="gsc-stab-panel"><div class="ah-empty">Pull data to see keywords.</div></div>
    <div id="ah-panel-pages"         class="gsc-stab-panel"><div class="ah-empty">Pull data to see top pages.</div></div>
    <div id="ah-panel-opportunities" class="gsc-stab-panel"><div class="ah-empty">Pull data to see opportunities.</div></div>
    <div id="ah-panel-strategy"      class="gsc-stab-panel"><div class="ah-empty">Pull data first, then click "Generate Strategy".</div></div>`;

  // Tab switching
  root.querySelectorAll('.gsc-stab').forEach(btn => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('.gsc-stab').forEach(b => b.classList.remove('active'));
      root.querySelectorAll('.gsc-stab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('ah-panel-' + btn.dataset.ahtab)?.classList.add('active');
    });
  });

  document.getElementById('ah-pull-btn').addEventListener('click', ahrefsPullAll);

  // If we have cached data for this domain, restore it
  const cached = ahrefsCache[ahrefsDomain];
  if (cached) ahrefsRenderAll(cached);
}

async function ahrefsQuery(endpoint, params) {
  const r = await fetch('/api/ahrefs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, params }),
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

async function ahrefsPullAll() {
  const raw     = document.getElementById('ah-domain').value.trim();
  const domain  = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  const country = document.getElementById('ah-country').value;
  const btn     = document.getElementById('ah-pull-btn');
  const status  = document.getElementById('ah-status');
  if (!domain) { status.textContent = 'Enter a domain first.'; return; }

  // Write cleaned domain back to the input
  document.getElementById('ah-domain').value = domain;
  ahrefsDomain = domain;
  btn.disabled = true;
  status.style.color = '';

  const steps = [
    ['Overview',          'site-explorer/overview',          { target: domain, mode: 'domain', country }],
    ['Domain Rating',     'site-explorer/domain-rating',     { target: domain }],
    ['Backlinks',         'site-explorer/backlinks',         { target: domain, mode: 'domain', limit: 100, order_by: 'domain_rating_source:desc' }],
    ['Referring Domains', 'site-explorer/refdomains',        { target: domain, mode: 'domain', limit: 100, order_by: 'domain_rating:desc' }],
    ['Keywords',          'site-explorer/organic-keywords',  { target: domain, mode: 'domain', limit: 100, country, order_by: 'traffic:desc' }],
    ['Top Pages',         'site-explorer/top-pages',         { target: domain, mode: 'domain', limit: 50,  country }],
    ['Broken Backlinks',  'site-explorer/broken-backlinks',  { target: domain, mode: 'domain', limit: 100 }],
    ['Best by Links',     'site-explorer/best-by-links',     { target: domain, mode: 'domain', limit: 50 }],
  ];

  const data = {};
  let firstError = null;
  for (const [label, endpoint, params] of steps) {
    status.textContent = `Fetching ${label}…`;
    try {
      const result = await ahrefsQuery(endpoint, params);
      data[endpoint.split('/').pop()] = result;
    } catch (e) {
      const msg = e.message || '';
      if (!firstError) firstError = msg;
      // If API key not configured, bail immediately — no point continuing
      if (msg.includes('AHREFS_API_KEY') || msg.includes('not configured')) {
        status.style.color = '#dc3c3c';
        status.textContent = '⚠ AHREFS_API_KEY not set — add it to Railway Variables';
        btn.disabled = false;
        document.getElementById('ah-panel-overview').innerHTML =
          `<div class="ah-error-box">
            <strong>Ahrefs API key not configured.</strong><br>
            Go to your Railway dashboard → Variables → add <code>AHREFS_API_KEY</code> with your Ahrefs API key.<br>
            Find your key at <strong>app.ahrefs.com → Settings → API</strong>.
          </div>`;
        return;
      }
      data[endpoint.split('/').pop()] = { error: msg };
    }
  }

  ahrefsCache[domain] = data;
  if (firstError && Object.values(data).every(v => v?.error)) {
    status.style.color = '#dc3c3c';
    status.textContent = `⚠ All requests failed: ${firstError}`;
  } else {
    status.style.color = '#2d9e6b';
    status.textContent = '✓ Data loaded';
  }
  btn.disabled = false;
  ahrefsRenderAll(data);
}

function ahrefsRenderAll(data) {
  ahrefsRenderOverview(data);
  ahrefsRenderBacklinks(data);
  ahrefsRenderKeywords(data);
  ahrefsRenderPages(data);
  ahrefsRenderOpportunities(data);
  // Strategy panel gets a button to trigger Claude
  document.getElementById('ah-panel-strategy').innerHTML = `
    <button id="ah-strategy-btn" class="btn-sm btn-accent" style="margin-bottom:16px">🤖 Generate AI Strategy</button>
    <div id="ah-strategy-result"></div>`;
  document.getElementById('ah-strategy-btn').addEventListener('click', ahrefsGenerateStrategy);
}

function ahMetric(label, value, sub = '') {
  return `<div class="ah-metric"><div class="ah-metric-val">${escHtml(String(value ?? '—'))}</div><div class="ah-metric-label">${label}</div>${sub ? `<div class="ah-metric-sub">${sub}</div>` : ''}</div>`;
}

function ahrefsRenderOverview(data) {
  const ov = data.overview || {};
  const dr = data['domain-rating'] || {};
  const panel = document.getElementById('ah-panel-overview');
  if (!panel) return;

  const metrics = `<div class="ah-metrics-row">
    ${ahMetric('Domain Rating', dr.domain?.domain_rating ?? ov.domain_rating ?? '—')}
    ${ahMetric('Backlinks', (ov.backlinks ?? ov.metrics?.backlinks ?? '—').toLocaleString?.() ?? '—')}
    ${ahMetric('Referring Domains', (ov.refdomains ?? ov.metrics?.refdomains ?? '—').toLocaleString?.() ?? '—')}
    ${ahMetric('Organic Traffic', (ov.org_traffic ?? ov.metrics?.org_traffic ?? '—').toLocaleString?.() ?? '—', 'est. monthly visits')}
    ${ahMetric('Organic Keywords', (ov.org_keywords ?? ov.metrics?.org_keywords ?? '—').toLocaleString?.() ?? '—')}
    ${ahMetric('Paid Traffic', (ov.paid_traffic ?? ov.metrics?.paid_traffic ?? 0).toLocaleString?.() ?? '0')}
  </div>`;

  // Top refdomains preview
  const refs = data.refdomains?.refdomains ?? [];
  const refsTable = refs.length ? `
    <h4 class="indexy-h4">Top Referring Domains</h4>
    <div class="gsc-ai-table-wrap"><table class="gsc-ai-table">
      <thead><tr><th>Domain</th><th>DR</th><th>Links</th><th>Traffic</th></tr></thead>
      <tbody>${refs.slice(0, 10).map(r => `<tr>
        <td>${escHtml(r.refdomains ?? r.domain ?? '')}</td>
        <td>${r.domain_rating ?? '—'}</td>
        <td>${(r.backlinks ?? 0).toLocaleString()}</td>
        <td>${(r.org_traffic ?? 0).toLocaleString()}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : '';

  panel.innerHTML = metrics + refsTable;
}

function ahrefsRenderBacklinks(data) {
  const panel = document.getElementById('ah-panel-backlinks');
  if (!panel) return;
  const bls = data.backlinks?.backlinks ?? [];
  if (!bls.length) { panel.innerHTML = '<div class="ah-empty">No backlinks data.</div>'; return; }
  panel.innerHTML = `
    <p class="ah-info">${bls.length} backlinks loaded (sorted by DR)</p>
    <div class="gsc-ai-table-wrap"><table class="gsc-ai-table">
      <thead><tr><th>Source</th><th>DR</th><th>Anchor</th><th>Target URL</th><th>Type</th><th>First seen</th></tr></thead>
      <tbody>${bls.map(b => `<tr>
        <td><a href="${escHtml(b.url_from??'')}" target="_blank" class="ah-link">${escHtml((b.domain_from??b.url_from??'').replace(/^https?:\/\//, '').split('/')[0])}</a></td>
        <td>${b.domain_rating_source ?? '—'}</td>
        <td class="ah-anchor">${escHtml(b.anchor ?? '—')}</td>
        <td class="ah-url" title="${escHtml(b.url_to??'')}">${escHtml((b.url_to??'').replace(/^https?:\/\/[^/]+/,'').slice(0,40)||'/')}</td>
        <td>${b.link_type === 'nofollow' ? '<span class="ah-nf">nofollow</span>' : '<span class="ah-follow">dofollow</span>'}</td>
        <td>${b.first_seen?.slice(0,10) ?? '—'}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

function ahrefsRenderKeywords(data) {
  const panel = document.getElementById('ah-panel-keywords');
  if (!panel) return;
  const kws = data['organic-keywords']?.keywords ?? [];
  if (!kws.length) { panel.innerHTML = '<div class="ah-empty">No keywords data.</div>'; return; }
  panel.innerHTML = `
    <p class="ah-info">${kws.length} keywords loaded (sorted by traffic)</p>
    <div class="gsc-ai-table-wrap"><table class="gsc-ai-table">
      <thead><tr><th>Keyword</th><th>Position</th><th>Volume</th><th>Traffic</th><th>KD</th><th>URL</th></tr></thead>
      <tbody>${kws.map(k => {
        const pos = k.pos ?? k.position ?? 0;
        const posCls = pos <= 3 ? 'ah-pos-top' : pos <= 10 ? 'ah-pos-p1' : 'ah-pos-p2';
        return `<tr>
          <td class="ah-kw">${escHtml(k.keyword ?? '')}</td>
          <td><span class="ah-pos ${posCls}">${pos}</span></td>
          <td>${(k.volume ?? 0).toLocaleString()}</td>
          <td>${(k.traffic ?? 0).toLocaleString()}</td>
          <td>${k.difficulty ?? k.kd ?? '—'}</td>
          <td class="ah-url" title="${escHtml(k.url??'')}">${escHtml((k.url??'').replace(/^https?:\/\/[^/]+/,'').slice(0,35)||'/')}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
}

function ahrefsRenderPages(data) {
  const panel = document.getElementById('ah-panel-pages');
  if (!panel) return;
  const pages = data['top-pages']?.pages ?? [];
  const bestByLinks = data['best-by-links']?.pages ?? [];
  if (!pages.length && !bestByLinks.length) { panel.innerHTML = '<div class="ah-empty">No pages data.</div>'; return; }

  const topTraffic = pages.length ? `
    <h4 class="indexy-h4">Top Pages by Organic Traffic</h4>
    <div class="gsc-ai-table-wrap"><table class="gsc-ai-table">
      <thead><tr><th>URL</th><th>Traffic</th><th>Keywords</th><th>Top Keyword</th></tr></thead>
      <tbody>${pages.slice(0, 30).map(p => `<tr>
        <td class="ah-url"><a href="${escHtml(p.url??'')}" target="_blank" class="ah-link">${escHtml((p.url??'').replace(/^https?:\/\/[^/]+/,'').slice(0,50)||'/')}</a></td>
        <td>${(p.traffic ?? 0).toLocaleString()}</td>
        <td>${(p.keywords ?? 0).toLocaleString()}</td>
        <td class="ah-kw">${escHtml(p.top_keyword ?? '—')}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : '';

  const topLinks = bestByLinks.length ? `
    <h4 class="indexy-h4" style="margin-top:20px">Pages with Most Backlinks</h4>
    <div class="gsc-ai-table-wrap"><table class="gsc-ai-table">
      <thead><tr><th>URL</th><th>Backlinks</th><th>Ref Domains</th></tr></thead>
      <tbody>${bestByLinks.slice(0, 20).map(p => `<tr>
        <td class="ah-url"><a href="${escHtml(p.url??'')}" target="_blank" class="ah-link">${escHtml((p.url??'').replace(/^https?:\/\/[^/]+/,'').slice(0,50)||'/')}</a></td>
        <td>${(p.backlinks ?? 0).toLocaleString()}</td>
        <td>${(p.refdomains ?? 0).toLocaleString()}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : '';

  panel.innerHTML = topTraffic + topLinks;
}

function ahrefsRenderOpportunities(data) {
  const panel = document.getElementById('ah-panel-opportunities');
  if (!panel) return;
  const broken  = data['broken-backlinks']?.backlinks ?? [];
  const kws     = data['organic-keywords']?.keywords ?? [];

  // Broken backlinks = link reclamation opportunities
  const brokenHtml = broken.length ? `
    <h4 class="indexy-h4">🔗 Broken Backlinks — Reclaim These Links (${broken.length})</h4>
    <p class="ah-info">These sites link to your 404 pages. Fix the URLs or set up redirects to reclaim the link equity.</p>
    <div class="gsc-ai-table-wrap"><table class="gsc-ai-table">
      <thead><tr><th>Source</th><th>DR</th><th>Broken URL</th><th>Anchor</th></tr></thead>
      <tbody>${broken.slice(0, 50).map(b => `<tr>
        <td><a href="${escHtml(b.url_from??'')}" target="_blank" class="ah-link">${escHtml((b.domain_from??b.url_from??'').replace(/^https?:\/\//,'').split('/')[0])}</a></td>
        <td>${b.domain_rating_source ?? '—'}</td>
        <td class="ah-url ah-broken">${escHtml((b.url_to??'').replace(/^https?:\/\/[^/]+/,'').slice(0,50))}</td>
        <td>${escHtml(b.anchor ?? '—')}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : '<p class="ah-info" style="color:var(--success,#2d9e6b)">✓ No broken backlinks found.</p>';

  // Low-hanging keywords: positions 4–20 with decent volume = quick wins
  const quickWins = kws.filter(k => { const p = k.pos ?? k.position ?? 99; return p >= 4 && p <= 20 && (k.volume ?? 0) >= 100; });
  const quickWinsHtml = quickWins.length ? `
    <h4 class="indexy-h4" style="margin-top:24px">🚀 Quick Win Keywords — Positions 4–20 with Volume (${quickWins.length})</h4>
    <p class="ah-info">These keywords are close to page 1 or top-3. A content refresh or on-page optimization could move them up fast.</p>
    <div class="gsc-ai-table-wrap"><table class="gsc-ai-table">
      <thead><tr><th>Keyword</th><th>Position</th><th>Volume</th><th>Traffic</th><th>URL</th></tr></thead>
      <tbody>${quickWins.slice(0, 50).map(k => `<tr>
        <td class="ah-kw">${escHtml(k.keyword ?? '')}</td>
        <td><span class="ah-pos ${(k.pos??k.position??99)<=10?'ah-pos-p1':'ah-pos-p2'}">${k.pos ?? k.position}</span></td>
        <td>${(k.volume ?? 0).toLocaleString()}</td>
        <td>${(k.traffic ?? 0).toLocaleString()}</td>
        <td class="ah-url">${escHtml((k.url??'').replace(/^https?:\/\/[^/]+/,'').slice(0,40)||'/')}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : '';

  // Pages with traffic but few backlinks = link building targets
  const pages = data['top-pages']?.pages ?? [];
  const linkTargets = pages.filter(p => (p.traffic ?? 0) > 100 && (p.refdomains ?? 0) < 5);
  const linkTargetsHtml = linkTargets.length ? `
    <h4 class="indexy-h4" style="margin-top:24px">🎯 Link Building Targets — High Traffic, Low Links (${linkTargets.length})</h4>
    <p class="ah-info">These pages already get organic traffic but have few referring domains. Building links to them would amplify their performance.</p>
    <div class="gsc-ai-table-wrap"><table class="gsc-ai-table">
      <thead><tr><th>URL</th><th>Traffic</th><th>Ref Domains</th><th>Top Keyword</th></tr></thead>
      <tbody>${linkTargets.slice(0, 20).map(p => `<tr>
        <td class="ah-url"><a href="${escHtml(p.url??'')}" target="_blank" class="ah-link">${escHtml((p.url??'').replace(/^https?:\/\/[^/]+/,'').slice(0,50)||'/')}</a></td>
        <td>${(p.traffic ?? 0).toLocaleString()}</td>
        <td>${p.refdomains ?? 0}</td>
        <td class="ah-kw">${escHtml(p.top_keyword ?? '—')}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : '';

  panel.innerHTML = brokenHtml + quickWinsHtml + linkTargetsHtml ||
    '<div class="ah-empty">No opportunity data available. Pull data first.</div>';
}

async function ahrefsGenerateStrategy() {
  const btn    = document.getElementById('ah-strategy-btn');
  const result = document.getElementById('ah-strategy-result');
  const domain = ahrefsDomain || document.getElementById('ah-domain')?.value.trim();
  const data   = ahrefsCache[domain];
  if (!data) { result.innerHTML = '<div class="gsc-msg gsc-error">Pull Ahrefs data first.</div>'; return; }

  btn.disabled = true; btn.textContent = 'Generating…';
  result.innerHTML = '<div class="gsc-msg">Claude is analyzing your Ahrefs data…</div>';

  // Build a compact summary to stay within tokens
  const summary = {
    domain,
    domainRating: data['domain-rating']?.domain?.domain_rating,
    overview: data.overview?.metrics ?? data.overview,
    topRefdomains: (data.refdomains?.refdomains ?? []).slice(0, 20).map(r => ({ domain: r.refdomains ?? r.domain, dr: r.domain_rating, links: r.backlinks })),
    brokenBacklinks: (data['broken-backlinks']?.backlinks ?? []).slice(0, 30).map(b => ({ from: b.domain_from ?? b.url_from, dr: b.domain_rating_source, brokenUrl: b.url_to, anchor: b.anchor })),
    quickWinKeywords: (data['organic-keywords']?.keywords ?? []).filter(k => { const p = k.pos??k.position??99; return p>=4&&p<=20&&(k.volume??0)>=50; }).slice(0,30).map(k=>({ keyword:k.keyword, pos:k.pos??k.position, volume:k.volume, url:k.url })),
    topPages: (data['top-pages']?.pages ?? []).slice(0,20).map(p=>({ url:p.url, traffic:p.traffic, keywords:p.keywords, topKw:p.top_keyword })),
    pagesNeedingLinks: (data['top-pages']?.pages ?? []).filter(p=>(p.traffic??0)>100&&(p.refdomains??0)<5).slice(0,15).map(p=>({ url:p.url, traffic:p.traffic, refdomains:p.refdomains })),
  };

  try {
    const r = await fetch('/api/ahrefs/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain, data: summary }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    const text = d.content?.find(b => b.type === 'text')?.text || '';
    if (!text) throw new Error('No response from Claude');

    // Render markdown
    result.innerHTML = '<div class="gsc-ai-result">' + gscRenderMd(text) + '</div>';
  } catch (e) {
    result.innerHTML = `<div class="gsc-msg gsc-error">Error: ${escHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = '🤖 Generate AI Strategy';
  }
}

/* ═══════════════════════════════════════════════
   ARTICLE IMAGE
   Paste an article URL → read the page → write a visual brief from its content →
   generate images in a chosen style and aspect ratio. Session-only: nothing is
   persisted to the rank data or uploaded to GCS (that stays with the
   service-page modal, which is bound to a keyword record).
════════════════════════════════════════════════ */

/* Aspect ratios. OpenAI only accepts three sizes, so each ratio requests the
   nearest native one and is center-cropped on canvas afterwards. The crop ratio
   is set for every entry, including the "native" ones, because the model
   fallback chain can change the size out from under us (dall-e-3 remaps to
   1792×1024, dall-e-2 forces 1024×1024 — see tryModel). Cropping is skipped
   automatically when the returned image already matches. */
const AIG_RATIOS = {
  '16:9': { label: 'Wide 16:9',      size: '1536x1024', ratio: 16 / 9 },
  '3:2':  { label: 'Landscape 3:2',  size: '1536x1024', ratio: 3 / 2  },
  '4:3':  { label: 'Standard 4:3',   size: '1536x1024', ratio: 4 / 3  },
  '1:1':  { label: 'Square 1:1',     size: '1024x1024', ratio: 1      },
  '2:3':  { label: 'Portrait 2:3',   size: '1024x1536', ratio: 2 / 3  },
  '9:16': { label: 'Story 9:16',     size: '1024x1536', ratio: 9 / 16 },
};

const AIG_STYLE_GROUPS = {
  Photographic: {
    realistic: 'Realistic Photo', editorial: 'Editorial / Magazine', lifestyle: 'Lifestyle / Warm',
    clinical: 'Clinical / Professional', minimal: 'Minimalist / Clean', dramatic: 'Dramatic / Moody',
  },
  Illustrated: {
    vector: 'Flat Vector', render3d: '3D Render', watercolor: 'Watercolor',
    isometric: 'Isometric', lineart: 'Line Art',
  },
};

const AIG_JPEG_QUALITY = 0.9;
const AIG_MAX_IMAGES   = 4;

let aigState = { url: '', title: '', images: [] };

/* Center-crop a generated image to the requested ratio and encode it.
   Crop geometry is derived from the DECODED dimensions, never from the size we
   asked for, so it stays correct whichever model in the fallback chain answered. */
async function aigCropToRatio(dataUrl, targetRatio, format = 'jpg', quality = AIG_JPEG_QUALITY) {
  const img = await agLoadImage(dataUrl);
  const sw0 = img.naturalWidth  || img.width;
  const sh0 = img.naturalHeight || img.height;

  // Largest centred rectangle of the target ratio that fits inside the source.
  let sw = sw0, sh = Math.round(sw0 / targetRatio);
  if (sh > sh0) { sh = sh0; sw = Math.round(sh0 * targetRatio); }
  const sx = Math.round((sw0 - sw) / 2);
  const sy = Math.round((sh0 - sh) / 2);

  // Already the right shape and no re-encode needed — hand back the original.
  if (sw === sw0 && sh === sh0 && format === 'png') return { dataUrl, width: sw0, height: sh0 };

  const canvas = document.createElement('canvas');
  canvas.width = sw; canvas.height = sh;
  const ctx = canvas.getContext('2d');
  if (format === 'jpg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, sw, sh); } // flatten alpha
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return {
    dataUrl: canvas.toDataURL(format === 'jpg' ? 'image/jpeg' : 'image/png', quality),
    width: sw, height: sh,
  };
}

/* Small gpt-4o-mini call. Same key handling as agGenerateAltText: the server key
   when one is configured, otherwise the browser's own via x-client-key. */
async function aigChat(prompt, maxTokens) {
  const headers = { 'Content-Type': 'application/json' };
  if (!hasServerKey) {
    const k = apiKey || await Store.get('seomanager_api_key');
    if (!k) throw new Error('Enter your OpenAI API key in Settings first.');
    headers['x-client-key'] = k;
  }
  const res = await fetch('/api/openai/chat', {
    method: 'POST', headers,
    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.error?.message || `HTTP ${res.status}`);
  }
  return ((await res.json()).choices?.[0]?.message?.content || '').trim();
}

/* Best-effort article title: Jina Reader prefixes its output with "Title: …";
   otherwise fall back to the last URL path segment. */
function aigDeriveTitle(text, url) {
  const m = String(text || '').match(/^Title:\s*(.+)$/m);
  if (m) return m[1].trim().slice(0, 120);
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    const words = seg.replace(/\.\w+$/, '').replace(/[-_]+/g, ' ').trim();
    if (words) return words.charAt(0).toUpperCase() + words.slice(1);
  } catch (_) {}
  return 'article';
}

/* Fetch and extract the article body via /api/fetch-page (direct fetch, with a
   Jina Reader fallback for JS-rendered and bot-protected pages). */
async function aigReadArticle() {
  const url    = document.getElementById('aig-url').value.trim();
  const status = document.getElementById('aig-fetchStatus');
  const ta     = document.getElementById('aig-text');
  if (!/^https?:\/\//i.test(url)) { status.innerHTML = '<span style="color:var(--text-muted)">Enter a valid http(s) URL first.</span>'; return; }

  const btn = document.getElementById('aig-readBtn');
  btn.disabled = true; status.innerHTML = 'Reading the page…';
  try {
    const r = await fetch('/api/fetch-page', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
    });
    let d = {};
    try { d = await r.json(); } catch (_) {}
    if (r.ok && d.text) {
      ta.value = d.text;
      aigState.url = url;
      aigState.title = aigDeriveTitle(d.text, url);
      const via = d.source === 'jina' ? ' via Jina Reader' : '';
      status.innerHTML = `<span style="color:var(--green)">✓ ${d.words} words read${via}</span> — writing the visual brief…`;
      await aigWriteBrief();
    } else {
      const reason = typeof d.error === 'string' ? d.error : `HTTP ${r.status}`;
      agFetchShowManual(status, url, reason);
    }
  } catch (e) {
    agFetchShowManual(status, url, String(e.message || e));
  } finally {
    btn.disabled = false;
  }
}

/* Turn the article text into a short visual scene description — this is the step
   that makes the image about what the article is actually about. */
async function aigWriteBrief() {
  const text   = document.getElementById('aig-text').value.trim();
  const status = document.getElementById('aig-briefStatus');
  const out    = document.getElementById('aig-brief');
  const btn    = document.getElementById('aig-briefBtn');
  if (!text) { status.innerHTML = '<span style="color:var(--text-muted)">Read a URL or paste the article text first.</span>'; return; }

  if (!aigState.title) aigState.title = aigDeriveTitle(text, aigState.url || document.getElementById('aig-url').value.trim());

  btn.disabled = true; status.innerHTML = 'Writing the visual brief…';
  try {
    const brief = await aigChat(
      'Read this article and describe, in 2-3 sentences, ONE photograph or illustration that would sit at the top of it. '
      + 'Describe only what is visible: subject, setting, action, mood, lighting. '
      + 'No text, signage, logos, screens or UI in the frame. No preamble, no quotes — just the description.\n\n'
      + `Article:\n${text.slice(0, 4000)}`, 220);
    out.value = brief;
    status.innerHTML = '<span style="color:var(--green)">✓ Brief written from the article — edit it if you want.</span>';
  } catch (e) {
    // Still usable without a key: fall back to the title plus the opening lines.
    const opening = text.replace(/^Title:.*$/m, '').replace(/\s+/g, ' ').trim().slice(0, 220);
    out.value = `A scene illustrating "${aigState.title}". ${opening}`;
    status.innerHTML = `<span style="color:var(--text-muted)">⚠ Could not write the brief (${escHtml(e.message)}) — using the article's opening instead. Edit it below.</span>`;
  } finally {
    btn.disabled = false;
  }
}

/* Compose the final image prompt. Deliberately no SAFETY_PREFIX — that one is
   medical-specific (see agBuildImagePrompt). */
function aigBuildPrompt({ brief, style, extra, negative, framing }) {
  const stylePrompt = STYLE_MAP[style] || STYLE_MAP.realistic;
  let p = `${sanitizeTopic(String(brief || '').trim())} ${stylePrompt}.`;
  if (framing)                 p += ` ${framing}.`;
  if (extra && extra.trim())   p += ` ${extra.trim()}.`;
  if (negative && negative.trim()) p += ` Avoid: ${negative.trim()}.`;
  return p;
}

/* SEO alt text for the article's image. Mirrors agGenerateAltText's key handling
   but with article wording rather than service-page wording. */
async function aigGenerateAlt(brief) {
  const fallback = String(aigState.title || 'article image').slice(0, 125);
  try {
    const alt = await aigChat(
      `Write ONE alt-text line (max 125 characters) for the lead image on an article titled "${aigState.title}". `
      + 'Describe the scene plainly. No quotes, no "image of"/"photo of", no trailing period.\n\n'
      + `The image shows: ${String(brief).slice(0, 500)}`, 60);
    return alt.replace(/^["']|["']$/g, '').replace(/\.$/, '').slice(0, 125) || fallback;
  } catch (_) { return fallback; }
}

async function aigGenerate() {
  const brief    = document.getElementById('aig-brief').value.trim();
  const status   = document.getElementById('aig-genStatus');
  const gallery  = document.getElementById('aig-gallery');
  if (!brief) { status.innerHTML = '<span style="color:var(--text-muted)">Write or paste a visual brief first.</span>'; return; }

  let key;
  try { key = await getApiKey(); }
  catch (e) { status.innerHTML = `<span style="color:var(--red)">${escHtml(e.message)}</span>`; return; }

  const style    = document.getElementById('aig-style').value;
  const ratioKey = document.getElementById('aig-ratio').value;
  const format   = document.getElementById('aig-format').value;
  const extra    = document.getElementById('aig-extra').value;
  const negative = document.getElementById('aig-negative').value;
  const count    = Math.max(1, Math.min(AIG_MAX_IMAGES, parseInt(document.getElementById('aig-count').value) || 1));
  const cfg      = AIG_RATIOS[ratioKey] || AIG_RATIOS['16:9'];
  const ext      = format === 'jpg' ? 'jpg' : 'png';
  const base     = slugify(aigState.title || 'article-image').slice(0, 60) || 'article-image';

  const btn = document.getElementById('aig-genBtn');
  btn.disabled = true; btn.textContent = 'Generating…';
  document.getElementById('aig-downloadAllBtn').classList.add('hidden');
  aigState.images = [];
  gallery.innerHTML = '';
  status.textContent = `Generating ${count} image${count > 1 ? 's' : ''} at ${cfg.label}…`;

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

  const tasks = cards.map((card, i) => async () => {
    // Vary the camera angle across a batch so the results aren't near-duplicates.
    const framing = count > 1 ? `Framing: ${FRAMING_VARIATIONS[i % FRAMING_VARIATIONS.length]}` : '';
    const prompt  = aigBuildPrompt({ brief, style, extra, negative, framing });
    const imgDiv  = card.querySelector('.ig-card-img');
    const actions = card.querySelector('.ig-card-actions');
    try {
      const raw = await generateImage(key, prompt, cfg.size);
      const out = await aigCropToRatio(raw, cfg.ratio, ext);
      const filename = `${base}${count > 1 ? `-${i + 1}` : ''}.${ext}`;
      aigState.images[i] = { ...out, prompt, filename };

      imgDiv.innerHTML = `<img src="${out.dataUrl}" alt="Image ${i + 1}" loading="lazy" />`;
      card.querySelector('.ig-card-num').textContent = `${out.width}×${out.height} · ${ext.toUpperCase()}`;
      actions.innerHTML = `
        <button class="btn-sm btn-copy-prompt">Copy Prompt</button>
        <button class="btn-sm btn-download">Download</button>`;
      actions.querySelector('.btn-copy-prompt').addEventListener('click', (ev) => copyText(ev.currentTarget, prompt));
      actions.querySelector('.btn-download').addEventListener('click', () => downloadDataUrl(out.dataUrl, filename));
    } catch (e) {
      imgDiv.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'img-error';
      err.textContent = `⚠ ${e.message}`;
      imgDiv.appendChild(err);
    }
  });

  await runConcurrent(tasks, 3);

  const made = aigState.images.filter(Boolean).length;
  if (made) {
    document.getElementById('aig-downloadAllBtn').classList.remove('hidden');
    document.getElementById('aig-altCard').classList.remove('hidden');
    const altEl = document.getElementById('aig-alt');
    if (!altEl.value.trim()) {
      status.textContent = 'Writing SEO alt text…';
      altEl.value = await aigGenerateAlt(brief);
    }
    status.innerHTML = `<span style="color:var(--green)">✓ ${made} of ${count} generated.</span>`;
  } else {
    status.innerHTML = '<span style="color:var(--red)">No images were generated — see the errors above.</span>';
  }
  btn.disabled = false; btn.textContent = 'Generate images';
}

async function aigDownloadAll() {
  for (const img of aigState.images) {
    if (!img) continue;
    downloadDataUrl(img.dataUrl, img.filename);
    await new Promise(r => setTimeout(r, 300));
  }
}

function aigRender() {
  const root = document.getElementById('aig-root');
  if (!root || root.dataset.ready) return;   // keep results when switching tabs
  root.dataset.ready = '1';

  const styleOpts = Object.entries(AIG_STYLE_GROUPS).map(([group, opts]) =>
    `<optgroup label="${group}">` +
    Object.entries(opts).map(([v, l]) => `<option value="${v}">${l}</option>`).join('') +
    '</optgroup>').join('');
  const ratioOpts = Object.entries(AIG_RATIOS)
    .map(([k, c]) => `<option value="${k}">${c.label}</option>`).join('');

  root.innerHTML = `
    <div class="db-header">
      <h2 class="db-title">Article Image</h2>
      <p class="db-sub">Paste an article URL — the page is read, turned into a visual brief, and rendered as images in the style and aspect ratio you choose.</p>
    </div>

    <div class="form-card">
      <div class="form-group">
        <label class="form-label">Article URL</label>
        <div class="aig-row">
          <input type="url" id="aig-url" class="form-input" placeholder="https://example.com/blog/some-article" />
          <button class="btn btn-secondary" id="aig-readBtn">Read article</button>
        </div>
        <div class="aig-status" id="aig-fetchStatus"></div>
      </div>

      <div class="form-group">
        <label class="form-label">Article content <span class="aig-hint">auto-filled — or paste it yourself if the site blocks fetching</span></label>
        <textarea id="aig-text" class="form-textarea" rows="4" placeholder="The article body appears here once the URL is read."></textarea>
      </div>

      <div class="form-group">
        <label class="form-label">Visual brief <span class="aig-hint">what the image should show, written from the article — edit freely</span></label>
        <textarea id="aig-brief" class="form-textarea" rows="3" placeholder="Read a URL above, or describe the shot yourself."></textarea>
        <div class="aig-row" style="margin-top:8px">
          <button class="btn-sm" id="aig-briefBtn">Rewrite brief from article</button>
          <div class="aig-status" id="aig-briefStatus" style="margin:0"></div>
        </div>
      </div>

      <div class="aig-controls-row">
        <div class="form-group">
          <label class="form-label">Visual Style</label>
          <select id="aig-style" class="form-select">${styleOpts}</select>
        </div>
        <div class="form-group">
          <label class="form-label">Aspect Ratio</label>
          <select id="aig-ratio" class="form-select">${ratioOpts}</select>
        </div>
        <div class="form-group">
          <label class="form-label">Images</label>
          <input type="number" id="aig-count" class="form-input" min="1" max="${AIG_MAX_IMAGES}" value="1" />
        </div>
        <div class="form-group">
          <label class="form-label">Format</label>
          <select id="aig-format" class="form-select">
            <option value="jpg">JPG</option>
            <option value="png">PNG</option>
          </select>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Extra direction <span class="aig-hint">optional</span></label>
        <input type="text" id="aig-extra" class="form-input" placeholder="e.g. cool blue palette, shot from a low angle" />
      </div>

      <div class="form-group">
        <label class="form-label">Avoid</label>
        <textarea id="aig-negative" class="form-textarea" rows="2">${escHtml(IMG_DEFAULT_NEGATIVE)}</textarea>
      </div>

      <div class="form-actions">
        <button class="btn btn-primary" id="aig-genBtn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          Generate images
        </button>
        <button class="btn btn-secondary hidden" id="aig-downloadAllBtn">Download all</button>
        <div class="aig-status" id="aig-genStatus" style="margin:0"></div>
      </div>
    </div>

    <div class="form-card hidden" id="aig-altCard">
      <div class="form-group" style="margin:0">
        <label class="form-label">SEO alt text</label>
        <div class="aig-row">
          <input type="text" id="aig-alt" class="form-input" maxlength="125" />
          <button class="btn btn-secondary" id="aig-copyAltBtn">Copy</button>
        </div>
      </div>
    </div>

    <div class="ig-gallery" id="aig-gallery"></div>`;

  document.getElementById('aig-readBtn').addEventListener('click', aigReadArticle);
  document.getElementById('aig-url').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); aigReadArticle(); } });
  document.getElementById('aig-briefBtn').addEventListener('click', aigWriteBrief);
  document.getElementById('aig-genBtn').addEventListener('click', aigGenerate);
  document.getElementById('aig-downloadAllBtn').addEventListener('click', aigDownloadAll);
  document.getElementById('aig-copyAltBtn').addEventListener('click', (e) =>
    copyText(e.currentTarget, document.getElementById('aig-alt').value));
}

/* ── START ── */
init();
