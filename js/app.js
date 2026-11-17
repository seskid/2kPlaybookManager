(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const hex = (v, w) => '0x' + v.toString(16).toUpperCase().padStart(w || 0, '0');
  const readBytes = file => file.arrayBuffer().then(b => new Uint8Array(b));

  // ------------------------------------------------------------ tabs
  function showTab(name) {
    document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    document.querySelectorAll('main > section').forEach(s => s.classList.toggle('hidden', s.id !== 'tab-' + name));
  }
  document.querySelectorAll('.tabs button').forEach(btn => btn.addEventListener('click', () => showTab(btn.dataset.tab)));

  // ------------------------------------------------------------ file gathering
  // Returns [{ file, path }] for a drop, walking dropped folders recursively.
  async function filesFromDrop(dataTransfer) {
    const entries = [...dataTransfer.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) return [...dataTransfer.files].map(file => ({ file, path: file.name }));
    const out = [];
    async function walk(entry, prefix) {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ file, path: prefix + entry.name });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const e of batch) await walk(e, prefix + entry.name + '/');
        } while (batch.length);
      }
    }
    for (const e of entries) await walk(e, '');
    return out;
  }

  function wireDrop(el, onFiles) {
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', async e => {
      e.preventDefault();
      el.classList.remove('over');
      onFiles(await filesFromDrop(e.dataTransfer));
    });
  }

  // A file dropped outside a drop zone would otherwise replace the page.
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => e.preventDefault());

  // Set by electron/preload.js when running as the desktop app; undefined in a browser.
  const desktop = window.porter && window.porter.isDesktop ? window.porter : null;

  function download(name, bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Status line under the book list. `revealPath` adds a "Show in folder" button (desktop only).
  function setStatus(message, revealPath) {
    const el = $('#status');
    el.hidden = !message;
    el.innerHTML = esc(message || '') + (revealPath && desktop ? ' <button class="btn" id="reveal">Show in folder</button>' : '');
    if (revealPath && desktop) $('#reveal').addEventListener('click', () => desktop.showInFolder(revealPath));
  }

  async function saveOne(out) {
    if (!desktop) { download(out.fileName, out.bytes); return; }
    const saved = await desktop.saveFile(out.fileName, out.bytes);
    if (saved) setStatus(`Saved ${saved}`, saved);
  }

  // Shared with js/editor-ui.js.
  window.PorterShared = { esc, readBytes, filesFromDrop, wireDrop, download, desktop, showTab };

  // ------------------------------------------------------------ convert tab
  let books = [];

  // Groups files by folder; a folder (or loose file) with a 78,736-byte SAVEGAME.DAT is one book.
  // Other Xbox saves (rosters, franchises, settings) are skipped and counted.
  async function addXboxFiles(items) {
    let added = 0, skipped = 0;
    const groups = new Map();
    for (const { file, path } of items) {
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push({ file, path });
    }
    for (const [dir, files] of groups) {
      const byName = name => files.find(f => f.file.name.toLowerCase() === name.toLowerCase());
      const datItems = files.filter(f => f.file.size === Playbook.SIZE);
      const metaItem = byName('SaveMeta.xbx');
      const saveMeta = metaItem ? await readBytes(metaItem.file) : null;
      const meta = saveMeta ? Saves.parseSaveMeta(saveMeta) : '';
      for (const dat of datItems) {
        const body = await readBytes(dat.file);
        const info = Playbook.inspect(body);
        const code = Saves.sanitizeCode(meta) || Saves.sanitizeCode(info.bookName);
        if (books.some(b => b.path === dat.path)) continue;
        books.push({ path: dat.path, folder: dir, metaName: meta, saveMeta, body, info, code });
        added++;
      }
      if (!datItems.length && byName('SAVEGAME.DAT')) skipped++;
    }
    renderBooks();
    const skippedNote = skipped ? ` Skipped ${skipped} other save${skipped === 1 ? '' : 's'} (rosters, franchises, settings).` : '';
    setStatus(added || skipped ? `Loaded ${added} playbook${added === 1 ? '' : 's'}.${skippedNote}` : 'No Xbox playbook saves found.');
  }

  function format() { return document.querySelector('input[name=format]:checked').value; }

  function renderBooks() {
    const list = $('#books');
    $('#clear-books').disabled = !books.length;
    $('#download-all').disabled = !books.some(b => b.info.ok);
    if (!books.length) { list.innerHTML = '<div class="empty">No Xbox playbooks loaded yet.</div>'; return; }
    list.innerHTML = books.map((b, i) => {
      const c = b.info.counts;
      let badge;
      if (!b.info.ok) badge = '<span class="badge bad">Not a playbook</span>';
      else if (b.info.platform === 'xbox') badge = '<span class="badge ok">Xbox playbook</span>';
      else if (b.info.platform === 'ps2') badge = '<span class="badge warn">Already PS2</span>';
      else badge = '<span class="badge warn">Unknown platform header</span>';
      const details = b.info.ok
        ? `Book “${esc(b.info.bookName)}” · ${c.formations} formations · ${c.plays} plays · ${c.categories} categories · ${c.nodes} route nodes`
        : esc(b.info.errors.join(' '));
      return `<div class="book">
        <div>
          <h3>${esc(b.metaName || b.info.bookName || 'Playbook')}${badge}</h3>
          <div class="meta">${details}</div>
          <div class="meta">${esc(b.path)}</div>
        </div>
        <div class="actions">
          ${b.info.ok ? `<label class="meta">Team code <input type="text" data-code="${i}" value="${esc(b.code)}" maxlength="16" spellcheck="false"></label>
          <button class="btn" data-edit="${i}">Edit playbook</button>
          <button class="btn primary" data-download="${i}">${desktop ? 'Save…' : 'Download'}</button>` : ''}
          <button class="btn" data-remove="${i}" aria-label="Remove">✕</button>
        </div>
      </div>`;
    }).join('');
  }

  function convertBook(b) {
    // The playbook's own name (shown before a game) follows the team code, as in the game's editor.
    const named = BookEdit.setBookName(b.body, b.body, BookEdit.parseBook(b.body), b.code);
    return Saves.convertXboxToPs2(named.error ? b.body : named.body, b.code, format());
  }

  $('#books').addEventListener('input', e => {
    const i = e.target.dataset.code;
    if (i !== undefined) books[i].code = Saves.sanitizeCode(e.target.value);
  });
  $('#books').addEventListener('click', e => {
    const dl = e.target.dataset.download, rm = e.target.dataset.remove, ed = e.target.dataset.edit;
    if (ed !== undefined) {
      const b = books[ed];
      window.PlayEditor.open({ body: b.body, code: b.code, saveMeta: b.saveMeta, folderName: b.folder.split('/').pop(), source: b.path });
      showTab('edit');
    }
    if (dl !== undefined) {
      let out;
      try { out = convertBook(books[dl]); } catch (err) { alert(err.message); return; }
      saveOne(out);
    }
    if (rm !== undefined) { books.splice(rm, 1); renderBooks(); }
  });
  $('#download-all').addEventListener('click', async () => {
    const outputs = [];
    for (const b of books.filter(x => x.info.ok)) {
      try { outputs.push(convertBook(b)); }
      catch (err) { alert(`${b.path}: ${err.message}`); return; }
    }
    if (desktop) {
      const result = await desktop.saveFilesToFolder(outputs);
      if (result) setStatus(`Saved ${result.written.length} file${result.written.length === 1 ? '' : 's'} to ${result.folder}`, result.written[0]);
      return;
    }
    for (const out of outputs) {
      download(out.fileName, out.bytes);
      await new Promise(r => setTimeout(r, 300));
    }
  });
  $('#clear-books').addEventListener('click', () => { books = []; renderBooks(); setStatus(''); });

  const toItems = input => [...input.files].map(file => ({ file, path: file.webkitRelativePath || file.name }));
  if (desktop) {
    $('#download-all').textContent = 'Save all to folder…';
    // Native folder dialog; the main process returns only SAVEGAME.DAT / SaveMeta.xbx contents.
    $('#xbox-folder').closest('label').addEventListener('click', async e => {
      e.preventDefault();
      const found = await desktop.pickXboxFolder();
      if (found) addXboxFiles(found.map(f => ({ file: new File([f.data], f.name), path: f.path })));
    });
  }
  $('#xbox-folder').addEventListener('change', e => { addXboxFiles(toItems(e.target)); e.target.value = ''; });
  $('#xbox-files').addEventListener('change', e => { addXboxFiles(toItems(e.target)); e.target.value = ''; });
  wireDrop($('#xbox-drop'), addXboxFiles);

  // ------------------------------------------------------------ compare tab
  const slots = [null, null];

  async function loadSlot(index, file) {
    const el = document.querySelector(`.slot[data-slot="${index}"] .info`);
    try {
      const loaded = Saves.loadPlaybookFile(file.name, await readBytes(file));
      const info = Playbook.inspect(loaded.body);
      slots[index] = Object.assign({ fileName: file.name, info }, loaded);
      const check = v => v === null || v === undefined ? '—' : v ? '<span class="badge ok">OK</span>' : '<span class="badge bad">Mismatch</span>';
      const c = info.counts || {};
      el.innerHTML = `<dl>
        <dt>File</dt><dd>${esc(file.name)}</dd>
        <dt>Type</dt><dd>${esc(loaded.source)}</dd>
        <dt>Header platform</dt><dd>${esc(info.platform || '—')}</dd>
        <dt>Book name</dt><dd>${esc(info.bookName || '—')}</dd>
        <dt>Counts</dt><dd>${info.ok ? `${c.formations} formations · ${c.plays} plays · ${c.categories} categories · ${c.nodes} nodes` : esc(info.errors.join(' '))}</dd>
        <dt>Save checksum</dt><dd>${check(loaded.containerOk)}</dd>
        <dt>EXTRA CRC</dt><dd>${check(loaded.extraOk)}</dd>
      </dl>`;
    } catch (err) {
      slots[index] = null;
      el.innerHTML = `<p class="badge bad">${esc(err.message)}</p>`;
    }
    renderCompare();
  }

  // Hex rows (16 bytes) that contain a difference, A above B, differing bytes highlighted.
  function hexDiff(a, b, start, end, diffs) {
    const set = new Set(diffs);
    const rows = [...new Set(diffs.map(o => o - ((o - start) % 16)))].slice(0, 48);
    const line = (buf, rowStart) => {
      let s = '';
      for (let o = rowStart; o < Math.min(rowStart + 16, end); o++) {
        const h = buf[o].toString(16).padStart(2, '0');
        s += (set.has(o) ? `<b>${h}</b>` : h) + ' ';
      }
      return s;
    };
    let out = rows.map(r => `<i>${r.toString(16).toUpperCase().padStart(5, '0')} A</i> ${line(a, r)}\n<i>${' '.repeat(5)} B</i> ${line(b, r)}`).join('\n');
    if (rows.length === 48) out += '\n<i>… more rows not shown</i>';
    return `<pre class="hex">${out}</pre>`;
  }

  function renderCompare() {
    const box = $('#compare-result');
    const [A, B] = slots;
    if (!A || !B) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const a = A.body, b = B.body;
    const cmp = Playbook.compare(a, b);
    const expected = cmp.totalBytes - cmp.unexpectedBytes;
    let banner;
    if (cmp.totalBytes === 0) banner = '<div class="banner ok">The two playbooks are byte-for-byte identical.</div>';
    else if (cmp.unexpectedBytes === 0) banner = `<div class="banner ok">Identical except the console-specific header values (${expected} bytes at 0x10–0x1F).</div>`;
    else banner = `<div class="banner warn">${cmp.unexpectedBytes.toLocaleString()} bytes differ outside the console-specific header values.</div>`;

    const rows = cmp.regions.map(r => `<tr>
      <td>${esc(r.label)}</td><td class="num">${hex(r.start, 5)}–${hex(r.end, 5)}</td>
      <td class="num">${r.recordSize ? r.records.length : (r.records.length ? 'yes' : '—')}</td>
      <td class="num">${r.count ? r.count.toLocaleString() : '—'}</td></tr>`).join('');

    const details = cmp.regions.filter(r => r.count).map(r => {
      const recs = r.records.slice(0, 100).map(rec => {
        const title = rec.index === null ? `${hex(rec.start, 5)}–${hex(rec.end, 5)}` : `#${rec.index} at ${hex(rec.start, 5)}`;
        const note = rec.expectedCount ? ` · ${rec.expectedCount} bytes are console-specific header values` : '';
        return `<div class="rec"><div class="rec-title">${title} · ${rec.bytes.length} bytes differ${note}</div>${hexDiff(a, b, rec.start, rec.end, rec.bytes)}</div>`;
      }).join('');
      const more = r.records.length > 100 ? `<p class="note">${r.records.length - 100} more records not shown.</p>` : '';
      const n = r.records.length;
      const what = r.recordSize ? (n === 1 ? '1 record differs' : `${n} records differ`) : 'differs';
      return `<details><summary>${esc(r.label)} — ${what}</summary><div class="records">${recs}${more}</div></details>`;
    }).join('');

    const namesA = A.info.names || [], namesB = B.info.names || [];
    const nameDiffs = [];
    for (let i = 0; i < Math.max(namesA.length, namesB.length) && nameDiffs.length < 50; i++) {
      if (namesA[i] !== namesB[i]) nameDiffs.push(`<tr><td class="num">${i}</td><td>${esc(namesA[i] ?? '—')}</td><td>${esc(namesB[i] ?? '—')}</td></tr>`);
    }
    const namesTable = nameDiffs.length
      ? `<details><summary>Names — first ${nameDiffs.length} differences (A has ${namesA.length}, B has ${namesB.length})</summary><div class="records"><table><tr><th>#</th><th>A</th><th>B</th></tr>${nameDiffs.join('')}</table></div></details>`
      : '';

    box.innerHTML = `${banner}
      <table><tr><th>Region</th><th>Offsets</th><th>Records differing</th><th>Bytes differing</th></tr>${rows}</table>
      ${namesTable}${details}`;
  }

  document.querySelectorAll('.slot').forEach(slotEl => {
    const index = Number(slotEl.dataset.slot);
    slotEl.querySelector('input[type=file]').addEventListener('change', e => {
      if (e.target.files[0]) loadSlot(index, e.target.files[0]);
      e.target.value = '';
    });
    wireDrop(slotEl.querySelector('.drop'), items => { if (items[0]) loadSlot(index, items[0].file); });
  });
})();
