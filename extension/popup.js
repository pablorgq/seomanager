const $ = id => document.getElementById(id);

/* Every send is wrapped: a rejected message port (the service worker being torn
   down) would otherwise leave the popup stuck on "Loading…" or "Collecting…"
   with nothing said. */
async function send(msg) {
  try {
    const res = await chrome.runtime.sendMessage(msg);
    return res || { ok: false, error: 'No response from the extension — try again.' };
  } catch (e) {
    return { ok: false, error: e?.message || 'The extension went away — try again.' };
  }
}

/* Same www-insensitive comparison the app uses (bareHost / ahrefsBareHost), so
   a client saved as www.example.com still matches a tab on example.com. */
const bareHost = (urlOrHost) => {
  const s = String(urlOrHost || '').trim();
  if (!s) return '';
  try { return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return s.toLowerCase().replace(/^www\./, ''); }
};

function setStatus(text, cls = 'muted') {
  $('status').textContent = text;
  $('status').className = cls;
}

function showResult(r) {
  if (!r) return;
  if (!r.ok) return setStatus(r.error || 'Something went wrong.', 'err');
  const notes = [];
  if (r.blocked) notes.push(`${r.blocked} blocked`);
  if (r.failed)  notes.push(`${r.failed} unreachable`);
  if (r.skipped) notes.push(`${r.skipped} malformed`);
  setStatus(
    `Sent ${r.pages} page(s) to ${r.client}.` +
    (notes.length ? `\n${notes.join(', ')}.` : '') +
    '\nOpen the Schema tab in LLAMASEO to see them.',
    notes.length ? 'muted' : 'ok',
  );
}

function busy(on) {
  $('go').disabled = on || !$('client').value;
  $('go').textContent = on ? 'Collecting…' : 'Collect this site';
}

(async () => {
  chrome.runtime.sendMessage({ type: 'clearBadge' }).catch(() => {});

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabHost = bareHost(tab?.url || '');
  $('host').textContent = tabHost || 'No site open in this tab';

  // A crawl started earlier may still be running, or have finished while closed
  const { pending, lastResult } = await chrome.storage.local.get(['pending', 'lastResult']);

  const res = await send({ type: 'clients' });
  if (!res.ok) {
    $('client').innerHTML = '<option>—</option>';
    setStatus(res.error, 'err');
    const a = document.createElement('a');
    a.href = '#'; a.textContent = 'Open options';
    a.onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
    $('status').append(' ', a);
    return;
  }

  const clients = res.clients || [];
  if (!clients.length) {
    $('client').innerHTML = '<option>No clients in LLAMASEO</option>';
    setStatus('Add a client in LLAMASEO first.', 'err');
    return;
  }

  const match = clients.find(c => c.wpUrl && bareHost(c.wpUrl) === tabHost);
  const opts = clients.map(c => `<option value="${c.id}"${c.id === match?.id ? ' selected' : ''}>${c.name.replace(/</g, '&lt;')}</option>`);
  // With no match, force an explicit choice. Defaulting to whichever client
  // happens to be first is how you replace the wrong client's pages in one
  // click and lose its recommendations.
  if (!match) opts.unshift('<option value="" selected>— choose a client —</option>');
  $('client').innerHTML = opts.join('');

  const { appUrl = '' } = await chrome.storage.local.get('appUrl');
  const appHost = bareHost(appUrl);

  /* What the collector reads is whatever tab is open, not whatever client is
     selected in the dropdown — so the tab is the thing that has to be checked.
     Without this, standing on LLAMASEO and clicking Collect audits LLAMASEO and
     files its own pages under a client. */
  function tabCheck() {
    if (!/^https?:/i.test(tab?.url || '')) return { ok: false, msg: 'Open the client\'s website in this tab first.' };
    if (appHost && tabHost === appHost) {
      return { ok: false, msg: 'This tab is LLAMASEO itself. Open the client\'s website in a tab and click Collect from there.' };
    }
    const id = $('client').value;
    if (!id) return { ok: false, msg: 'Choose which client this is for.' };
    const chosen = clients.find(c => c.id === id);
    const want = bareHost(chosen?.wpUrl || '');
    if (want && want !== tabHost) {
      return { ok: false, msg: `This tab is ${tabHost}, but ${chosen.name} is ${want}. Open that client's site, or pick the client this tab belongs to.` };
    }
    if (!want) return { ok: true, msg: `${chosen.name} has no site URL set, so this cannot be checked — make sure ${tabHost} is theirs.`, tone: 'muted' };
    return { ok: true, msg: '' };
  }

  function applyCheck() {
    const c = tabCheck();
    $('go').disabled = !c.ok;
    if (c.msg) setStatus(c.msg, c.ok ? (c.tone || 'muted') : 'err');
    return c;
  }

  busy(false);
  const first = applyCheck();
  $('client').onchange = applyCheck;

  if (pending) { busy(true); setStatus('A collection is already running in this tab. Leave it open.', 'muted'); }
  else if (first.ok && !first.msg && lastResult && Date.now() - lastResult.at < 5 * 60 * 1000) showResult(lastResult);

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'finished') { busy(false); showResult(msg.result); }
  });

  $('go').onclick = async () => {
    // Re-check at click time: the tab can navigate while the popup sits open
    const c = tabCheck();
    if (!c.ok) { setStatus(c.msg, 'err'); return; }

    busy(true);
    setStatus('Reading the sitemap and every page. Keep this tab open — you can close this popup.', 'muted');
    const started = await send({ type: 'collect', clientId: $('client').value });
    if (!started.ok) { busy(false); setStatus(started.error, 'err'); }
  };
})();
