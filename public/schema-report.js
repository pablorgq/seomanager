/* ═══════════════════════════════════════════════════════════════════════════
   LLAMASEO — schema report collector

   Paste this into the browser console ON THE CLIENT'S SITE, then upload the
   file it downloads into the Schema tab.

   Why this exists: some hosts (SiteGround's Anti-Bot AI, Sucuri, Cloudflare)
   serve a robot challenge to servers while letting real browsers straight
   through. Your browser has already passed that check, so it can read pages the
   scanner cannot. Requests are same-origin, so there is no CORS problem either.

   It reads nothing but public page markup, changes nothing, and sends nothing
   anywhere — the report is a file saved to your computer.
   ═══════════════════════════════════════════════════════════════════════════ */
(async () => {
  const ORIGIN = location.origin;
  const log = (...a) => console.log('%c[llamaseo]', 'color:#4361EE;font-weight:bold', ...a);

  const CONCURRENCY = 2;      // polite: the point is to look like browsing, not scraping
  const DELAY_MS    = 250;
  const MAX_PAGES   = 500;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* Same markers the server uses. A challenge is not a page, and counting it as
     one would report a marked-up site as having no structured data. */
  const isChallenge = (html) => {
    const head = html.slice(0, 4000);
    if (/sgcaptcha|cloudproxy|sucuri\.net/i.test(head)) return true;
    if (/cf-chl|challenge-platform|__cf_chl|cdn-cgi\/challenge/i.test(head)) return true;
    if (/_incap_|distil_r_|incapsula/i.test(head)) return true;
    const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || '';
    const text = body.replace(/<[^>]+>/g, ' ').trim();
    return /<meta[^>]+http-equiv=["']?refresh/i.test(head) && text.length < 40;
  };

  /* ── 1. find the site's pages ── */
  async function sitemapUrls() {
    const seen = new Set();
    const out  = [];
    const queue = [];

    try {
      const rb = await fetch(`${ORIGIN}/robots.txt`, { credentials: 'include' });
      if (rb.ok) for (const m of (await rb.text()).matchAll(/^\s*sitemap:\s*(\S+)/gim)) queue.push(m[1].trim());
    } catch {}
    queue.push(`${ORIGIN}/sitemap_index.xml`, `${ORIGIN}/sitemap.xml`, `${ORIGIN}/wp-sitemap.xml`);

    let indexes = 0;
    while (queue.length && out.length < MAX_PAGES) {
      const sm = queue.shift();
      if (seen.has(sm)) continue;
      seen.add(sm);
      let xml;
      try {
        const r = await fetch(sm, { credentials: 'include' });
        if (!r.ok) continue;
        xml = await r.text();
      } catch { continue; }
      if (isChallenge(xml)) continue;

      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(x => x[1]);
      if (!locs.length) continue;
      if (/<sitemapindex/i.test(xml)) {
        if (++indexes > 4) continue;
        locs.slice(0, 25).forEach(l => { if (!seen.has(l)) queue.push(l); });
      } else {
        for (const l of locs) {
          if (out.length >= MAX_PAGES) break;
          if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|xml|kml|txt|json|css|js)$/i.test(l)) continue;
          try { if (new URL(l).hostname.replace(/^www\./, '') !== location.hostname.replace(/^www\./, '')) continue; } catch { continue; }
          if (!out.includes(l)) out.push(l);
        }
      }
    }
    return out;
  }

  /* ── 2. reduce a page to what the audit needs ──
     The full page is ~100KB, almost all of it CSS and scripts. Keep the head's
     JSON-LD and meta, the h1, and a slice of visible text for the signals that
     decide which schema types a page owes. ~8KB instead of ~100KB. */
  function reduce(html) {
    const head = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] || '';
    const keep = [];

    // Scan the whole document, not just the head: WooCommerce emits Product
    // schema on wp_footer and tag managers inject blocks into the body, and
    // dropping those would import a marked-up page as having none.
    for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi)) keep.push(m[0]);
    for (const rx of [
      /<title[^>]*>[\s\S]*?<\/title>/i,
      /<meta[^>]+name=["']description["'][^>]*>/i,
      /<link[^>]+rel=["']canonical["'][^>]*>/i,
      /<meta[^>]+property=["']og:type["'][^>]*>/i,
    ]) { const m = (head || html).match(rx); if (m) keep.push(m[0]); }

    const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || html;
    const h1   = body.match(/<h1[^>]*>[\s\S]*?<\/h1>/i)?.[0] || '';
    // Headings carry the FAQ and HowTo signals, so keep them as markup
    const heads = [...body.matchAll(/<h[2-4][^>]*>[\s\S]{0,200}?<\/h[2-4]>/gi)].slice(0, 40).map(m => m[0]).join('\n');
    const addr  = body.match(/<address[^>]*>[\s\S]{0,300}?<\/address>/i)?.[0] || '';
    const time  = body.match(/<time[^>]+datetime=["'][^"']+["'][^>]*>[\s\S]{0,80}?<\/time>/i)?.[0] || '';
    const auth  = body.match(/<[^>]+class=["'][^"']*author[^"']*["'][^>]*>[\s\S]{0,80}?<\/[a-z]+>/i)?.[0] || '';
    // These signals live in attributes, which the text pass below strips — keep
    // the tags themselves or the audit sees no phone and never a breadcrumb.
    const tel   = [...body.matchAll(/<a[^>]+href=["']tel:[^"']+["'][^>]*>[\s\S]{0,60}?<\/a>/gi)].slice(0, 3).map(m => m[0]).join('\n');
    const crumb = body.match(/<[a-z]+[^>]+(?:class=["'][^"']*breadcrumb|aria-label=["']breadcrumb)[^>]*>/i)?.[0] || '';
    const text  = body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 6000);

    return `<html><head>${keep.join('\n')}</head><body>${h1}\n${heads}\n${crumb}\n${addr}\n${tel}\n${time}\n${auth}\n<p>${text}</p></body></html>`;
  }

  /* ── 3. collect ── */
  async function fetchPage(url) {
    let sawChallenge = false;
    let lastStatus = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await sleep(900 * (attempt - 1));
      try {
        const r = await fetch(url, { credentials: 'include' });
        // A 404 from a stale sitemap entry is not bot protection, and retrying
        // it wastes seconds before giving advice that cannot help.
        if (r.status >= 400 && r.status < 500) return { url, failed: `http_${r.status}` };
        if (!r.ok) { lastStatus = `http_${r.status}`; continue; }
        const html = await r.text();
        // The browser will not run a challenge's proof-of-work inside fetch(),
        // but the clearance it already holds usually gets the retry through.
        if (isChallenge(html)) { sawChallenge = true; continue; }
        return { url, html: reduce(html) };
      } catch (e) { lastStatus = e.message; }
    }
    return sawChallenge ? { url, blocked: true } : { url, failed: lastStatus || 'unreachable' };
  }

  log('Finding pages…');
  let urls = await sitemapUrls();
  if (!urls.length) {
    log('No sitemap found — falling back to links on this page.');
    urls = [...new Set([...document.querySelectorAll('a[href]')]
      .map(a => a.href.split('#')[0])
      .filter(h => { try { return new URL(h).hostname === location.hostname && !/\.(jpg|jpeg|png|gif|webp|svg|pdf)$/i.test(h); } catch { return false; } })
    )].slice(0, MAX_PAGES);
  }
  // Seed the homepage before capping, or a full run ends up one over the limit
  if (!urls.includes(location.origin + '/')) urls.unshift(location.origin + '/');
  urls = urls.slice(0, MAX_PAGES);
  log(`${urls.length} page(s) to read.`);

  const pages = [];
  let blocked = 0, failed = 0, done = 0;
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const got = await Promise.all(batch.map(fetchPage));
    for (const g of got) {
      done++;
      if (g.blocked) { blocked++; continue; }
      if (g.failed)  { failed++; console.warn('[llamaseo] skipped', g.url, g.failed); continue; }
      pages.push(g);
    }
    log(`${done}/${urls.length}${blocked ? ` (${blocked} blocked)` : ''}${failed ? ` (${failed} unreachable)` : ''}`);
    await sleep(DELAY_MS);
  }

  const report = {
    llamaseoSchemaReport: 1,
    domain: location.hostname,
    generatedAt: new Date().toISOString(),
    pages,
    blocked,
    failed,
  };

  const name = `schema-report-${location.hostname.replace(/^www\./, '')}.json`;
  const blob = new Blob([JSON.stringify(report)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);

  log(`Done — ${pages.length} page(s) collected${blocked ? `, ${blocked} blocked` : ''}.`);
  log(`Saved ${name} (${Math.round(blob.size / 1024)} KB). Upload it in the Schema tab.`);
  if (blocked) log('%cSome pages were blocked even in the browser — reload the site once and run this again.', 'color:#b45309');
})();
