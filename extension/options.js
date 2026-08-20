const $ = id => document.getElementById(id);

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = cls;
}

chrome.storage.local.get(['appUrl', 'token']).then(({ appUrl = '', token = '' }) => {
  $('appUrl').value = appUrl;
  $('token').value = token;
});

$('save').onclick = async () => {
  const appUrl = $('appUrl').value.trim().replace(/\/+$/, '');
  const token  = $('token').value.trim();

  if (!/^https?:\/\/[^/]+$/i.test(appUrl)) {
    return setStatus('That does not look like a URL — for example https://seomanager.example.com', 'err');
  }
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return setStatus('The pairing token should be 64 hex characters. Copy it again from LLAMASEO.', 'err');
  }

  // The install's address is not known until now, so the host permission cannot
  // be declared in the manifest — ask for it here, narrowed to this one origin
  // rather than the whole-web wildcard the manifest lists as available.
  const origin = `${new URL(appUrl).origin}/*`;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) return setStatus(`Access to ${origin} was declined — the extension cannot reach LLAMASEO without it.`, 'err');

  await chrome.storage.local.set({ appUrl, token });
  setStatus('Saved. Testing…');

  const res = await chrome.runtime.sendMessage({ type: 'clients' });
  if (!res?.ok) return setStatus(res?.error || 'Could not reach LLAMASEO.', 'err');
  const n = (res.clients || []).length;
  setStatus(`Connected. ${n} client${n === 1 ? '' : 's'} found.`, 'ok');
};

$('clear').onclick = async () => {
  await chrome.storage.local.remove(['appUrl', 'token']);
  $('appUrl').value = '';
  $('token').value = '';
  setStatus('Cleared.');
};
