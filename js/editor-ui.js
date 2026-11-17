// "Edit playbook" tab: browse a book's run/pass and defensive plays, view them on a field, and edit existing steps.
(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const { esc, readBytes, filesFromDrop, wireDrop, download, desktop } = window.PorterShared;
  const YD = PlayCodec.YD_CM;

  let S = null; // open book state

  // ------------------------------------------------------------ open / close
  function open({ body, code, saveMeta, folderName, source }) {
    const original = body.slice();
    const book = BookEdit.parseBook(original);
    S = {
      original, body: original.slice(), book, baseCount: book.nodeCount,
      code: Saves.sanitizeCode(code) || Saves.sanitizeCode(book.bookName),
      saveMeta: saveMeta || null, folderName: folderName || '', source: source || '',
      edited: new Set(), editedForms: new Set(), formMode: false,
      unsaved: false, sel: null, slot: null, step: null, error: null, flip: false,
      defKind: new Map(book.plays.filter(p => p.kind === 'defense').map(p => [p.index, BookEdit.defenseKind(original, p.index)])),
    };
    const first = firstVisible();
    if (first) select(first.formation, first.play);
    $('#edit-empty').classList.add('hidden');
    $('#edit-book').classList.remove('hidden');
    $('#edit-code').value = S.code;
    $('#swap-undo').classList.add('hidden');
    setStatus('');
    renderAll();
  }

  function close() {
    if (S && S.unsaved && !confirm('Close this playbook? Your unsaved edits will be lost.')) return;
    S = null;
    $('#edit-book').classList.add('hidden');
    $('#edit-empty').classList.remove('hidden');
  }

  async function openItems(items) {
    try {
      const dat = items.find(i => /savegame\.dat$/i.test(i.file.name) && i.file.size === Playbook.SIZE);
      if (dat) {
        const dir = dat.path.includes('/') ? dat.path.slice(0, dat.path.lastIndexOf('/')) : '';
        const metaItem = items.find(i => /savemeta\.xbx$/i.test(i.file.name) && (i.path.slice(0, i.path.lastIndexOf('/')) === dir));
        const saveMeta = metaItem ? await readBytes(metaItem.file) : null;
        const body = await readBytes(dat.file);
        if (!Playbook.inspect(body).ok) throw new Error('That SAVEGAME.DAT is not a playbook.');
        open({ body, code: saveMeta ? Saves.parseSaveMeta(saveMeta) : '', saveMeta, folderName: dir.split('/').pop(), source: dat.path });
        return;
      }
      const item = items[0];
      if (!item) return;
      const loaded = Saves.loadPlaybookFile(item.file.name, await readBytes(item.file));
      const info = Playbook.inspect(loaded.body);
      if (!info.ok) throw new Error(info.errors.join(' '));
      open({ body: loaded.body, code: loaded.code, source: `${item.file.name} (${loaded.source})` });
    } catch (err) {
      alert(err.message);
    }
  }

  // ------------------------------------------------------------ selection helpers
  function kindFilter() { return document.querySelector('input[name=kind]:checked').value; }
  function unit() { return document.querySelector('input[name=unit]:checked').value; }

  // Badge kind of a listed play: run / pass on offense; front / cover / both on defense.
  function badgeKind(p) { return p.kind === 'defense' ? S.defKind.get(p.index) : p.kind; }
  const BADGE_TEXT = { run: 'RUN', pass: 'PASS', front: 'FRONT', cover: 'COVER', both: 'BLITZ' };

  function visibleGroups() {
    const kind = kindFilter(), q = $('#play-search').value.trim().toLowerCase();
    const defense = unit() === 'defense';
    const k1 = defense ? 'front' : 'run', k2 = defense ? 'cover' : 'pass';
    const groups = [];
    for (const f of S.book.formations) {
      const plays = f.links.map(i => S.book.plays[i]).filter(p => {
        if (defense ? p.kind !== 'defense' : p.kind !== 'run' && p.kind !== 'pass') return false;
        const b = badgeKind(p);
        if (kind === 'edited' && !S.edited.has(p.index) && !S.editedForms.has(f.index)) return false;
        if (kind === 'k1' && b !== k1 && !(defense && b === 'both')) return false;
        if (kind === 'k2' && b !== k2 && !(defense && b === 'both')) return false;
        return !q || p.name.toLowerCase().includes(q) || f.name.toLowerCase().includes(q);
      });
      if (plays.length) groups.push({ formation: f, plays });
    }
    return groups;
  }

  function firstVisible() {
    const g = visibleGroups()[0];
    return g ? { formation: g.formation.index, play: g.plays[0].index } : null;
  }

  function select(formation, play) {
    S.sel = { formation, play };
    S.step = null;
    S.error = null;
    const asg = BookEdit.readAssignments(S.body, play);
    // Keep the same player selected when moving between plays; default to the first route runner
    // (offense) or the first defender this call assigns (defense).
    const isDefense = S.book.plays[play].kind === 'defense';
    if (S.slot === null || S.slotUnit !== (isDefense ? 'defense' : 'offense')) {
      const pick = isDefense ? asg.findIndex(a => !BookEdit.isPlaceholder(a)) : asg.findIndex(a => a.nodes.some(n => n.op === 0x12));
      S.slot = pick >= 0 ? pick : 0;
      S.slotUnit = isDefense ? 'defense' : 'offense';
    }
  }

  // ------------------------------------------------------------ rendering
  function setStatus(message) {
    const el = $('#edit-status');
    el.hidden = !message;
    el.textContent = message || '';
  }

  function renderAll() {
    renderHeader();
    renderList();
    renderPlay();
  }

  function renderHeader() {
    const used = Playbook.u32(S.body, 0x40);
    const runPass = S.book.plays.filter(p => p.kind === 'run' || p.kind === 'pass').length;
    $('#edit-title').textContent = `${S.book.bookName} playbook`;
    const parts = [
      S.source && esc(S.source),
      `${runPass} run/pass plays`,
      `${S.defKind.size} defensive plays`,
      `${BookEdit.NODE_CAPACITY - used} spare steps`,
      S.edited.size ? `<strong>${S.edited.size} edited play${S.edited.size === 1 ? '' : 's'}</strong>` : '',
      S.editedForms.size ? `<strong>${S.editedForms.size} edited formation${S.editedForms.size === 1 ? '' : 's'}</strong>` : '',
      S.unsaved && (S.edited.size || S.editedForms.size) ? '(not saved)' : '',
    ];
    $('#edit-meta').innerHTML = parts.filter(Boolean).join(' · ');
  }

  function renderList() {
    const defense = unit() === 'defense';
    $('#swap-open').classList.toggle('hidden', !defense);
    $('#kind-k1').textContent = defense ? 'Fronts' : 'Run';
    $('#kind-k2').textContent = defense ? 'Coverages' : 'Pass';
    const groups = visibleGroups();
    if (!groups.length) { $('#play-list').innerHTML = '<div class="empty">No plays match.</div>'; return; }
    $('#play-list').innerHTML = groups.map(g => `<h4>${esc(g.formation.name)}${S.editedForms.has(g.formation.index) ? ' <span class="dot" title="Formation edited"></span><span class="form-edit-tag">(formation edit)</span>' : ''}</h4>` + g.plays.map(p => {
      const current = S.sel && S.sel.play === p.index && S.sel.formation === g.formation.index;
      return `<button data-formation="${g.formation.index}" data-play="${p.index}" aria-current="${current}">
        <span class="name">${esc(p.name)}</span>${S.edited.has(p.index) ? '<span class="dot" title="Edited"></span>' : ''}
        <span class="kind ${badgeKind(p)}">${BADGE_TEXT[badgeKind(p)]}</span></button>`;
    }).join('')).join('');
  }

  // A slot's label. A substituted slot shows who replaces the player (FB -> TE2 reads "TE2"), so the
  // diagram, step lists and slot panel match the lineup the game will field.
  function slotLabel(formation, slot) {
    const code = formation.positions[slot] || 0;
    if (S && S.body && formation.index !== undefined) {
      for (const [kind, d] of Object.entries(BookEdit.SUB_KINDS)) {
        if (code !== d.slotKind || formation.positions.indexOf(d.slotKind) !== slot) continue;
        const sub = BookEdit.formationSub(S.body, formation.index, kind);
        if (sub) return PlayCodec.positionLabel(d.replaceKind | (sub.depth << 5));
      }
    }
    return PlayCodec.positionLabel(code);
  }

  function renderPlay() {
    if (!S.sel) {
      $('#play-title').textContent = 'No play selected';
      $('#play-meta').textContent = ''; $('#field').innerHTML = ''; $('#step-list').innerHTML = '';
      return;
    }
    const play = S.book.plays[S.sel.play], formation = S.book.formations[S.sel.formation];
    $('#form-toggle').setAttribute('aria-pressed', String(S.formMode));
    $('#form-toggle').textContent = S.formMode ? 'Back to plays' : 'Edit formation';
    $('#flip-label').classList.toggle('hidden', S.formMode);
    $('#field').classList.toggle('form-mode', S.formMode);
    if (S.formMode) { renderFormation(play, formation); return; }
    $('#play-reset').textContent = 'Reset play';
    const others = play.formations.filter(f => f !== formation.index).map(f => S.book.formations[f].name);
    $('#play-title').textContent = play.name;
    const kindText = { run: 'Run play', pass: 'Pass play', front: 'Defensive front (pass rush)', cover: 'Coverage', both: 'Blitz (rush + coverage)' }[badgeKind(play)];
    $('#play-meta').innerHTML = `${kindText} · ${esc(formation.name)}` +
      (others.length ? ` · same play also used in ${esc([...new Set(others)].join(', '))}` : '');
    $('#play-reset').disabled = !S.edited.has(play.index);
    const err = BookEdit.validate(S.body, play.index);
    $('#play-check').innerHTML = err
      ? `<span class="badge bad">Fails the game's play check</span> ${esc(err)}`
      : '<span class="badge ok">Passes the game\'s play check</span>';
    $('#play-check').insertAdjacentHTML('beforeend', S.flip
      ? ' · Flipped: the diagram, left/right and lanes are mirrored to match a flipped play-call screen. Edits are saved correctly either way.'
      : ' · The diagram approximates the in-game play art.');
    $('#play-flip').checked = S.flip;
    renderField(play, formation);
    renderSteps(play, formation);
  }

  // Field diagram in yards: x across (offense's right = +), y downfield (line of scrimmage = 0).
  function renderField(play, formation, playersOnly) {
    const asg = playersOnly ? [] : BookEdit.readAssignments(S.body, play.index);
    const m = S.flip && !playersOnly ? -1 : 1; // Flip mirrors the whole diagram left-to-right.
    const players = formation.slots.map((p, s) => ({ s, x: m * p.x / YD, y: p.z / YD, label: slotLabel(formation, s) }));
    const starts = formation.slots.map(p => [p.x, p.z]);
    const holes = PlayCodec.laneHoles(formation.slots, formation.positions);
    const art = asg.map((a, s) => {
      const p = formation.slots[s];
      return PlayCodec.playArt(a.nodes, [p.x, p.z], p.x < 0, starts, holes)
        .map(seg => ({
          ...seg, slot: s,
          points: seg.points.map(([x, y]) => [m * x / YD, y / YD]),
          bar: seg.bar && seg.bar.map(([x, y]) => [m * x / YD, y / YD]),
        }));
    }).flat();

    const xs = players.map(p => p.x).concat(art.flatMap(a => a.points.map(q => q[0])));
    const ys = players.map(p => p.y).concat(art.flatMap(a => a.points.map(q => q[1])));
    // Zoom to the players and routes (at least ±16 yd) rather than always showing the full field width.
    const minX = Math.min(-16, ...xs) - 3, maxX = Math.max(16, ...xs) + 3;
    const minY = Math.min(-8, ...ys) - 2, maxY = Math.max(12, ...ys) + 3;
    const vb = `${minX.toFixed(2)} ${(-maxY).toFixed(2)} ${(maxX - minX).toFixed(2)} ${(maxY - minY).toFixed(2)}`;

    let svg = `<svg viewBox="${vb}" role="img" aria-label="Diagram of ${esc(play.name)}">`;
    for (let y = Math.ceil(minY / 5) * 5; y <= maxY; y += 5) {
      const los = y === 0;
      svg += `<line x1="${minX}" x2="${maxX}" y1="${-y}" y2="${-y}" stroke="${los ? '#9ecbff' : 'var(--field-line)'}" stroke-width="${los ? 0.22 : 0.08}"/>`;
      if (!los) svg += `<text x="${minX + 0.6}" y="${-y - 0.3}" font-size="1" fill="var(--field-line)">${y > 0 ? '+' : ''}${y}</text>`;
    }
    for (const sx of [-26.67, 26.67]) if (sx > minX && sx < maxX) svg += `<line x1="${sx}" x2="${sx}" y1="${-maxY}" y2="${-minY}" stroke="var(--field-line)" stroke-width="0.2"/>`;

    // Unselected players' paths first, then the selected player's on top.
    const ordered = art.filter(a => a.slot !== S.slot).concat(art.filter(a => a.slot === S.slot));
    for (const seg of ordered) {
      const selected = seg.slot === S.slot, current = selected && seg.nodeIndex === S.step;
      const color = selected ? 'var(--sel)' : 'var(--route-dim)';
      const width = current ? 0.6 : selected ? 0.36 : 0.22;
      const pts = seg.points.map(([x, y]) => `${x.toFixed(2)},${(-y).toFixed(2)}`).join(' ');
      const dash = seg.style === 'dashed' || seg.style === 'zone' ? ' stroke-dasharray="0.7 0.45"'
        : seg.style === 'dotted' ? ' stroke-dasharray="0.05 0.55"'
        : seg.style === 'faint' ? ` stroke-dasharray="0.35 0.45" stroke-opacity="${current ? 0.9 : 0.55}"` : '';
      svg += `<g class="player" data-slot="${seg.slot}" data-step="${seg.nodeIndex}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`;
      const [x2, y2] = seg.points[seg.points.length - 1], [x1, y1] = seg.points[seg.points.length - 2];
      const len = Math.hypot(x2 - x1, y2 - y1) || 1, ux = (x2 - x1) / len, uy = (y2 - y1) / len;
      if (seg.end === 'arrow') {
        const a = 0.9, w = 0.5;
        const p = [[x2, y2], [x2 - ux * a + uy * w, y2 - uy * a - ux * w], [x2 - ux * a - uy * w, y2 - uy * a + ux * w]];
        svg += `<polygon points="${p.map(([x, y]) => `${x.toFixed(2)},${(-y).toFixed(2)}`).join(' ')}" fill="${color}"/>`;
      } else if (seg.bar) {
        const [[bx1, by1], [bx2, by2]] = seg.bar;
        svg += `<line x1="${bx1.toFixed(2)}" y1="${(-by1).toFixed(2)}" x2="${bx2.toFixed(2)}" y2="${(-by2).toFixed(2)}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
      } else if (seg.end === 'block') {
        const w = 0.8;
        svg += `<line x1="${(x2 + uy * w).toFixed(2)}" y1="${(-(y2 - ux * w)).toFixed(2)}" x2="${(x2 - uy * w).toFixed(2)}" y2="${(-(y2 + ux * w)).toFixed(2)}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
      } else if (seg.end === 'zone') {
        // Zone drop: a shaded area at the landmark.
        svg += `<ellipse cx="${x2.toFixed(2)}" cy="${(-y2).toFixed(2)}" rx="2.6" ry="1.6" fill="${color}" fill-opacity="${selected ? 0.32 : 0.14}" stroke="${color}" stroke-width="${width * 0.6}"/>`;
      } else if (seg.end === 'man') {
        svg += `<text x="${(x2 + 0.7).toFixed(2)}" y="${(-y2 + 0.3).toFixed(2)}" font-size="0.9" font-weight="700" fill="${color}">MAN</text>`;
      }
      // Wide invisible hit target so thin routes are easy to click.
      svg += `<polyline points="${pts}" fill="none" stroke="transparent" stroke-width="1.6"/></g>`;
    }
    // On defense, players this call leaves to the paired front/coverage are drawn faded.
    const unassigned = play.kind === 'defense' ? new Set(asg.map((a, s) => (BookEdit.isPlaceholder(a) ? s : -1))) : new Set();
    for (const p of players) {
      const selected = p.s === S.slot;
      svg += `<g class="player" data-slot="${p.s}" tabindex="0" role="button" aria-label="${esc(p.label)}, slot ${p.s}"${unassigned.has(p.s) && !selected ? ' opacity="0.45"' : ''}>
        <circle cx="${p.x.toFixed(2)}" cy="${(-p.y).toFixed(2)}" r="0.82" fill="${selected ? 'var(--sel)' : 'var(--player)'}" stroke="#10202a" stroke-width="0.1"/>
        <text x="${p.x.toFixed(2)}" y="${(-p.y + 0.24).toFixed(2)}" font-size="${p.label.length > 2 ? 0.52 : 0.66}" font-weight="700" text-anchor="middle" fill="var(--player-text)">${esc(p.label)}</text></g>`;
    }
    $('#field').innerHTML = svg + '</svg>';
  }

  function inputFor(node, field, slot, step) {
    const value = BookEdit.displayValue(node, field, S.flip);
    const data = `data-slot="${slot}" data-step="${step}" data-field="${field.key}"`;
    const id = `f-${slot}-${step}-${field.key}`;
    if (field.options) {
      const opts = field.options.map(o => `<option value="${o.value}"${o.value === value ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
      return `<label for="${id}">${esc(field.label)}</label><select id="${id}" ${data}>${opts}</select>`;
    }
    const shown = Math.round(value * 100) / 100;
    return `<label for="${id}">${esc(field.label)}</label><input id="${id}" type="number" step="any" min="${field.min}" max="${field.max}" value="${shown}" ${data}>`;
  }

  function renderSteps(play, formation) {
    const asg = BookEdit.readAssignments(S.body, play.index);
    const slot = S.slot, a = asg[slot];
    $('#slot-title').textContent = `${slotLabel(formation, slot)} · slot ${slot}`;
    const picker = sharedFormationsNote(play, slot) + (play.kind === 'defense' ? jobPicker(play, formation, slot, a) : carrierPicker(play, formation));
    if (play.kind === 'defense' && BookEdit.isPlaceholder(a)) {
      const note = badgeKind(play) === 'front'
        ? 'Not assigned in this front. On the field his job comes from the coverage paired with it; change it there.'
        : 'Left to the front: on the field this lineman does whatever the paired front tells him. Pick a job above to override it in this coverage (e.g. drop him into a zone).';
      $('#slot-meta').innerHTML = `${picker}<div class="shared-note">${note}</div>`;
      $('#step-list').innerHTML = '';
      return;
    }
    const shared = BookEdit.sharedWith(S.body, play.index, slot);
    const sharedPlays = new Set(shared.map(x => x.play)).size;
    $('#slot-meta').innerHTML = picker + (shared.length
      ? `<div class="shared-note">These steps are shared with ${sharedPlays} other play${sharedPlays === 1 ? '' : 's'}. Your first change gives this player a private copy (${a.nodes.length} spare step${a.nodes.length === 1 ? '' : 's'}), so only this play changes.</div>`
      : '');
    $('#step-list').innerHTML = a.nodes.map((n, k) => {
      const fields = BookEdit.editableFields(n);
      const err = S.error && S.error.slot === slot && S.error.step === k ? `<div class="field-error" role="alert">${esc(S.error.message)}</div>` : '';
      return `<div class="step" data-step="${k}" aria-current="${k === S.step}">
        <div class="step-title"><b>${k + 1}</b>${esc(BookEdit.describeNode(n, S.flip, s => slotLabel(formation, s)))}</div>
        ${fields.length ? `<div class="fields">${fields.map(f => inputFor(n, f, slot, k)).join('')}</div>` : ''}${err}</div>`;
    }).join('');
  }

  // A play listed under several formations is still one play: edits show up in every one of them,
  // and the same slot can be a different player in each.
  function sharedFormationsNote(play, slot) {
    const formations = [...new Set(play.formations)].map(f => S.book.formations[f]);
    if (formations.length < 2) return '';
    const byLabel = new Map();
    for (const f of formations) {
      const label = slotLabel(f, slot);
      byLabel.set(label, (byLabel.get(label) || []).concat(f.name));
    }
    const names = formations.map(f => f.name);
    const list = names.length === 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    const who = byLabel.size > 1
      ? ` This player is ${[...byLabel].map(([label, fs]) => `${label} in ${fs.join(', ')}`).join('; ')}.`
      : '';
    return `<div class="shared-note warn-note">“${esc(play.name)}” is one play used by ${esc(list)}, so changes here apply in all of them.${esc(who)}</div>`;
  }

  // ------------------------------------------------------------ formation mode
  // Keeps the parsed formation objects in step with the edited book, so every view shows the
  // current name and base spots.
  function refreshFormation(fi) {
    const f = S.book.formations[fi];
    f.name = BookEdit.formationName(S.body, fi);
    f.slots = BookEdit.readSlots(S.body, fi).map(s => ({ x: s.x[0], z: s.z[0] }));
    f.categoryIndex = BookEdit.formationPackages(S.body, fi).def;
    f.positions = S.book.categories[f.categoryIndex].positions;
  }

  // "Packages" panel: which personnel groups this formation can be run with, and who stands where.
  function packagesPanel(formation) {
    const { def, members } = BookEdit.formationPackages(S.body, formation.index);
    const labels = cat => S.book.categories[cat].positions.map(c => PlayCodec.positionLabel(c));
    const base = labels(def);
    const diff = cat => {
      const o = labels(cat), d = base.map((x, i) => (x !== o[i] ? `${x} → ${o[i]}` : null)).filter(Boolean);
      return d.length ? d.join(', ') : 'same players';
    };
    const rows = members.map(cat => `<div class="pkg-row">
        <div><strong>${esc(S.book.categories[cat].name)}</strong>${cat === def ? ' <span class="badge ok">default</span>' : ''}
          <div class="meta">${cat === def ? esc(base.slice(6).join(' · ')) : esc(diff(cat))}</div></div>
        ${cat === def ? '' : `<div class="actions"><button class="btn" data-pkg-default="${cat}">Make default</button><button class="btn" data-pkg-remove="${cat}" aria-label="Remove ${esc(S.book.categories[cat].name)}">✕</button></div>`}
      </div>`).join('');
    const candidates = S.book.categories.filter(c => !members.includes(c.index) && BookEdit.packageCompatible(S.book, formation.index, c.index, S.body));
    const add = candidates.length
      ? `<div class="fields"><label for="pkg-add">Add package</label><select id="pkg-add"><option value="">Choose…</option>${candidates.map(c => `<option value="${c.index}">${esc(c.name)}: ${esc(diff(c.index))}</option>`).join('')}</select></div>`
      : '';
    return `<h3 style="margin-top:16px">Packages</h3>
      <p class="meta">Who lines up in each slot comes from the personnel package picked in the play-call screen. The default is shown on the diagram. Plays and other formations are not changed.</p>
      ${rows}${add}`;
  }

  // "Substitutions" panel: the game's in-game subs (rest the starting HB, swap the FB for a TE).
  // The replacement is picked by depth-chart place, which is how the game stores it.
  function subsPanel(formation) {
    const options = BookEdit.subOptions(S.body, S.book, formation.index);
    if (!options.length) return '';
    const rows = options.map(o => {
      const cur = o.current ? o.current.depth : '';
      const label = d => `${o.replacement}${d + 1}${d === 0 && o.replacement === 'TE' ? ' (starter)' : ''}${o.verified.includes(d) ? '' : ' (untested)'}`;
      return `<div class="fields"><label for="sub-${o.kind}">${esc(o.label)} replaced by</label>
        <select id="sub-${o.kind}" data-sub="${o.kind}"><option value="">Nobody (${esc(o.label.toLowerCase())} plays)</option>${o.depths.map(d => `<option value="${d}"${cur === d ? ' selected' : ''}>${esc(label(d))}</option>`).join('')}</select></div>`;
    }).join('');
    return `<h3 style="margin-top:16px">Substitutions</h3>
      <p class="meta">Swaps a player out of this formation for someone further down the depth chart (for example, rest the starting halfback). Plays and other formations are not changed.</p>
      ${rows}`;
  }

  function markFormation(fi) {
    refreshFormation(fi);
    if (BookEdit.formationEdited(S.body, S.original, fi)) S.editedForms.add(fi); else S.editedForms.delete(fi);
    S.unsaved = true;
  }

  function renderFormation(play, formation) {
    const offense = BookEdit.isOffenseFormation(formation.typeCode);
    const plays = formation.links.length;
    $('#play-title').textContent = formation.name;
    $('#play-meta').textContent = `${offense ? 'Offensive' : 'Defensive'} formation · used by ${plays} play${plays === 1 ? '' : 's'}. Moving a player moves him in all of them; no play is changed.`;
    $('#play-reset').textContent = 'Reset formation';
    $('#play-reset').disabled = !S.editedForms.has(formation.index);
    const warnings = BookEdit.formationWarnings(S.body, S.book, formation.index, S.original);
    const dirty = formationDirty();
    const illegal = dirty ? BookEdit.addedViolations(S.formBase, S.body, S.book, formation.index) : [];
    let legality = '';
    if (dirty && illegal.length) legality = `<div><span class="badge bad">Not a legal formation yet</span><ul class="warn-list bad-list">${illegal.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>`;
    else if (dirty) legality = '<div><span class="badge ok">Legal: ready to save</span></div>';
    $('#play-check').innerHTML = legality + (warnings.length
      ? `<span class="badge warn">Check these</span><ul class="warn-list">${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`
      : '<span class="badge ok">No alignment warnings</span> · Drag players or type exact spots on the right, then click Save formation.');
    renderField(play, formation, true);

    const slot = S.slot, p = formation.slots[slot];
    $('#slot-title').textContent = 'Formation';
    const err = S.error && S.error.formation ? `<div class="field-error" role="alert">${esc(S.error.message)}</div>` : '';
    const draftButtons = dirty
      ? '<div class="row" style="margin:4px 0 10px"><button class="btn primary" id="form-save">Save formation</button><button class="btn" id="form-discard">Discard changes</button></div>'
      : '';
    $('#slot-meta').innerHTML = `<div class="form-panel">${draftButtons}
      <div class="fields"><label for="form-name">Name</label><input id="form-name" type="text" maxlength="40" value="${esc(formation.name)}" spellcheck="false"></div>
      <h3 style="margin-top:14px">${esc(slotLabel(formation, slot))} · slot ${slot}</h3>
      <div class="fields">
        <label for="form-x">Sideways (yd, + = right)</label><input id="form-x" type="number" step="0.1" value="${Math.round(p.x / YD * 10) / 10}">
        <label for="form-z">${offense ? 'Depth (yd, − = backfield)' : 'Depth (yd off the line)'}</label><input id="form-z" type="number" step="0.1" value="${Math.round(p.z / YD * 10) / 10}">
      </div>${err}
      <p class="meta">His alternate spots (the game's pre-snap shifts and walk-ups) move with him. Plays keep their routes and assignments. Moving the QB deeper than 2.7 yd makes it a shotgun formation (shallower: under center).</p>
      ${offense ? packagesPanel(formation) : ''}
      ${offense ? subsPanel(formation) : ''}
    </div>`;
    $('#step-list').innerHTML = '';
  }

  // Formation edits are a draft: players move freely (hard limits only) and the real-football
  // eligibility rules are checked when the formation is saved.
  function formationDirty() {
    return !!(S.formMode && S.formBase && S.body.some((v, i) => v !== S.formBase[i]));
  }

  // Keeps the draft if the formation is legal. Returns false (and shows why) if it is not.
  function commitFormation() {
    if (!formationDirty()) return true;
    const problems = BookEdit.addedViolations(S.formBase, S.body, S.book, S.sel.formation);
    if (problems.length) {
      S.error = { formation: true, message: `Not saved: this isn't a legal formation yet. ${problems.join('; ')}. Fix it or click Discard changes.` };
      renderPlay();
      return false;
    }
    S.formBase = S.body.slice();
    S.error = null;
    setStatus(`Formation “${S.book.formations[S.sel.formation].name}” saved.`);
    return true;
  }

  function discardFormation() {
    S.body = S.formBase.slice();
    markFormation(S.sel.formation);
    if (!S.edited.size && !S.editedForms.size) S.unsaved = false;
    S.error = null;
    setStatus('Formation changes discarded.');
    renderAll();
  }

  function moveSelected(xYd, zYd) {
    const fi = S.sel.formation;
    const r = BookEdit.moveSlot(S.body, S.book, fi, S.slot, xYd * YD, zYd * YD, { draft: true });
    if (r.error) { S.error = { formation: true, message: `Not moved. ${r.error}` }; renderPlay(); return; }
    S.error = null;
    if (!r.unchanged) { S.body = r.body; markFormation(fi); }
    if (r.alignment) setStatus(`QB moved to ${r.alignment}: the formation is now marked as a ${r.alignment} formation, as the game does for its own.`);
    renderAll();
  }

  // Dragging players in formation mode (SVG units are yards; y is negated).
  let drag = null;
  $('#field').addEventListener('pointerdown', e => {
    if (!S || !S.formMode) return;
    const g = e.target.closest('.player');
    if (!g) return;
    const svg = $('#field svg');
    const toSvg = ev => { const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY; return pt.matrixTransform(svg.getScreenCTM().inverse()); };
    S.slot = Number(g.dataset.slot);
    drag = { g, svg, toSvg, start: toSvg(e), moved: false };
    g.classList.add('dragging');
    try { svg.setPointerCapture(e.pointerId); } catch { /* still works without capture */ }
    e.preventDefault();
  });
  $('#field').addEventListener('pointermove', e => {
    if (!drag) return;
    const pt = drag.toSvg(e);
    const dx = pt.x - drag.start.x, dy = pt.y - drag.start.y;
    if (Math.hypot(dx, dy) > 0.15) drag.moved = true;
    drag.g.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
  });
  $('#field').addEventListener('pointerup', e => {
    if (!drag) return;
    const d = drag; drag = null;
    if (!d.moved) { S.error = null; renderPlay(); return; }
    const pt = d.toSvg(e), p = S.book.formations[S.sel.formation].slots[S.slot];
    const x = Math.round((p.x / YD + pt.x - d.start.x) * 10) / 10;
    const z = Math.round((p.z / YD - (pt.y - d.start.y)) * 10) / 10;
    moveSelected(x, z);
  });

  $('#slot-meta').addEventListener('change', e => {
    if (!S || !S.formMode) return;
    if (e.target.id === 'form-x' || e.target.id === 'form-z') {
      moveSelected(Number($('#form-x').value), Number($('#form-z').value));
    } else if (e.target.id === 'form-name') {
      const fi = S.sel.formation;
      const r = BookEdit.setFormationName(S.body, S.original, S.book, fi, e.target.value);
      if (r.error) { S.error = { formation: true, message: `Not renamed. ${r.error}` }; renderPlay(); return; }
      S.error = null;
      S.body = r.body;
      markFormation(fi);
      setStatus(`Formation renamed to “${S.book.formations[fi].name}”.`);
      renderAll();
    }
  });

  function applyPackage(r, message) {
    const fi = S.sel.formation;
    if (r.error) { S.error = { formation: true, message: `Not changed. ${r.error}` }; renderPlay(); return; }
    S.error = null;
    if (!r.unchanged) { S.body = r.body; markFormation(fi); setStatus(message); }
    renderAll();
  }
  $('#slot-meta').addEventListener('change', e => {
    if (!S || !S.formMode || e.target.id !== 'pkg-add' || e.target.value === '') return;
    const cat = Number(e.target.value);
    applyPackage(BookEdit.setPackageMember(S.body, S.book, S.sel.formation, cat, true),
      `Added the “${S.book.categories[cat].name}” package to this formation.`);
  });
  $('#slot-meta').addEventListener('change', e => {
    if (!S || !S.formMode || !e.target.dataset || !e.target.dataset.sub) return;
    const kind = e.target.dataset.sub, depth = e.target.value === '' ? null : Number(e.target.value);
    const o = BookEdit.SUB_KINDS[kind];
    applyPackage(BookEdit.setFormationSub(S.body, S.book, S.sel.formation, kind, depth),
      depth === null ? `Removed the ${o.label.toLowerCase()} substitution.` : `${o.label} is now replaced by ${o.replacement}${depth + 1} in this formation.`);
  });
  $('#slot-meta').addEventListener('click', e => {
    if (!S || !S.formMode) return;
    const def = e.target.dataset.pkgDefault, rm = e.target.dataset.pkgRemove;
    if (def !== undefined) {
      applyPackage(BookEdit.setDefaultPackage(S.body, S.book, S.sel.formation, Number(def)),
        `“${S.book.categories[def].name}” is now this formation's default package.`);
    } else if (rm !== undefined) {
      applyPackage(BookEdit.setPackageMember(S.body, S.book, S.sel.formation, Number(rm), false),
        `Removed the “${S.book.categories[rm].name}” package from this formation.`);
    }
  });

  $('#form-toggle').addEventListener('click', () => {
    if (S.formMode && !commitFormation()) return;
    S.formMode = !S.formMode;
    S.formBase = S.formMode ? S.body.slice() : null;
    S.error = null;
    renderAll();
  });
  $('#slot-meta').addEventListener('click', e => {
    if (!S || !S.formMode) return;
    if (e.target.id === 'form-save' && commitFormation()) renderAll();
    if (e.target.id === 'form-discard') discardFormation();
  });

  // ------------------------------------------------------------ defensive jobs
  const JOB_NAMES = { rush: 'Blitz / rush', zone: 'Zone', man: 'Man', front: 'Leave to the front' };

  function jobSummary(assignment) {
    const job = BookEdit.jobOf(assignment);
    if (job === 'front') return 'Left to the front';
    const action = assignment.nodes.find(n => [0x0B, 0x0C, 0x0D, 0x0E].includes(n.op));
    return action ? BookEdit.describeNode(action, S.flip) : JOB_NAMES[job] || 'Other';
  }

  function jobOptionsFor(play, formation, slot) {
    return BookEdit.jobOptions(S.body, S.book, formation.index, play.index, slot, p => S.defKind.get(p));
  }

  // "Job" dropdown: this defender's current job plus every job he has in other calls of this formation.
  function jobPicker(play, formation, slot, current) {
    const options = jobOptionsFor(play, formation, slot);
    if (!options.length) {
      return badgeKind(play) === 'front' ? '' : '<div class="shared-note">No other jobs for this player in this formation\'s calls.</div>';
    }
    const groups = ['rush', 'zone', 'man', 'front'].map(job => {
      const rows = options.filter(o => o.job === job).map(o =>
        `<option value="${o.donorPlay}">${esc(o.job === 'front' ? 'Leave to the front' : jobSummary(o.assignment))} · as in “${esc(S.book.plays[o.donorPlay].name)}”</option>`).join('');
      return rows ? `<optgroup label="${JOB_NAMES[job]}">${rows}</optgroup>` : '';
    }).join('');
    return `<div class="fields job"><label for="job-select">Job</label>
      <select id="job-select"><option value="" selected>${esc(jobSummary(current))} (current)</option>${groups}</select></div>
      <p class="meta job-help">${options.length} other job${options.length === 1 ? '' : 's'} this player has in calls used by ${play.formations.length > 1 ? 'the same formations' : esc(formation.name)}. Picking one uses that call's own steps, so nothing new is created.</p>`;
  }

  function applyJobChoice(donorPlay) {
    const play = S.book.plays[S.sel.play], formation = S.book.formations[S.sel.formation];
    const r = BookEdit.applyJob(S.body, S.book, S.baseCount, formation.index, play.index, S.slot, donorPlay, p => S.defKind.get(p));
    if (r.error) { setStatus(`Not changed. ${r.error}`); renderPlay(); return; }
    S.body = r.body;
    S.unsaved = true;
    S.step = null;
    if (BookEdit.isEdited(S.body, S.original, play.index)) S.edited.add(play.index); else S.edited.delete(play.index);
    setStatus(`${slotLabel(formation, S.slot)} now has the job from “${S.book.plays[donorPlay].name}” in “${play.name}”.`);
    renderAll();
  }

  // ------------------------------------------------------------ ball carrier
  const SKILL_LABEL = /^(WR|TE|HB|FB)\d*$/;

  // "Handoff to" dropdown for runs: swaps which skill player takes the ball (and his steps with him).
  function carrierPicker(play, formation) {
    if (play.kind !== 'run') return '';
    const { current, slots } = BookEdit.carrierOptions(S.body, S.baseCount, play.index);
    const options = slots.filter(s => SKILL_LABEL.test(slotLabel(formation, s)));
    if (current < 0 || !options.length) return '';
    const rows = options.map(s => `<option value="${s}">${esc(slotLabel(formation, s))} · slot ${s}</option>`).join('');
    return `<div class="fields job"><label for="carrier-select">Handoff goes to</label>
      <select id="carrier-select"><option value="" selected>${esc(slotLabel(formation, current))} · slot ${current} (current)</option>${rows}</select></div>
      <p class="meta job-help">Picking another player swaps his steps with the ball carrier's in this play only.</p>`;
  }

  function applyCarrierChoice(slot) {
    const play = S.book.plays[S.sel.play], formation = S.book.formations[S.sel.formation];
    const r = BookEdit.setCarrier(S.body, S.baseCount, play.index, slot);
    if (r.error) { setStatus(`Not changed. ${r.error}`); renderPlay(); return; }
    S.body = r.body;
    S.unsaved = true;
    S.step = null;
    S.slot = slot;
    if (BookEdit.isEdited(S.body, S.original, play.index)) S.edited.add(play.index); else S.edited.delete(play.index);
    setStatus(`${slotLabel(formation, slot)} now takes the handoff in “${play.name}”.`);
    renderAll();
  }

  // ------------------------------------------------------------ editing and saving
  function applyField(el) {
    const slot = Number(el.dataset.slot), step = Number(el.dataset.step), key = el.dataset.field;
    const node = BookEdit.readAssignments(S.body, S.sel.play)[slot].nodes[step];
    const field = BookEdit.editableFields(node).find(f => f.key === key);
    const value = field ? BookEdit.storedValue(field, el.value, S.flip) : el.value;
    const r = BookEdit.applyEdit(S.body, S.baseCount, S.sel.play, slot, step, key, value);
    S.step = step;
    if (r.error) {
      S.error = { slot, step, message: `Not changed. ${r.error}` };
    } else {
      S.error = null;
      if (!r.unchanged) {
        S.body = r.body;
        S.unsaved = true;
        if (BookEdit.isEdited(S.body, S.original, S.sel.play)) S.edited.add(S.sel.play); else S.edited.delete(S.sel.play);
        setStatus(r.copied ? `Gave ${slotLabel(S.book.formations[S.sel.formation], slot)} a private copy of their steps, so only “${S.book.plays[S.sel.play].name}” changes.` : '');
      }
    }
    renderAll();
    const again = document.getElementById(el.id);
    if (again) again.focus();
  }

  function currentCode() {
    const code = Saves.sanitizeCode($('#edit-code').value);
    if (!code) throw new Error('Enter a team code (letters or digits) first.');
    return code;
  }

  // Keeps the book's own name (shown before a game) in step with the team code, as the game's editor does.
  function applyBookName(code) {
    const r = BookEdit.setBookName(S.body, S.original, S.book, code);
    if (r.error) throw new Error(r.error);
    if (r.unchanged) return '';
    S.body = r.body;
    S.book.bookName = BookEdit.bookName(S.body);
    renderHeader();
    return ` The playbook itself is now named “${code}” too, so the game shows that name before a game.`;
  }

  async function savePs2() {
    if (S.formMode && !commitFormation()) return;
    try {
      const renamed = applyBookName(currentCode());
      const out = Saves.convertXboxToPs2(S.body, currentCode(), $('#edit-format').value);
      if (desktop) {
        const saved = await desktop.saveFile(out.fileName, out.bytes);
        if (!saved) return;
        setStatus(`Saved ${saved}.${renamed}`);
      } else {
        download(out.fileName, out.bytes);
        setStatus(`Downloaded ${out.fileName}.${renamed}`);
      }
      S.unsaved = false;
      renderHeader();
    } catch (err) { alert(err.message); }
  }

  async function saveXbox() {
    if (S.formMode && !commitFormation()) return;
    try {
      const code = currentCode();
      const meta = S.saveMeta && Saves.sanitizeCode(Saves.parseSaveMeta(S.saveMeta)) === code ? S.saveMeta : null;
      const renamed = applyBookName(code);
      const files = await Saves.buildXboxSave(S.body, code, meta);
      const folderName = (meta && S.folderName) || Saves.xboxFolderName(code);
      if (desktop) {
        const result = await desktop.saveXboxFolder(folderName, files.map(f => ({ name: f.name, bytes: f.data })));
        if (!result) return;
        if (result.error) { alert(result.error); return; }
        setStatus(`Saved signed Xbox save to ${result.folder}.${renamed}`);
      } else {
        for (const f of files) { download(f.name, f.data); await new Promise(r => setTimeout(r, 300)); }
        setStatus(`Downloaded 4 files. Put them together in a folder named ${folderName} inside UDATA\\53450030.${renamed}`);
      }
      S.unsaved = false;
      renderHeader();
    } catch (err) { alert(err.message); }
  }

  // ------------------------------------------------------------ events
  $('#play-list').addEventListener('click', e => {
    const btn = e.target.closest('button[data-play]');
    if (!btn) return;
    if (S.formMode && !commitFormation()) return;
    select(Number(btn.dataset.formation), Number(btn.dataset.play));
    if (S.formMode) S.formBase = S.body.slice();
    renderAll();
  });
  document.querySelectorAll('input[name=kind]').forEach(r => r.addEventListener('change', renderList));
  document.querySelectorAll('input[name=unit]').forEach(r => r.addEventListener('change', e => {
    if (!S) return;
    if (S.formMode && !commitFormation()) {
      // Stay on the formation being edited until it is legal or discarded.
      document.querySelector(`input[name=unit][value=${e.target.value === 'defense' ? 'offense' : 'defense'}]`).checked = true;
      return;
    }
    const first = firstVisible();
    if (first) select(first.formation, first.play); else S.sel = null;
    renderAll();
  }));
  $('#play-search').addEventListener('input', renderList);

  $('#field').addEventListener('click', e => {
    const g = e.target.closest('.player');
    if (!g) return;
    S.slot = Number(g.dataset.slot);
    S.step = g.dataset.step !== undefined ? Number(g.dataset.step) : null;
    S.error = null;
    renderPlay();
  });
  $('#field').addEventListener('keydown', e => {
    const g = e.target.closest('.player');
    if (!g || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    S.slot = Number(g.dataset.slot); S.step = null; S.error = null;
    renderPlay();
  });

  $('#step-list').addEventListener('change', e => { if (e.target.dataset.field) applyField(e.target); });
  $('#slot-meta').addEventListener('change', e => {
    if (e.target.id === 'job-select' && e.target.value !== '') applyJobChoice(Number(e.target.value));
    if (e.target.id === 'carrier-select' && e.target.value !== '') applyCarrierChoice(Number(e.target.value));
  });
  $('#step-list').addEventListener('click', e => {
    const row = e.target.closest('.step');
    if (!row || e.target.closest('input, select')) return;
    S.step = Number(row.dataset.step);
    renderPlay();
  });

  $('#play-reset').addEventListener('click', () => {
    S.error = null;
    if (S.formMode) {
      const fi = S.sel.formation;
      S.body = BookEdit.resetFormation(S.body, S.original, S.book, fi);
      refreshFormation(fi);
      S.editedForms.delete(fi);
      S.formBase = S.body.slice();
      setStatus(`Reset formation “${S.book.formations[fi].name}” to the original.`);
    } else {
      S.body = BookEdit.resetPlay(S.body, S.original, S.baseCount, S.sel.play);
      S.edited.delete(S.sel.play);
      setStatus(`Reset “${S.book.plays[S.sel.play].name}” to the original.`);
    }
    S.unsaved = S.edited.size > 0 || S.editedForms.size > 0;
    renderAll();
  });
  $('#play-flip').addEventListener('change', e => { S.flip = e.target.checked; renderPlay(); });
  $('#edit-close').addEventListener('click', close);
  $('#edit-save-ps2').addEventListener('click', savePs2);
  $('#edit-save-xbox').addEventListener('click', saveXbox);

  $('#edit-file').addEventListener('change', e => {
    const items = [...e.target.files].map(file => ({ file, path: file.webkitRelativePath || file.name }));
    e.target.value = '';
    openItems(items);
  });
  wireDrop($('#edit-drop'), openItems);

  window.addEventListener('beforeunload', e => { if (S && S.unsaved) { e.preventDefault(); e.returnValue = ''; } });

  // ------------------------------------------------------------ swap the whole defense
  let swap = null; // { donor, name, plan }

  // Starts a fresh baseline from `body` (after a swap the old edit markers no longer apply).
  function rebase(body) {
    S.original = body.slice();
    S.body = body.slice();
    S.book = BookEdit.parseBook(S.original);
    S.baseCount = S.book.nodeCount;
    S.defKind = new Map(S.book.plays.filter(p => p.kind === 'defense').map(p => [p.index, BookEdit.defenseKind(S.original, p.index)]));
    S.edited = new Set(); S.editedForms = new Set();
    S.formMode = false; S.error = null; S.slot = null;
    const first = firstVisible();
    if (first) select(first.formation, first.play); else S.sel = null;
  }

  function renderSwapPlan() {
    const box = $('#swap-plan');
    $('#swap-apply').disabled = !(swap && swap.plan && !swap.plan.error);
    if (!swap) { box.innerHTML = ''; return; }
    if (swap.plan.error) { box.innerHTML = `<p class="field-error" role="alert">${esc(swap.plan.error)}</p>`; return; }
    const s = swap.plan.summary;
    const rows = s.formations.map(f => `<tr><td>${esc(f.from)}</td><td>→</td><td><strong>${esc(f.to)}</strong></td><td class="num">${f.calls} calls</td></tr>`).join('');
    const dropped = swap.plan.dropped.length
      ? `<details><summary>${swap.plan.dropped.length} of ${esc(s.donorBook)}'s calls left out so the defense fits the ${s.targetSlots} defensive play slots</summary><div class="records"><table>
          <tr><th>Call</th><th>Type</th><th>Formation</th></tr>${swap.plan.dropped.map(d => `<tr><td>${esc(d.name)}</td><td>${esc({ both: 'Blitz', cover: 'Coverage', front: 'Front' }[d.kind])}</td><td>${esc(d.formations.join(', '))}</td></tr>`).join('')}</table>
          <p class="meta">Calls are left out only from blitzes and coverages a single formation uses, never audibles, and every formation keeps a front and a coverage.</p></div></details>`
      : `<p class="meta">All ${s.donorCalls} of ${esc(s.donorBook)}'s calls fit.</p>`;
    const notes = swap.plan.warnings.slice();
    if (s.untouched.length) notes.push(`${s.targetBook}'s ${s.untouched.join(', ')} ${s.untouched.length === 1 ? 'has' : 'have'} no match in ${s.donorBook}'s book and stay${s.untouched.length === 1 ? 's' : ''} as ${s.untouched.length === 1 ? 'it is' : 'they are'}.`);
    if (s.notBrought.length) notes.push(`${s.donorBook}'s ${s.notBrought.join(', ')} ${s.notBrought.length === 1 ? 'is' : 'are'} not brought in (this book has no spare defensive formation slot for ${s.notBrought.length === 1 ? 'it' : 'them'}).`);
    const warn = notes.length ? `<ul class="warn-list">${notes.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
    box.innerHTML = `${warn}<table><tr><th>${esc(s.targetBook)} now</th><th></th><th>Becomes (${esc(s.donorBook)})</th><th></th></tr>${rows}</table>${dropped}
      <p class="meta">${S.edited.size || S.editedForms.size ? 'Edits you have made so far stay in the book, but the edit markers start over after the swap. ' : ''}You can undo the swap until you close the book.</p>`;
  }

  async function loadDonor(items) {
    try {
      const dat = items.find(i => /savegame\.dat$/i.test(i.file.name) && i.file.size === Playbook.SIZE) || items[0];
      if (!dat) return;
      const loaded = Saves.loadPlaybookFile(dat.file.name, await readBytes(dat.file));
      if (!Playbook.inspect(loaded.body).ok) throw new Error('That file is not a playbook.');
      swap = { donor: loaded.body, plan: DefenseSwap.planDefenseSwap(S.body, loaded.body) };
    } catch (err) {
      swap = { plan: { error: err.message } };
    }
    renderSwapPlan();
  }

  $('#swap-open').addEventListener('click', () => { swap = null; renderSwapPlan(); $('#swap-dialog').showModal(); });
  $('#swap-cancel').addEventListener('click', () => $('#swap-dialog').close());
  $('#swap-file').addEventListener('change', e => {
    const items = [...e.target.files].map(file => ({ file, path: file.name }));
    e.target.value = '';
    loadDonor(items);
  });
  wireDrop($('#swap-drop'), loadDonor);
  $('#swap-apply').addEventListener('click', () => {
    const r = DefenseSwap.applyDefenseSwap(S.body, swap.donor, swap.plan);
    if (r.error) { swap.plan = { error: r.error }; renderSwapPlan(); return; }
    S.preSwap = (S.preSwap || []).concat([{ body: S.body.slice(), original: S.original, edited: S.edited, editedForms: S.editedForms }]);
    rebase(r.body);
    S.unsaved = true;
    $('#swap-dialog').close();
    const s = r.report;
    setStatus(`Defense swapped: ${s.formations.map(f => `${f.from} → ${f.to}`).join(', ')}. ${s.keptCalls} of ${s.donorBook}'s ${s.donorCalls} calls brought in; offense and special teams unchanged.`);
    $('#swap-undo').classList.remove('hidden');
    renderAll();
  });
  $('#swap-undo').addEventListener('click', () => {
    const prev = S.preSwap.pop();
    rebase(prev.original);
    S.body = prev.body; S.edited = prev.edited; S.editedForms = prev.editedForms;
    for (const fi of S.editedForms) refreshFormation(fi);
    if (!S.preSwap.length) $('#swap-undo').classList.add('hidden');
    S.unsaved = S.edited.size > 0 || S.editedForms.size > 0 || S.preSwap.length > 0;
    setStatus('Defense swap undone.');
    renderAll();
  });

  window.PlayEditor = { open };
})();
