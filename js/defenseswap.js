// Swap a book's whole defense for another book's (e.g. turn a 4-3 team's defense into a 3-4 team's).
// Modelled on what the game's own custom-playbook editor writes when it adds another team's formation:
// the donor's formation record, personnel row and calls are copied byte-for-byte, and identical step
// chains are stored once. Because the base defense can't be removed and books sit near the 270-play
// limit, the donor's defense is written into the target's existing defensive formation, package and
// play slots instead of being appended. No formation, package or play record is added; extra donor
// calls are left out (never audibles; every formation keeps a front and a coverage).
(function (root) {
  'use strict';

  const BookEdit = root.BookEdit || (typeof require !== 'undefined' && require('./bookedit.js'));
  const Playbook = root.Playbook || (typeof require !== 'undefined' && require('./playbook.js'));
  const { u32, putU32 } = Playbook;

  const FORMATION_BASE = 0x134, FORMATION_SIZE = 0xB4, AUX_BASE = 0x245C, AUX_SIZE = 0x50;
  const PLAY_BASE = 0x33FC, PLAY_SIZE = 0x60, CATEGORY_BASE = 0x993C, CATEGORY_SIZE = 0x10;
  const NODE_BASE = 0x9ADC, NODE_SIZE = 8, NODE_CAPACITY = 3500;
  const NAME_COUNT = 0x1083C, NAME_POOL = 0x10840, NAME_LIMIT = 0x13380 - 16;
  const DEFENSE_AUDIBLES = 0x56, EMPTY_LINK = 0x07FF, LINKS = 36, SLOTS = 11;

  const i32 = (b, o) => u32(b, o) | 0;
  const resolve = (b, field) => field - 1 + i32(b, field);
  const pointTo = (b, field, target) => putU32(b, field, (target - field + 1) >>> 0);
  const formationOff = f => FORMATION_BASE + f * FORMATION_SIZE;
  const auxOff = f => AUX_BASE + f * AUX_SIZE;
  const playOff = p => PLAY_BASE + p * PLAY_SIZE;
  const categoryOff = c => CATEGORY_BASE + c * CATEGORY_SIZE;
  const link = (b, f, l) => b[auxOff(f) + l * 2] | (b[auxOff(f) + l * 2 + 1] << 8);

  function utf16At(b, o) {
    let s = '';
    for (; o + 1 < b.length; o += 2) { const c = b[o] | (b[o + 1] << 8); if (!c) break; s += String.fromCharCode(c); }
    return s;
  }

  const isDefenseFormation = f => f.typeCode >= 4 && f.typeCode <= 7;

  // Pairs target and donor defensive formations: same names first (Nickel, Dime, Bear…), then the
  // remaining ones (e.g. 4-3 with 3-4) in book order. A target's extra formations (e.g. BUF's 3-2 and
  // 3-3) stay as they are; a donor's extra formations are not brought in.
  function mapFormations(tBook, dBook) {
    const t = tBook.formations.filter(isDefenseFormation), d = dBook.formations.filter(isDefenseFormation);
    const pairs = [], usedD = new Set();
    for (const tf of t) {
      const df = d.find(x => !usedD.has(x.index) && x.name === tf.name);
      if (df) { pairs.push({ t: tf.index, d: df.index }); usedD.add(df.index); }
    }
    const restT = t.filter(tf => !pairs.some(p => p.t === tf.index)), restD = d.filter(df => !usedD.has(df.index));
    restT.slice(0, restD.length).forEach((tf, i) => pairs.push({ t: tf.index, d: restD[i].index }));
    if (!pairs.length) return { error: 'Neither book has defensive formations to swap.' };
    pairs.sort((a, b) => a.t - b.t);
    return {
      pairs,
      untouched: restT.slice(restD.length).map(f => f.name),
      notBrought: restD.slice(restT.length).map(f => f.name),
    };
  }

  const defenseLinks = (b, book, f) => [...Array(LINKS).keys()].map(l => link(b, f, l)).filter(v => (v & 0x1FF) !== 0x1FF && (v & 0x1FF) < book.plays.length);

  // Works out what the swap would do. Returns { error } or a plan with a readable summary.
  function planDefenseSwap(target, donor) {
    const tBook = BookEdit.parseBook(target), dBook = BookEdit.parseBook(donor);
    const map = mapFormations(tBook, dBook);
    if (map.error) return { error: map.error };
    const tDef = new Set(map.pairs.map(p => p.t));

    // Target side: each defensive formation's package must be its own, and its calls defensive only.
    const tPlays = new Set();
    for (const { t } of map.pairs) {
      const cat = BookEdit.formationPackages(target, t).def;
      const users = tBook.formations.filter(f => f.index !== t && BookEdit.formationPackages(target, f.index).members.includes(cat));
      if (users.length) return { error: `${tBook.formations[t].name}'s personnel package is also used by ${users.map(f => f.name).join(', ')}, so it can't be replaced.` };
      for (const v of defenseLinks(target, tBook, t)) tPlays.add(v & 0x1FF);
    }
    for (const f of tBook.formations) {
      if (tDef.has(f.index)) continue;
      const shared = defenseLinks(target, tBook, f.index).map(v => v & 0x1FF).filter(p => tPlays.has(p));
      if (shared.length) return { error: `${f.name} uses defensive calls from the formations being replaced.` };
    }
    const slots = [...tPlays].sort((a, b) => a - b);

    // Donor side: its defensive calls, in book order, and the ones its audibles use.
    const dPlaysSet = new Set();
    for (const { d } of map.pairs) for (const v of defenseLinks(donor, dBook, d)) dPlaysSet.add(v & 0x1FF);
    const dPlays = [...dPlaysSet].sort((a, b) => a - b);
    const protectedPlays = new Set();
    for (let i = 0; i < 5; i++) {
      const f = donor[DEFENSE_AUDIBLES + i * 2], l = donor[DEFENSE_AUDIBLES + i * 2 + 1];
      if (f < dBook.formations.length && l < LINKS && (link(donor, f, l) & 0x1FF) !== 0x1FF) protectedPlays.add(link(donor, f, l) & 0x1FF);
    }

    // Leave calls out until the donor's defense fits the target's defensive play slots.
    const menus = new Map(map.pairs.map(({ d }) => [d, defenseLinks(donor, dBook, d).map(v => v & 0x1FF)]));
    const kindOf = p => BookEdit.defenseKind(donor, p);
    const dropped = new Set();
    const usage = p => map.pairs.filter(({ d }) => menus.get(d).includes(p)).length;
    while (dPlays.length - dropped.size > slots.length) {
      // From the formation with the most calls left, drop a call only it uses: blitzes first, then
      // coverages, last in its menu first; never a front if it is the formation's only one.
      const order = map.pairs.map(({ d }) => d).sort((a, b) => menus.get(b).filter(p => !dropped.has(p)).length - menus.get(a).filter(p => !dropped.has(p)).length);
      let pick = null;
      for (const d of order) {
        const left = menus.get(d).filter(p => !dropped.has(p));
        const fronts = left.filter(p => kindOf(p) === 'front').length, covers = left.length - fronts;
        const candidates = left.filter(p => usage(p) === 1 && !protectedPlays.has(p) &&
          (kindOf(p) === 'front' ? fronts > 1 : covers > 1)).reverse();
        const rank = p => ({ both: 0, cover: 1, front: 2 })[kindOf(p)];
        candidates.sort((a, b) => rank(a) - rank(b));
        if (candidates.length) { pick = candidates[0]; break; }
      }
      if (pick === null) return { error: `The donor's defense has ${dPlays.length} calls and only ${slots.length} fit; not enough can be left out safely.` };
      dropped.add(pick);
    }
    const kept = dPlays.filter(p => !dropped.has(p));

    // A formation's calls carry its type code (14 = any). A donor whose formation holds calls of another
    // type was converted by another tool (e.g. a 3-4 formation still running 4-3 calls).
    const warnings = [];
    for (const { d } of map.pairs) {
      const f = dBook.formations[d];
      const off = menus.get(d).filter(p => !dropped.has(p) && ![f.typeCode, 14].includes(dBook.plays[p].flags & 63));
      if (off.length) warnings.push(`${dBook.bookName}'s ${f.name} still uses ${off.length} call${off.length === 1 ? '' : 's'} made for a different formation type (e.g. 4-3 calls in a 3-4). It looks converted by another tool; a team whose own playbook is ${f.name} makes a better donor.`);
    }
    const assign = new Map(kept.map((p, i) => [p, slots[i]]));
    const unused = slots.slice(kept.length);

    return {
      pairs: map.pairs, slots, kept, assign, unused, warnings,
      dropped: [...dropped].map(p => ({ play: p, name: dBook.plays[p].name, kind: kindOf(p), formations: map.pairs.filter(({ d }) => menus.get(d).includes(p)).map(({ d }) => dBook.formations[d].name) })),
      summary: {
        targetBook: tBook.bookName, donorBook: dBook.bookName,
        formations: map.pairs.map(({ t, d }) => ({ from: tBook.formations[t].name, to: dBook.formations[d].name, calls: menus.get(d).filter(p => !dropped.has(p)).length })),
        donorCalls: dPlays.length, keptCalls: kept.length, targetSlots: slots.length,
        untouched: map.untouched, notBrought: map.notBrought,
      },
    };
  }

  // Rebuilds the step pool from step 0: every chain in use is written once. A chain identical to one
  // already written, or to the start of one, shares it from the same first step (as in the game's own
  // books), so the pool still splits at chain starts into pieces that each end on an end marker.
  function rebuildNodePool(out, chainsOf, playCount) {
    const pool = [];               // node byte arrays (8 bytes each)
    const byFirst = new Map();     // first node -> positions where a chain starts with it
    const key = n => Array.from(n).join(',');
    function place(nodes) {
      const keys = nodes.map(key);
      for (const pos of byFirst.get(keys[0]) || []) {
        if (pos + nodes.length <= pool.length && keys.every((k, i) => key(pool[pos + i]) === k)) return pos;
      }
      const pos = pool.length;
      nodes.forEach(n => pool.push(n));
      if (!byFirst.has(keys[0])) byFirst.set(keys[0], []);
      byFirst.get(keys[0]).push(pos);
      return pos;
    }
    const starts = [];
    for (let p = 0; p < playCount; p++) starts.push(chainsOf(p).map(c => place(c.nodes)));
    if (pool.length > NODE_CAPACITY) return { error: `The swapped book would need ${pool.length} steps (the limit is ${NODE_CAPACITY}).` };
    out.fill(0, NODE_BASE, NODE_BASE + NODE_CAPACITY * NODE_SIZE);
    pool.forEach((n, i) => out.set(n, NODE_BASE + i * NODE_SIZE));
    putU32(out, 0x40, pool.length);
    for (let p = 0; p < playCount; p++) {
      chainsOf(p).forEach((c, s) => {
        putU32(out, playOff(p) + 8 + s * 8, c.desc);
        pointTo(out, playOff(p) + 0x0C + s * 8, NODE_BASE + starts[p][s] * NODE_SIZE);
      });
    }
    return { steps: pool.length };
  }

  function rawChains(b, p) {
    return BookEdit.readAssignments(b, p).map(a => ({
      desc: a.desc,
      nodes: a.nodes.map((n, k) => b.slice(NODE_BASE + (a.start + k) * NODE_SIZE, NODE_BASE + (a.start + k + 1) * NODE_SIZE)),
    }));
  }

  // Applies a plan from planDefenseSwap. Returns { body, report } or { error }.
  function applyDefenseSwap(target, donor, plan) {
    const tBook = BookEdit.parseBook(target), dBook = BookEdit.parseBook(donor);
    const out = target.slice();
    const donorOf = new Map([...plan.assign].map(([d, t]) => [t, d]));

    // 1. Play records: flags from the donor (name, descriptors and pointers are set below).
    for (const [d, t] of plan.assign) out.set(donor.subarray(playOff(d) + 4, playOff(d) + 8), playOff(t) + 4);

    // 2. Step pool: unchanged chains for every other play, the donor's chains for swapped ones.
    const built = rebuildNodePool(out, p => (donorOf.has(p) ? rawChains(donor, donorOf.get(p)) : rawChains(target, p)), tBook.plays.length);
    if (built.error) return { error: built.error };

    // 3. Formations, their menus and packages.
    const linkPos = new Map(); // donor formation -> Map(donor menu position -> new position)
    for (const { t, d } of plan.pairs) {
      out.set(donor.subarray(formationOff(d) + 4, formationOff(d) + FORMATION_SIZE), formationOff(t) + 4);
      const positions = new Map();
      let n = 0;
      for (let l = 0; l < LINKS; l++) {
        const v = link(donor, d, l), p = v & 0x1FF;
        if (p === 0x1FF || !plan.assign.has(p)) continue;
        const packed = (v & ~0x1FF) | plan.assign.get(p);
        out[auxOff(t) + n * 2] = packed & 255; out[auxOff(t) + n * 2 + 1] = packed >> 8;
        positions.set(l, n++);
      }
      for (; n < LINKS; n++) { out[auxOff(t) + n * 2] = EMPTY_LINK & 255; out[auxOff(t) + n * 2 + 1] = EMPTY_LINK >> 8; }
      linkPos.set(d, positions);
      const cat = BookEdit.formationPackages(target, t).def, dCat = BookEdit.formationPackages(donor, d).def;
      out.set(donor.subarray(categoryOff(dCat) + 4, categoryOff(dCat) + CATEGORY_SIZE), categoryOff(cat) + 4);
      putU32(out, auxOff(t) + 0x48, ((u32(out, auxOff(t) + 0x48) & ~0x3F) | cat) >>> 0);
      putU32(out, auxOff(t) + 0x4C, (1 << cat) >>> 0);
    }

    // 4. Default defensive audibles: the donor's, pointed at the same calls in their new places.
    const tOf = new Map(plan.pairs.map(({ t, d }) => [d, t]));
    for (let i = 0; i < 5; i++) {
      const f = donor[DEFENSE_AUDIBLES + i * 2], l = donor[DEFENSE_AUDIBLES + i * 2 + 1];
      if (tOf.has(f) && linkPos.get(f).has(l)) { out[DEFENSE_AUDIBLES + i * 2] = tOf.get(f); out[DEFENSE_AUDIBLES + i * 2 + 1] = linkPos.get(f).get(l); }
    }

    // 5. Names: reuse an identical existing string, else write it into the empty name space.
    const count = u32(out, NAME_COUNT), poolEnd = NAME_POOL + count * 2;
    const existing = new Map();
    for (let o = NAME_POOL, start = NAME_POOL, s = ''; o < poolEnd; o += 2) {
      const c = out[o] | (out[o + 1] << 8);
      if (c) s += String.fromCharCode(c); else { if (s && !existing.has(s)) existing.set(s, start); s = ''; start = o + 2; }
    }
    let last = -1;
    for (let o = NAME_LIMIT - 1; o >= poolEnd; o--) if (out[o]) { last = o; break; }
    let cursor = last < 0 ? poolEnd : last + 1 + ((last + 1) % 2) + 2;
    const written = new Map();
    function nameAt(text) {
      if (existing.has(text)) return existing.get(text);
      if (written.has(text)) return written.get(text);
      const bytes = (text.length + 1) * 2;
      if (cursor + bytes > NAME_LIMIT) throw new Error('The donor\'s names do not fit in this book\'s spare name space.');
      for (let i = 0; i < text.length; i++) { out[cursor + i * 2] = text.charCodeAt(i) & 255; out[cursor + i * 2 + 1] = text.charCodeAt(i) >> 8; }
      written.set(text, cursor);
      cursor += bytes;
      return written.get(text);
    }
    try {
      for (const [d, t] of plan.assign) pointTo(out, playOff(t), nameAt(dBook.plays[d].name));
      for (const { t, d } of plan.pairs) {
        pointTo(out, formationOff(t), nameAt(dBook.formations[d].name));
        const cat = BookEdit.formationPackages(target, t).def, dCat = BookEdit.formationPackages(donor, d).def;
        pointTo(out, categoryOff(cat), nameAt(dBook.categories[dCat].name));
      }
    } catch (e) { return { error: e.message }; }
    if (written.size) putU32(out, NAME_COUNT, (cursor - NAME_POOL) / 2);

    // 6. Checks: every play passes the game's check, and nothing outside the defense changed.
    const after = BookEdit.parseBook(out);
    for (const p of after.plays) {
      const err = BookEdit.validate(out, p.index);
      if (err) return { error: `Swap refused: “${after.plays[p.index].name}” would fail the game's check (${err}).` };
    }
    const same = (p, q) => JSON.stringify(rawChains(target, p).map(c => [c.desc, c.nodes.map(n => Array.from(n))])) ===
      JSON.stringify(rawChains(out, q).map(c => [c.desc, c.nodes.map(n => Array.from(n))]));
    for (const p of tBook.plays) {
      if (donorOf.has(p.index)) continue;
      if (!same(p.index, p.index) || u32(target, playOff(p.index) + 4) !== u32(out, playOff(p.index) + 4) ||
          after.plays[p.index].name !== p.name) return { error: `Swap refused: it would have changed “${p.name}”.` };
    }
    for (const [d, t] of plan.assign) {
      const a = JSON.stringify(rawChains(donor, d).map(c => [c.desc, c.nodes.map(n => Array.from(n))]));
      const b = JSON.stringify(rawChains(out, t).map(c => [c.desc, c.nodes.map(n => Array.from(n))]));
      if (a !== b || after.plays[t].name !== dBook.plays[d].name) return { error: `Swap refused: “${dBook.plays[d].name}” was not copied exactly.` };
    }
    const tDef = new Set(plan.pairs.map(p => p.t));
    for (const f of tBook.formations) {
      if (tDef.has(f.index)) continue;
      for (let i = 4; i < FORMATION_SIZE; i++) if (out[formationOff(f.index) + i] !== target[formationOff(f.index) + i]) return { error: `Swap refused: it would have changed formation “${f.name}”.` };
      for (let i = 0; i < AUX_SIZE; i++) if (out[auxOff(f.index) + i] !== target[auxOff(f.index) + i]) return { error: `Swap refused: it would have changed the menu of “${f.name}”.` };
    }
    for (let o = 0x4C; o < DEFENSE_AUDIBLES; o++) if (out[o] !== target[o]) return { error: 'Swap refused: it would have changed the offensive audibles.' };
    if (out[0x13380] !== target[0x13380]) return { error: 'Swap refused: it would have changed the end marker.' };

    return {
      body: out,
      report: { ...plan.summary, steps: built.steps, stepsBefore: tBook.nodeCount, namesWritten: written.size, dropped: plan.dropped },
    };
  }

  const api = { mapFormations, planDefenseSwap, applyDefenseSwap, rebuildNodePool };
  root.DefenseSwap = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
