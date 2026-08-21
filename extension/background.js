/* Service worker: injects the collector into the active tab, then posts what it
   returns to LLAMASEO.

   The split matters. Collection has to happen in the page so the fetches are
   same-origin and carry the site's cookies — that clearance is what gets past
   host-level bot protection. Sending has to happen here, because an extension
   worker bypasses CORS for hosts it holds permission for, while a page-context
   fetch to the app would be blocked outright (the app sets no CORS headers).

   The page reports back by message rather than the worker awaiting the crawl.
   An MV3 worker is not guaranteed to survive minutes of waiting, and a
   termination mid-crawl would bin the whole thing; an inbound message wakes it
   instead. The pending target is kept in storage for the same reason. */

async function settings() {
  const { appUrl = '', token = '' } = await chrome.storage.local.get(['appUrl', 'token']);
  return { appUrl: appUrl.replace(/\/+$/, ''), token };
}

async function api(path, init = {}) {
  const { appUrl, token } = await settings();
  if (!appUrl || !token) throw new Error('Not connected yet — open the extension options and set the LLAMASEO URL and pairing token.');

  let r;
  try {
    r = await fetch(appUrl + path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
  } catch {
    // A wrong host, a dead deployment and a missing permission all land here
    throw new Error(`Could not reach ${appUrl}. Check the URL in options, and that you granted access to it.`);
  }

  if (r.status === 401) throw new Error('LLAMASEO rejected the pairing token. Generate a new one in Settings and paste it into options.');
  // The reachable-but-wrong-site case. Pointing this at the client's website
  // rather than the LLAMASEO install is the obvious mistake to make, and a bare
  // "returned 404" gives no hint which of the two fields is wrong.
  if (r.status === 404) throw new Error(`${appUrl} answered, but it is not a LLAMASEO install — there is no extension API there. This field wants the address you open LLAMASEO at, not the client's website.`);
  if (r.status === 413) throw new Error('That site produced a report too large to send. Collect fewer pages.');
  if (r.status === 429) throw new Error('LLAMASEO is rate limiting — wait a moment and try again.');

  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.error?.message || `LLAMASEO returned ${r.status}.`);
  return body;
}

/* The popup may well be closed by the time a crawl finishes, so the outcome is
   stored and badged rather than only returned. */
async function finish(result) {
  await chrome.storage.local.set({ lastResult: { ...result, at: Date.now() } });
  await chrome.storage.local.remove('pending');
  chrome.action.setBadgeText({ text: result.ok ? '✓' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: result.ok ? '#197a4b' : '#d33' });
  chrome.runtime.sendMessage({ type: 'finished', result }).catch(() => {});   // popup may be gone
}

async function startCollect(clientId) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab.');
  if (!/^https?:/i.test(tab.url || '')) throw new Error('Open the client\'s website in this tab first.');

  await chrome.storage.local.set({ pending: { clientId, startedAt: Date.now() } });
  chrome.action.setBadgeText({ text: '…' });
  chrome.action.setBadgeBackgroundColor({ color: '#4361EE' });

  // Two steps on purpose: the file defines the function, the second call runs
  // it. Same isolated world, so the definition is still there. The runner does
  // not await the crawl here — it messages the result back when done.
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['collector.js'] });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      window.__llamaseoCollectSchema({ download: false })
        .then(report => chrome.runtime.sendMessage({ type: 'report', report }))
        .catch(e => chrome.runtime.sendMessage({ type: 'report', error: e.message }));
    },
  });
}

async function receiveReport(msg) {
  const { pending } = await chrome.storage.local.get('pending');
  if (!pending?.clientId) return finish({ ok: false, error: 'Lost track of which client this was for — try again.' });

  if (msg.error) return finish({ ok: false, error: msg.error });
  const report = msg.report;
  if (!report || !Array.isArray(report.pages)) {
    return finish({ ok: false, error: 'The collector returned nothing — reload the page and try again.' });
  }
  if (!report.pages.length) {
    return finish({ ok: false, error: report.blocked
      ? 'Every page was blocked by the site\'s bot protection, even in the browser. Reload the site once and try again.'
      : 'No readable pages were found on this site.' });
  }

  try {
    const out = await api('/api/ext/schema/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: pending.clientId, report }),
    });
    await finish({ ok: true, ...out, blocked: report.blocked, failed: report.failed });
  } catch (e) {
    await finish({ ok: false, error: e.message });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'clients')  return sendResponse({ ok: true, ...(await api('/api/ext/clients')) });
      if (msg.type === 'collect')  { await startCollect(msg.clientId); return sendResponse({ ok: true, started: true }); }
      if (msg.type === 'report')   { receiveReport(msg); return sendResponse({ ok: true }); }
      if (msg.type === 'clearBadge') { chrome.action.setBadgeText({ text: '' }); return sendResponse({ ok: true }); }
      sendResponse({ ok: false, error: `Unknown request: ${msg.type}` });
    } catch (e) {
      if (msg.type === 'collect') await finish({ ok: false, error: e.message });
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;     // keeps the message channel open for the async reply
});
