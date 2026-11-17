(() => {
  // connect relative to where client.js was served from, so it also works under a sub-path proxy
  const socket = io({ path: new URL('socket.io', document.currentScript.src).pathname });
  const pad = document.getElementById('pad');
  const users = document.getElementById('users');
  const sync = document.getElementById('sync');
  const fileList = document.getElementById('file-list');

  const room = pad ? pad.dataset.room : null;
  let applyingRemote = false;
  let lastAppliedVersion = 0;
  let pendingTimer = null;

  function setSync(state) {
    if (!sync) return;
    sync.classList.remove('ok', 'busy');
    if (state === 'busy') {
      sync.textContent = 'Syncing…';
      sync.classList.add('busy');
    } else {
      sync.textContent = 'Synced';
      sync.classList.add('ok');
    }
  }

  if (room) {
    socket.emit('join', { room });
  }

  socket.on('init', ({ text, version }) => {
    if (!pad) return;
    applyingRemote = true;
    pad.value = text || '';
    applyingRemote = false;
    lastAppliedVersion = version || 0;
    setSync('ok');
  });

  socket.on('user-count', (n) => {
    if (users) users.textContent = `${n} online`;
  });

  // Apply remote text changes only (we no longer echo to self)
  socket.on('text-apply', ({ text, version }) => {
    if (!pad || typeof text !== 'string') return;
    if (!version || version <= lastAppliedVersion) return;
    const start = pad.selectionStart, end = pad.selectionEnd;
    applyingRemote = true;
    pad.value = text;
    applyingRemote = false;
    lastAppliedVersion = version;
    try {
      const len = pad.value.length;
      pad.selectionStart = Math.min(start, len);
      pad.selectionEnd = Math.min(end, len);
    } catch {}
    setSync('ok');
  });

  // Sender-only ack
  socket.on('ack', ({ version }) => {
    if (typeof version === 'number') {
      lastAppliedVersion = Math.max(lastAppliedVersion, version);
    }
    setSync('ok');
  });

  function sendUpdate() {
    if (!pad || applyingRemote) return;
    setSync('busy');
    socket.emit('text-update', { room, text: pad.value });
  }

  if (pad) {
    // Slightly longer debounce to reduce churn and avoid races
    pad.addEventListener('input', () => {
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(sendUpdate, 150);
    });
  }

  // ---- Realtime file list ----

  async function refreshFiles() {
    if (!fileList || !room) return;
    try {
      const res = await fetch(`/pad/${room}/files.json`, { cache: 'no-store' });
      const data = await res.json();
      const files = Array.isArray(data.files) ? data.files : [];
      if (files.length === 0) {
        fileList.innerHTML = '<li style="color:#9ca3af">No files uploaded yet.</li>';
        return;
      }
      const items = files.map(f => {
        const ef = encodeURIComponent(f);
        const sf = String(f).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        return `
          <li>
            <a href="/pad/${room}/files/${ef}">${sf}</a> ·
            <form style="display:inline" method="post" action="/pad/${room}/files/${ef}/delete">
              <button type="submit" onclick="return confirm('Delete this file?')">Delete</button>
            </form>
          </li>`;
      }).join('');
      fileList.innerHTML = items;
    } catch {
      // ignore fetch errors; list will refresh next change or page reload
    }
  }

  socket.on('files-changed', () => {
    refreshFiles();
  });

  // Optional: Esc to go home
  if (pad) {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') window.location.href = '/';
    });
  }
})();
