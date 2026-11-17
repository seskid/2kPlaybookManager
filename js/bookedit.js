// Playbook model for viewing and editing existing plays in place.
// Edits only change operand bits of existing steps (never opcodes, flags or step counts). When an
// edited player's steps are shared with other plays, that player first gets a private copy appended
// to the node pool, so only the chosen play changes. Every edit must pass the game's validator.
(function (root) {
  'use strict';

  const Codec = root.PlayCodec || (typeof require !== 'undefined' && require('./playcodec.js'));
  const Playbook = root.Playbook || (typeof require !== 'undefined' && require('./playbook.js'));
  const { u32, putU32 } = Playbook;
  const { FT_CM, YD_CM, SLOT_COUNT } = Codec;

  const FORMATION_BASE = 0x134, FORMATION_SIZE = 0xB4, FORMATION_AUX_BASE = 0x245C, FORMATION_AUX_SIZE = 0x50;
  const PLAY_BASE = 0x33FC, PLAY_SIZE = 0x60, CATEGORY_BASE = 0x993C, CATEGORY_SIZE = 0x10;
  const NODE_BASE = 0x9ADC, NODE_SIZE = 8, NODE_CAPACITY = (0x1083C - NODE_BASE) / NODE_SIZE; // 3500
  const NODE_COUNT_FIELD = 0x40;

  const i32 = (b, o) => u32(b, o) | 0;
  const i16 = (b, o) => { const v = b[o] | (b[o + 1] << 8); return v >= 0x8000 ? v - 0x10000 : v; };
  // Relative pointers resolve to field - 1 + signed value.
  const resolve = (b, field) => field - 1 + i32(b, field);
  const pointTo = (b, field, target) => putU32(b, field, (target - field + 1) >>> 0);

  function utf16At(b, o) {
    let s = '';
    for (; o + 1 < b.length; o += 2) {
      const c = b[o] | (b[o + 1] << 8);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  function playKind(flags, family) {
    if (family === 1) return 'defense';
    if (family !== 0) return 'other';
    if ((flags & 0x6000) === 0x6000) return 'pass';
    if (flags & 0x8000) return 'run';
    return 'other';
  }

  // ------------------------------------------------------------ reading
  function parseBook(body) {
    const formationCount = u32(body, 0x34), playCount = u32(body, 0x38), categoryCount = u32(body, 0x3C);
    const categories = [];
    for (let c = 0; c < categoryCount; c++) {
      const off = CATEGORY_BASE + c * CATEGORY_SIZE;
      categories.push({ index: c, name: utf16At(body, resolve(body, off)), positions: Array.from(body.subarray(off + 5, off + 16)) });
    }
    const plays = [];
    for (let p = 0; p < playCount; p++) {
      const off = PLAY_BASE + p * PLAY_SIZE, flags = u32(body, off + 4), family = (flags >> 6) & 7;
      plays.push({ index: p, name: utf16At(body, resolve(body, off)), flags, family, kind: playKind(flags, family), formations: [] });
    }
    const formations = [];
    for (let f = 0; f < formationCount; f++) {
      const off = FORMATION_BASE + f * FORMATION_SIZE, aux = FORMATION_AUX_BASE + f * FORMATION_AUX_SIZE;
      const flags = u32(body, off + 4);
      const slots = [];
      for (let s = 0; s < SLOT_COUNT; s++) {
        const r = off + 0x1A + s * 14;
        slots.push({ x: i16(body, r + 2), z: i16(body, r + 8) });
      }
      const links = [];
      for (let l = 0; l < 36; l++) {
        const play = (body[aux + l * 2] | (body[aux + l * 2 + 1] << 8)) & 0x1FF;
        if (play !== 0x1FF && play < playCount) { links.push(play); plays[play].formations.push(f); }
      }
      const categoryIndex = u32(body, aux + 0x48) & 0x3F;
      const category = categories[categoryIndex];
      formations.push({
        index: f, name: utf16At(body, resolve(body, off)), typeCode: (flags >> 8) & 0x3F, slots, links,
        categoryIndex, positions: category ? category.positions : new Array(SLOT_COUNT).fill(0),
      });
    }
    return { bookName: utf16At(body, resolve(body, 0x30)), formations, plays, categories, nodeCount: u32(body, NODE_COUNT_FIELD) };
  }

  // The 11 assignments of a play: { desc, start (node index), nodes: [{op, flags, packed}] }.
  function readAssignments(body, playIndex) {
    const off = PLAY_BASE + playIndex * PLAY_SIZE;
    const out = [];
    for (let s = 0; s < SLOT_COUNT; s++) {
      const desc = u32(body, off + 8 + s * 8);
      const start = (resolve(body, off + 0x0C + s * 8) - NODE_BASE) / NODE_SIZE;
      const nodes = [];
      for (let k = 0; k < (desc & 0xF); k++) nodes.push(Codec.readNode(body, NODE_BASE + (start + k) * NODE_SIZE));
      out.push({ desc, start, nodes });
    }
    return out;
  }

  function playFlags(body, playIndex) { return u32(body, PLAY_BASE + playIndex * PLAY_SIZE + 4); }

  function validate(body, playIndex) {
    return Codec.validatePlay(playFlags(body, playIndex), readAssignments(body, playIndex));
  }

  // Every (play, slot) span, for sharing checks and garbage collection.
  function allSpans(body) {
    const spans = [], playCount = u32(body, 0x38);
    for (let p = 0; p < playCount; p++) {
      const off = PLAY_BASE + p * PLAY_SIZE;
      for (let s = 0; s < SLOT_COUNT; s++) {
        const len = u32(body, off + 8 + s * 8) & 0xF;
        const start = (resolve(body, off + 0x0C + s * 8) - NODE_BASE) / NODE_SIZE;
        spans.push({ play: p, slot: s, start, end: start + len });
      }
    }
    return spans;
  }

  // Other plays/slots whose steps overlap this assignment's steps.
  function sharedWith(body, playIndex, slot) {
    const spans = allSpans(body);
    const me = spans.find(x => x.play === playIndex && x.slot === slot);
    return spans.filter(x => (x.play !== playIndex || x.slot !== slot) && x.start < me.end && me.start < x.end);
  }

  // ------------------------------------------------------------ editable fields
  // Only fields whose meaning is known are exposed. Each patches a bit range of the packed word.
  const ROUTE_TYPES_EDITABLE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11];
  const LEG_TYPES_EDITABLE = [0, 1, 2, 3, 4];
  const optionsFrom = (map, keys) => keys.map(k => ({ value: k, label: map[k] }));

  // Defensive rush lanes 0-16 sit across the line at the retail lane table's x (0 = far left,
  // 8 = over the ball, 16 = far right); the game mirrors them as 16 - lane.
  const RUSH_LANE_OPTIONS = Codec.LANE_TABLE_CM.map((cm, v) => {
    const yd = Math.round(cm / YD_CM * 10) / 10;
    return { value: v, label: v === 8 ? '8 · over the ball' : `${v} · ${Math.abs(yd)} yd ${yd < 0 ? 'left' : 'right'}` };
  });

  const timeField = (key, label, lo) => ({ key, label, kind: 'time', lo, n: 6, min: 0, max: 6.3, step: 0.1 });
  const xField = { key: 'x', label: 'Sideways (yd, + = right)', kind: 'x', lo: 24, n: 8, min: -42.6, max: 42.3, step: 1 / 3 };
  // Stock run plays pair lanes 1-4 with runs to the right and 5-8 with runs to the left.
  const LANE_LABELS = { 1: '1 · outside right', 2: '2 · right', 3: '3 · right', 4: '4 · just right of center',
    5: '5 · just left of center', 6: '6 · left', 7: '7 · left', 8: '8 · outside left' };
  const yField = (label, min, max) => ({ key: 'y', label, kind: 'y', lo: 16, n: 8, min, max, step: 1 / 3 });

  // Returns the editable fields for a node, given its current packed value.
  function editableFields(node) {
    const p = node.packed, b = (lo, n) => Codec.bits(p, lo, n);
    switch (node.op) {
      case 0x01: return [timeField('delay', 'Start delay (s)', 2)];
      case 0x04: return b(0, 2) === 0 ? [{ ...yField('Drop depth (yd)', -20, 0), key: 'drop' }] : [];
      case 0x11: {
        const leg = b(0, 5) % 10;
        const fields = [];
        if (LEG_TYPES_EDITABLE.includes(leg)) fields.push({ key: 'leg', label: 'Block type', kind: 'leg', lo: 0, n: 5, options: optionsFrom(Codec.BLOCK_LEG_TYPES, LEG_TYPES_EDITABLE) });
        fields.push(timeField('time', 'Delay (s)', 6));
        fields.push({ key: 'turn', label: 'Turn', kind: 'int', lo: 14, n: 2, options: optionsFrom(Codec.LEG_TURN, [2, 0, 1]) });
        if (leg !== 8 && leg !== 9) fields.push(xField, yField('Downfield (yd)', -21.3, 63.6));
        return fields;
      }
      case 0x12: {
        const t = b(0, 4);
        if (t === 9) return [];
        return [
          { key: 'route', label: 'Route', kind: 'int', lo: 0, n: 4, options: optionsFrom(Codec.ROUTE_SEGMENT_TYPES, ROUTE_TYPES_EDITABLE) },
          { key: 'dist', label: 'Distance (yd)', kind: 'y', lo: 24, n: 8, min: 0, max: 63.6, step: 1 / 3 },
        ];
      }
      case 0x15: return b(14, 2) === 2 ? [] : [xField, yField('Downfield (yd)', -21.3, 63.6)];
      case 0x16: return b(28, 4) === 0 ? [timeField('time', 'Delay (s)', 4)] : [
        { key: 'lane', label: 'Aim lane', kind: 'lane', lo: 28, n: 4, options: [1, 2, 3, 4, 5, 6, 7, 8].map(v => ({ value: v, label: LANE_LABELS[v] })) },
        timeField('time', 'Delay (s)', 4),
      ];
      case 0x18: case 0x09: return [xField, yField('Downfield (yd)', -21.3, 63.6)];
      // Defense
      case 0x0B: case 0x0C: return b(27, 5) === 0x11 ? [timeField('time', 'Delay (s)', 4)] : [
        { key: 'rushlane', label: 'Rush gap', kind: 'rushlane', lo: 27, n: 5, options: RUSH_LANE_OPTIONS },
        timeField('time', 'Delay (s)', 4),
      ];
      case 0x0D: return [
        { ...xField, label: 'Zone spot sideways (yd, + = right)' },
        yField('Zone depth (yd)', -10, 40),
      ];
      case 0x0E: return [{ key: 'cushion', label: 'Cushion (yd)', kind: 'y', lo: 4, n: 8, min: -2, max: 15, step: 1 / 3 }];
      default: return [];
    }
  }

  // Field value in user units (yards, seconds, or an option value).
  function fieldValue(node, field) {
    const raw = Codec.bits(node.packed, field.lo, field.n);
    if (field.kind === 'time') return raw / 10;
    if (field.kind === 'x') return (raw - 0x80) / 3;
    if (field.kind === 'y') return (raw - 0x40) / 3;
    if (field.kind === 'leg') return raw % 10;
    return raw;
  }

  function rawFromValue(node, field, value) {
    const v = Number(value);
    if (!Number.isFinite(v)) throw new Error(`${field.label}: enter a number.`);
    if (field.options && !field.options.some(o => o.value === v)) throw new Error(`${field.label}: choose one of the listed options.`);
    if (field.min !== undefined && (v < field.min - 1e-9 || v > field.max + 1e-9)) {
      throw new Error(`${field.label}: must be between ${field.min} and ${field.max}.`);
    }
    if (field.kind === 'time') return Math.round(v * 10);
    if (field.kind === 'x') return Math.round(v * 3) + 0x80;
    if (field.kind === 'y') return Math.round(v * 3) + 0x40;
    if (field.kind === 'leg') {
      const group = Math.floor(Codec.bits(node.packed, 0, 5) / 10);
      return v + 10 * group;
    }
    return v;
  }

  function patchBits(packed, lo, n, raw) {
    const span = 2 ** n, base = 2 ** lo;
    const cleared = packed - (Math.floor(packed / base) % span) * base;
    return cleared + (raw % span) * base;
  }

  // ------------------------------------------------------------ editing
  // Appended private copies live above the loaded book's node count; drop any no longer referenced.
  function collectGarbage(body, baseCount) {
    const count = u32(body, NODE_COUNT_FIELD);
    if (count <= baseCount) return;
    // Keep surviving copies in their current order so they only move when something before them is freed.
    const spans = allSpans(body).filter(x => x.start >= baseCount).sort((a, b) => a.start - b.start);
    const old = body.slice(NODE_BASE + baseCount * NODE_SIZE, NODE_BASE + count * NODE_SIZE);
    body.fill(0, NODE_BASE + baseCount * NODE_SIZE, NODE_BASE + count * NODE_SIZE);
    let next = baseCount;
    const moved = new Map();
    for (const s of spans) {
      const key = `${s.start}:${s.end}`;
      if (!moved.has(key)) {
        const from = (s.start - baseCount) * NODE_SIZE, len = (s.end - s.start) * NODE_SIZE;
        body.set(old.subarray(from, from + len), NODE_BASE + next * NODE_SIZE);
        moved.set(key, next);
        next += s.end - s.start;
      }
      pointTo(body, PLAY_BASE + s.play * PLAY_SIZE + 0x0C + s.slot * 8, NODE_BASE + moved.get(key) * NODE_SIZE);
    }
    putU32(body, NODE_COUNT_FIELD, next);
  }

  // Applies one field edit. Returns { body, copied } on success or { error } (book unchanged).
  function applyEdit(body, baseCount, playIndex, slot, nodeIndex, fieldKey, value) {
    const out = body.slice();
    const ptrField = PLAY_BASE + playIndex * PLAY_SIZE + 0x0C + slot * 8;
    const descField = ptrField - 4;
    const len = u32(out, descField) & 0xF;
    let start = (resolve(out, ptrField) - NODE_BASE) / NODE_SIZE;
    if (nodeIndex < 0 || nodeIndex >= len) return { error: 'That step does not exist.' };

    const node = Codec.readNode(out, NODE_BASE + (start + nodeIndex) * NODE_SIZE);
    const field = editableFields(node).find(f => f.key === fieldKey);
    if (!field) return { error: 'That value cannot be edited.' };
    let raw;
    try { raw = rawFromValue(node, field, value); } catch (e) { return { error: e.message }; }
    if (raw === Codec.bits(node.packed, field.lo, field.n)) return { body, copied: false, unchanged: true };

    let copied = false;
    if (sharedWith(out, playIndex, slot).length) {
      const count = u32(out, NODE_COUNT_FIELD);
      if (count + len > NODE_CAPACITY) return { error: `Not enough spare steps in this book to make a private copy (${NODE_CAPACITY - count} left, ${len} needed).` };
      out.copyWithin(NODE_BASE + count * NODE_SIZE, NODE_BASE + start * NODE_SIZE, NODE_BASE + (start + len) * NODE_SIZE);
      putU32(out, NODE_COUNT_FIELD, count + len);
      pointTo(out, ptrField, NODE_BASE + count * NODE_SIZE);
      start = count;
      copied = true;
    }
    putU32(out, NODE_BASE + (start + nodeIndex) * NODE_SIZE + 4, patchBits(node.packed, field.lo, field.n, raw) >>> 0);

    const flags = playFlags(out, playIndex);
    const assignments = readAssignments(out, playIndex);
    putU32(out, descField, Codec.refreshDescriptor(flags, assignments, slot));
    const error = validate(out, playIndex);
    if (error) return { error: `The game would reject this change (${error}).` };
    collectGarbage(out, baseCount);
    return { body: out, copied };
  }

  // ------------------------------------------------------------ ball carrier
  // A run with one handoff: the passer's Hand Off To step names the slot whose chain holds Take Handoff.
  // Changing the carrier swaps the two players' whole assignments inside this play's record (each
  // chain and descriptor moves intact, nothing is created) and re-aims every step that names either slot.
  function handoffInfo(asg) {
    const takers = [], givers = [];
    asg.forEach((a, s) => a.nodes.forEach(n => { if (n.op === 0x16) takers.push(s); if (n.op === 0x13) givers.push(s); }));
    if (takers.length !== 1 || givers.length !== 1 || takers[0] === givers[0]) return null;
    return { carrier: takers[0], passer: givers[0] };
  }

  // Gives (play, slot) steps of its own, appended to the pool, when they are shared with other plays.
  function ownSteps(out, playIndex, slot) {
    const ptrField = PLAY_BASE + playIndex * PLAY_SIZE + 0x0C + slot * 8;
    const len = u32(out, ptrField - 4) & 0xF;
    const start = (resolve(out, ptrField) - NODE_BASE) / NODE_SIZE;
    if (!sharedWith(out, playIndex, slot).length) return start;
    const count = u32(out, NODE_COUNT_FIELD);
    if (count + len > NODE_CAPACITY) return -1;
    out.copyWithin(NODE_BASE + count * NODE_SIZE, NODE_BASE + start * NODE_SIZE, NODE_BASE + (start + len) * NODE_SIZE);
    putU32(out, NODE_COUNT_FIELD, count + len);
    pointTo(out, ptrField, NODE_BASE + count * NODE_SIZE);
    return count;
  }

  function setCarrier(body, baseCount, playIndex, toSlot) {
    const info = handoffInfo(readAssignments(body, playIndex));
    if (!info) return { error: 'This play has no single handoff to move.' };
    const { carrier, passer } = info;
    if (toSlot === carrier) return { body, unchanged: true };
    if (toSlot === passer || toSlot < 0 || toSlot >= SLOT_COUNT) return { error: 'That player cannot take the handoff.' };
    const out = body.slice();
    const field = s => PLAY_BASE + playIndex * PLAY_SIZE + 8 + s * 8;
    const a = field(carrier), b = field(toSlot);
    const descA = u32(out, a), ptrA = resolve(out, a + 4), descB = u32(out, b), ptrB = resolve(out, b + 4);
    putU32(out, a, descB); pointTo(out, a + 4, ptrB);
    putU32(out, b, descA); pointTo(out, b + 4, ptrA);

    const swap = t => (t === carrier ? toSlot : t === toSlot ? carrier : t);
    for (let s = 0; s < SLOT_COUNT; s++) {
      const nodes = readAssignments(out, playIndex)[s].nodes;
      const edits = [];
      nodes.forEach((n, k) => {
        const v = Codec.nodeOperands(n);
        if (n.op === 0x13 || n.op === 0x14) { if (swap(v[0]) !== v[0]) edits.push([k, 0, swap(v[0])]); }
        else if (n.op === 0x15 && v[0] === 2) { if (swap(v[5]) !== v[5]) edits.push([k, 4, swap(v[5])]); }
        else if (n.op === 0x1A && [2, 3, 5, 6].includes(v[0]) && swap(v[3]) !== v[3]) edits.push(null);
      });
      if (edits.includes(null)) return { error: 'Another player\'s motion is tied to one of these two players.' };
      if (!edits.length) continue;
      const start = ownSteps(out, playIndex, s);
      if (start < 0) return { error: 'Not enough spare steps in this book to make a private copy.' };
      for (const [k, lo, t] of edits) {
        const at = NODE_BASE + (start + k) * NODE_SIZE + 4;
        putU32(out, at, patchBits(u32(out, at), lo, 4, t) >>> 0);
      }
    }
    const error = validate(out, playIndex);
    if (error) return { error: `The game would reject this change (${error}).` };
    collectGarbage(out, baseCount);
    return { body: out };
  }

  // Slots that could take this play's handoff (the game's own check decides), or [] if it has none.
  function carrierOptions(body, baseCount, playIndex) {
    const info = handoffInfo(readAssignments(body, playIndex));
    if (!info) return { current: -1, slots: [] };
    const slots = [];
    for (let s = 0; s < SLOT_COUNT; s++) if (s !== info.carrier && s !== info.passer && !setCarrier(body, baseCount, playIndex, s).error) slots.push(s);
    return { current: info.carrier, slots };
  }

  // Restores a play's record and its own (unshared) steps from the original book.
  function resetPlay(body, original, baseCount, playIndex) {
    const out = body.slice();
    const off = PLAY_BASE + playIndex * PLAY_SIZE;
    out.set(original.subarray(off, off + PLAY_SIZE), off);
    for (const a of readAssignments(original, playIndex)) {
      const from = NODE_BASE + a.start * NODE_SIZE, to = from + a.nodes.length * NODE_SIZE;
      out.set(original.subarray(from, to), from);
    }
    collectGarbage(out, baseCount);
    return out;
  }

  // Defensive role of a play: a front (rushers), a coverage (zone/man), or both.
  function defenseKind(body, playIndex) {
    let rush = false, cover = false;
    for (const a of readAssignments(body, playIndex)) {
      for (const n of a.nodes) {
        if (n.op === 0x0B || n.op === 0x0C) rush = true;
        if (n.op === 0x0D || n.op === 0x0E) cover = true;
      }
    }
    return rush && cover ? 'both' : rush ? 'front' : 'cover';
  }

  // A defender with only Start steps is not part of this call; the paired front/coverage sets him.
  const isPlaceholder = assignment => assignment.nodes.every(n => n.op === 0x01);

  // ------------------------------------------------------------ defensive job changes
  // A defender's job can be swapped for the job the same player (same slot) has in another call
  // of the same formation, by pointing him at that call's existing steps. Nothing is created.
  // On the field a coverage overrides the front for every defender it assigns, so jobs change in
  // coverages and blitzes only; a front only assigns the line.
  function jobOf(assignment) {
    if (isPlaceholder(assignment)) return 'front';
    const ops = assignment.nodes.map(n => n.op);
    const zone = ops.includes(0x0D), man = ops.includes(0x0E);
    if (zone && man) return 'combo';
    if (ops.includes(0x0B) || ops.includes(0x0C)) return 'rush';
    return zone ? 'zone' : man ? 'man' : 'other';
  }

  const signature = a => a.nodes.map(n => `${n.op}:${n.flags}:${n.packed}`).join('|');

  // Slots that some front of this formation assigns (normally the defensive line).
  // kindOf(playIndex) classifies plays as loaded, so a coverage turned into an all-out blitz
  // still counts as a coverage; it defaults to classifying the current body.
  function frontSlots(body, book, formationIndex, kindOf) {
    const slots = new Set();
    for (const p of book.formations[formationIndex].links.map(i => book.plays[i])) {
      if (p.kind !== 'defense' || kindOf(p.index) !== 'front') continue;
      readAssignments(body, p.index).forEach((a, s) => { if (!isPlaceholder(a)) slots.add(s); });
    }
    return slots;
  }

  // Jobs this defender could take in this call: [{ donorPlay, job, assignment }], one per distinct job.
  function jobOptions(body, book, formationIndex, playIndex, slot, kindOf) {
    kindOf = kindOf || (p => defenseKind(body, p));
    const play = book.plays[playIndex];
    if (play.kind !== 'defense' || kindOf(playIndex) === 'front') return [];
    const current = signature(readAssignments(body, playIndex)[slot]);
    // One play can be listed under several formations (e.g. 4-3, Nickel and Dime), and a slot can be
    // a different player in each (OLB in 4-3, CB3 in Nickel). A job change applies in all of them, so
    // donors must be calls used by every one of those formations: their job for this slot was written
    // by the game for each formation's player. Likewise "leave to the front" needs a front in each.
    const formations = [...new Set(play.formations.length ? play.formations : [formationIndex])];
    const covered = formations.map(f => frontSlots(body, book, f, kindOf));
    const seen = new Set([current]), out = [];
    for (const donor of book.formations[formationIndex].links.map(i => book.plays[i])) {
      if (donor.kind !== 'defense' || donor.index === playIndex) continue;
      if (!formations.every(f => donor.formations.includes(f))) continue;
      const a = readAssignments(body, donor.index)[slot];
      const key = signature(a), job = jobOf(a);
      if (seen.has(key) || job === 'combo' || job === 'other') continue;
      if (job === 'front' && !covered.every(c => c.has(slot))) continue; // nobody else would cover him
      seen.add(key);
      out.push({ donorPlay: donor.index, job, assignment: a });
    }
    const order = { rush: 0, zone: 1, man: 2, front: 3 };
    return out.sort((x, y) => order[x.job] - order[y.job]);
  }

  // Gives the defender in (playIndex, slot) the job of the same slot in donorPlay.
  function applyJob(body, book, baseCount, formationIndex, playIndex, slot, donorPlay, kindOf) {
    const option = jobOptions(body, book, formationIndex, playIndex, slot, kindOf).find(o => o.donorPlay === donorPlay);
    if (!option) return { error: 'That job is not available for this player.' };
    const out = body.slice();
    const field = PLAY_BASE + playIndex * PLAY_SIZE + 8 + slot * 8;
    const donorField = PLAY_BASE + donorPlay * PLAY_SIZE + 8 + slot * 8;
    putU32(out, field, u32(body, donorField));
    pointTo(out, field + 4, resolve(body, donorField + 4));
    const error = validate(out, playIndex);
    if (error) return { error: `The game would reject this change (${error}).` };
    collectGarbage(out, baseCount);
    return { body: out };
  }

  // ------------------------------------------------------------ formations (positions and names)
  // A formation record holds eleven 14-byte slot entries at +0x1A: a stance byte, a mirror-partner
  // nibble, then three x and three depth columns (signed cm). Column 0 is the base spot; columns 1-2
  // are the game's alternate spots (pre-snap shifts / walk-ups). Plays attach to slot numbers, so
  // moving a slot never changes a play. Mirror partners are left exactly as the game wrote them.
  const SLOT_BASE = 0x1A, SLOT_STRIDE = 14;
  const NAME_COUNT_FIELD = 0x1083C, NAME_POOL = 0x10840;
  const SIDELINE_CM = 26.6 * YD_CM, LOS_SLACK_CM = 15, SHOTGUN_DEPTH_CM = -250;
  const OFFENSE_LINE_KINDS = [5, 6, 7];

  const isOffenseFormation = typeCode => typeCode < 4 || typeCode === 8 || typeCode === 10 || typeCode === 12;
  const putI16 = (b, o, v) => { const w = Math.max(-32768, Math.min(32767, Math.round(v))) & 0xFFFF; b[o] = w & 255; b[o + 1] = w >> 8; };

  function readSlots(body, formationIndex) {
    const off = FORMATION_BASE + formationIndex * FORMATION_SIZE;
    const slots = [];
    for (let s = 0; s < SLOT_COUNT; s++) {
      const r = off + SLOT_BASE + s * SLOT_STRIDE;
      slots.push({ x: [0, 1, 2].map(k => i16(body, r + 2 + k * 2)), z: [0, 1, 2].map(k => i16(body, r + 8 + k * 2)) });
    }
    return slots;
  }

  // Real-football eligibility for ordinary offensive formations (type 0-3; not kicks or punts).
  // Returns Map(key -> message). Edits may not add a violation; ones already in the game's own
  // formation (e.g. 49 stock formations have a covered receiver) are left alone.
  const ELIGIBLE_KINDS = [8, 9, 10, 11]; // TE, WR, HB, FB
  const BACK_DEPTH_CM = -YD_CM + 6;      // backs must be ~1 yd behind the line (spots are whole cm)
  function eligibilityViolations(spots, codes, typeCode, present) {
    const out = new Map();
    const is = present ? 'is' : 'would be', are = present ? 'are' : 'would be';
    if (typeCode > 3) return out;
    const kind = s => codes[s] & 0x1F, label = s => Codec.positionLabel(codes[s] || 0);
    const all = [...Array(SLOT_COUNT).keys()];
    const onLine = all.filter(s => Math.abs(spots[s].z) <= LOS_SLACK_CM);
    if (onLine.length < 7) out.set('line', `only ${onLine.length} players ${are} on the line of scrimmage (the rules need 7)`);
    for (const s of all) {
      if (kind(s) === 0) continue; // QB
      const z = spots[s].z;
      if (z < -LOS_SLACK_CM && z > BACK_DEPTH_CM) out.set(`gap:${s}`, `${label(s)} ${is} neither on the line nor a full yard behind it`);
      if (OFFENSE_LINE_KINDS.includes(kind(s)) && !onLine.includes(s)) out.set(`ol:${s}`, `${label(s)} must stay on the line`);
    }
    if (onLine.length) {
      const xs = onLine.map(s => spots[s].x), lo = Math.min(...xs), hi = Math.max(...xs);
      for (const s of onLine) {
        if (!ELIGIBLE_KINDS.includes(kind(s)) || spots[s].x === lo || spots[s].x === hi) continue;
        const end = onLine.reduce((best, t) => (spots[t].x === (spots[s].x < 0 ? lo : hi) ? t : best), s);
        out.set(`covered:${s}`, `${label(s)} ${is} covered by ${label(end)} on the line outside him, making him an ineligible receiver`);
      }
    }
    return out;
  }

  // Eligibility problems in `body`'s formation that `base` (the formation before editing) didn't have.
  function addedViolations(base, body, book, formationIndex) {
    const f = book.formations[formationIndex];
    const spots = b => readSlots(b, formationIndex).map(s => ({ x: s.x[0], z: s.z[0] }));
    const before = eligibilityViolations(spots(base), f.positions, f.typeCode, true);
    return [...eligibilityViolations(spots(body), f.positions, f.typeCode, true)].filter(([key]) => !before.has(key)).map(([, m]) => m);
  }

  // Moves a slot's base spot to (xCm, zCm), shifting its alternate spots by the same amount.
  // Returns { body } or { error }. Hard limits always apply; eligibility is checked per move unless
  // { draft: true }, where the caller checks the finished formation with addedViolations instead.
  function moveSlot(body, book, formationIndex, slot, xCm, zCm, opts = {}) {
    const f = book.formations[formationIndex];
    const offense = isOffenseFormation(f.typeCode);
    const cur = readSlots(body, formationIndex)[slot];
    const dx = Math.round(xCm) - cur.x[0], dz = Math.round(zCm) - cur.z[0];
    if (!dx && !dz) return { body, unchanged: true };
    const label = Codec.positionLabel(f.positions[slot] || 0);
    const xs = cur.x.map(v => v + dx), zs = cur.z.map(v => v + dz);
    if (xs.some(v => Math.abs(v) > SIDELINE_CM)) return { error: `${label} would be out of bounds.` };
    if (offense && zs[0] > LOS_SLACK_CM) return { error: `${label} would line up past the line of scrimmage.` };
    if (!offense && zs[0] < -LOS_SLACK_CM) return { error: `${label} would line up on the offense's side of the ball.` };
    if (offense && !opts.draft) {
      const spots = readSlots(body, formationIndex).map(s => ({ x: s.x[0], z: s.z[0] }));
      const before = eligibilityViolations(spots, f.positions, f.typeCode);
      spots[slot] = { x: xs[0], z: zs[0] };
      const added = [...eligibilityViolations(spots, f.positions, f.typeCode)].filter(([key]) => !before.has(key));
      if (added.length) return { error: `Not a legal formation: ${added.map(([, m]) => m).join('; ')}.` };
    }
    const out = body.slice();
    const off = FORMATION_BASE + formationIndex * FORMATION_SIZE;
    const r = off + SLOT_BASE + slot * SLOT_STRIDE;
    xs.forEach((v, k) => putI16(out, r + 2 + k * 2, v));
    zs.forEach((v, k) => putI16(out, r + 8 + k * 2, v));
    // The formation's QB-alignment flag (bit 18 under center, bit 19 shotgun) matches the QB's depth
    // in every stock formation, so keep it in step when the QB moves across the shotgun depth.
    // Plays don't depend on it: stock books link 246 plays to both under-center and gun formations.
    let alignment = null;
    if (offense && (f.positions[slot] & 0x1F) === 0) {
      const gun = zs[0] <= SHOTGUN_DEPTH_CM;
      if (gun !== (cur.z[0] <= SHOTGUN_DEPTH_CM)) {
        const flags = u32(out, off + 4);
        putU32(out, off + 4, ((flags & ~0xC0000) | (gun ? 0x80000 : 0x40000)) >>> 0);
        alignment = gun ? 'shotgun' : 'under center';
      }
    }
    return { body: out, alignment };
  }

  // Football-rule warnings for a formation's base spots (advisory: some stock formations trip them).
  function formationWarnings(body, book, formationIndex, original) {
    const f = book.formations[formationIndex];
    const slots = readSlots(body, formationIndex), codes = f.positions;
    const label = s => Codec.positionLabel(codes[s] || 0);
    const warn = [];
    for (let a = 0; a < SLOT_COUNT; a++) {
      for (let b = a + 1; b < SLOT_COUNT; b++) {
        if (Math.abs(slots[a].x[0] - slots[b].x[0]) < 60 && Math.abs(slots[a].z[0] - slots[b].z[0]) < 60) warn.push(`${label(a)} and ${label(b)} are on top of each other.`);
      }
    }
    // Eligibility problems the game's own formation already had (edits can't add new ones).
    for (const m of eligibilityViolations(slots.map(s => ({ x: s.x[0], z: s.z[0] })), codes, f.typeCode, true).values()) {
      warn.push(`As the game made it: ${m}.`);
    }
    if (original) {
      const was = readSlots(original, formationIndex);
      slots.forEach((s, i) => {
        if (Math.sign(s.x[0]) && Math.sign(was[i].x[0]) && Math.sign(s.x[0]) !== Math.sign(was[i].x[0])) {
          warn.push(`${label(i)} moved to the other side of the ball. Flipped plays pair him with a player on his old side, so a flipped call may line up oddly.`);
        }
      });
    }
    return warn;
  }

  // ------------------------------------------------------------ formation packages (personnel)
  // Who stands in each slot comes from a package (personnel group, "Packages" in the game's custom
  // playbook screen), not from the formation. The formation link record holds its default package
  // (+0x48, low 6 bits) and a mask of every package it can be run with (+0x4C). In stock books 203
  // of 236 offensive formations belong to 2+ packages, and the extras always keep the QB and line.
  const AUX_DEFAULT = 0x48, AUX_MASK = 0x4C;
  const auxOf = fi => FORMATION_AUX_BASE + fi * FORMATION_AUX_SIZE;

  function formationPackages(body, formationIndex) {
    const a = auxOf(formationIndex), mask = u32(body, a + AUX_MASK), count = u32(body, 0x3C);
    return { def: u32(body, a + AUX_DEFAULT) & 0x3F, members: [...Array(Math.min(26, count)).keys()].filter(i => mask & (1 << i)) };
  }

  // A package can be used with this formation when it keeps the QB and all five linemen in the same
  // slots and puts an eligible player (TE, WR, HB, FB) in every skill slot. Plays (slot-based),
  // eligibility and every other formation are then unaffected.
  function packageCompatible(book, formationIndex, cat, body) {
    const def = book.categories[formationPackages(body, formationIndex).def], other = book.categories[cat];
    if (!def || !other) return false;
    const k = (p, s) => p.positions[s] & 0x1F;
    for (let s = 0; s < SLOT_COUNT; s++) {
      if (ELIGIBLE_KINDS.includes(k(def, s))) { if (!ELIGIBLE_KINDS.includes(k(other, s))) return false; }
      else if (k(def, s) !== k(other, s)) return false;
    }
    return true;
  }

  function setPackageMember(body, book, formationIndex, cat, on) {
    const { def, members } = formationPackages(body, formationIndex);
    if (on && !packageCompatible(book, formationIndex, cat, body)) return { error: 'That package does not fit this formation.' };
    if (!on && cat === def) return { error: 'This is the default package. Make another package the default first.' };
    if (on === members.includes(cat)) return { body, unchanged: true };
    const out = body.slice(), a = auxOf(formationIndex) + AUX_MASK;
    putU32(out, a, (on ? u32(out, a) | (1 << cat) : u32(out, a) & ~(1 << cat)) >>> 0);
    return { body: out };
  }

  function setDefaultPackage(body, book, formationIndex, cat) {
    if (!formationPackages(body, formationIndex).members.includes(cat)) return { error: 'Add the package to this formation first.' };
    if (!packageCompatible(book, formationIndex, cat, body)) return { error: 'That package does not fit this formation.' };
    const out = body.slice(), a = auxOf(formationIndex) + AUX_DEFAULT;
    putU32(out, a, ((u32(out, a) & ~0x3F) | cat) >>> 0);
    return { body: out };
  }

  // ------------------------------------------------------------ player substitutions
  // The game stores in-game substitutions (e.g. the backup HB so the starter rests) as a book-level
  // table of u32 entries in the header at 0x6C..0x133 (room for 50), appended in the order made and
  // ended by the first zero entry. Entry = (formation index << 20) | payload, where payload =
  // base(kind) | depth << 15, depth being the replacement's place on the depth chart (0 = 1st .. 3 =
  // 4th). Verified from controlled in-game saves: HB -> HB2 (0x8A82A) and FB -> TE1..TE4
  // (0x8202E, 0x8A02E, 0x9202E, 0x9A02E), each in several formations and packages. Entries of any
  // other kind are preserved untouched.
  const SUB_TABLE = 0x6C, SUB_CAPACITY = 50, DEPTH_MASK = 0x18000, DEPTH_SHIFT = 15;
  // slotKind: the slot that gets replaced (HB 10, FB 11); replaceKind: what the label shows (HB, TE); depths: offered replacement depths.
  const SUB_KINDS = {
    hb: { label: 'Halfback', slotKind: 10, replaceKind: 10, base: 0x8282A, replacement: 'RB', depths: [1, 2, 3], verified: [1] },
    fb: { label: 'Fullback', slotKind: 11, replaceKind: 8, base: 0x8202E, replacement: 'TE', depths: [0, 1, 2, 3], verified: [0, 1, 2, 3] },
  };

  function readSubs(body) {
    const subs = [];
    for (let i = 0; i < SUB_CAPACITY; i++) {
      const raw = u32(body, SUB_TABLE + i * 4);
      if (!raw) break;
      const payload = raw & 0xFFFFF;
      let kind = null, depth = null;
      for (const [k, d] of Object.entries(SUB_KINDS)) {
        if ((payload & ~DEPTH_MASK) === d.base) { kind = k; depth = (payload & DEPTH_MASK) >>> DEPTH_SHIFT; }
      }
      subs.push({ raw, formation: raw >>> 20, payload, kind, depth });
    }
    return subs;
  }

  function writeSubs(body, raws) {
    const out = body.slice();
    for (let i = 0; i < SUB_CAPACITY; i++) putU32(out, SUB_TABLE + i * 4, raws[i] || 0);
    return out;
  }

  // The substitution of one kind in one formation: { depth } or null.
  function formationSub(body, formationIndex, kind) {
    const s = readSubs(body).find(x => x.formation === formationIndex && x.kind === kind);
    return s ? { depth: s.depth } : null;
  }

  // Which substitutions a formation offers: a scrimmage offense (QB in slot 0, so not the kicking
  // units) whose default package has the starting HB / FB in a slot. Only these were seen in-game.
  function subOptions(body, book, formationIndex) {
    const cat = book.categories[formationPackages(body, formationIndex).def];
    if (!cat || cat.positions[0] !== 0) return [];
    return Object.entries(SUB_KINDS)
      .filter(([, d]) => cat.positions.some(p => p === d.slotKind))
      .map(([kind, d]) => ({ kind, ...d, current: formationSub(body, formationIndex, kind) }));
  }

  // depth = null removes the substitution.
  function setFormationSub(body, book, formationIndex, kind, depth) {
    const def = SUB_KINDS[kind];
    if (!def) return { error: 'Unknown substitution.' };
    if (depth !== null && !def.depths.includes(depth)) return { error: 'That depth is not available.' };
    if (!subOptions(body, book, formationIndex).some(o => o.kind === kind)) return { error: `This formation has no ${def.label.toLowerCase()} to replace.` };
    const subs = readSubs(body);
    const keep = subs.filter(x => !(x.formation === formationIndex && x.kind === kind));
    const had = keep.length !== subs.length;
    const same = formationSub(body, formationIndex, kind);
    if ((depth === null && !same) || (same && depth === same.depth)) return { body, unchanged: true };
    const raws = keep.map(x => x.raw);
    if (depth !== null) {
      if (raws.length >= SUB_CAPACITY) return { error: 'The book already holds the maximum of 50 substitutions.' };
      raws.push(((formationIndex << 20) | def.base | (depth << DEPTH_SHIFT)) >>> 0);
    }
    return { body: writeSubs(body, raws), removed: had };
  }

  const formationSubRaws = (body, fi) => readSubs(body).filter(x => x.formation === fi).map(x => x.raw).sort((a, b) => a - b);
  const subsDiffer = (body, original, fi) => {
    const a = formationSubRaws(body, fi), b = formationSubRaws(original, fi);
    return a.length !== b.length || a.some((v, i) => v !== b[i]);
  };

  // Puts one formation's substitutions back as the original had them (other formations untouched).
  function resetFormationSubs(body, original, formationIndex) {
    const mine = x => x.formation === formationIndex;
    const raws = readSubs(body).filter(x => !mine(x)).map(x => x.raw).concat(readSubs(original).filter(mine).map(x => x.raw));
    let out = writeSubs(body, raws);
    // Same set of substitutions as the original: restore its exact order.
    const now = readSubs(out).map(x => x.raw).sort((a, b) => a - b), was = readSubs(original).map(x => x.raw).sort((a, b) => a - b);
    if (now.length === was.length && now.every((v, i) => v === was[i])) out = writeSubs(out, readSubs(original).map(x => x.raw));
    return out;
  }

  function formationEdited(body, original, formationIndex) {
    const off = FORMATION_BASE + formationIndex * FORMATION_SIZE, a = auxOf(formationIndex);
    for (let i = 0; i < FORMATION_SIZE; i++) if (body[off + i] !== original[off + i]) return true;
    for (let i = AUX_DEFAULT; i < AUX_MASK + 4; i++) if (body[a + i] !== original[a + i]) return true;
    return subsDiffer(body, original, formationIndex);
  }

  // Where renamed formations' names go. After the counted name pool, stock books hold a few unused
  // leftover name fragments and, at 0x13380, a 01 marker byte. New names are written only into the
  // empty stretch after the last fragment and well short of the marker; nothing else is touched.
  const NAME_AREA_LIMIT = 0x13380 - 16;
  function nameArea(original) {
    const origCount = u32(original, NAME_COUNT_FIELD), origEnd = NAME_POOL + origCount * 2;
    let last = -1;
    for (let o = NAME_AREA_LIMIT - 1; o >= origEnd; o--) if (original[o]) { last = o; break; }
    const start = last < 0 ? origEnd : (last + 1 + (last + 1) % 2) + 2; // keep a zero character gap
    return { origCount, start };
  }

  // Renamed formations point at names in that area, which is rebuilt on every rename so repeated
  // renames never leak space. Original names are never overwritten. The pool's character count is
  // extended to cover new names (so the game treats them as used) and restored when none remain.
  // Name pointers this editor may change: the book's own name (0x30, shown before a game) and every
  // formation's name.
  const BOOK_NAME_FIELD = 0x30;
  const managedNameFields = book => [BOOK_NAME_FIELD, ...book.formations.map((f, i) => FORMATION_BASE + i * FORMATION_SIZE)];

  function setManagedName(body, original, fields, field, text) {
    const { origCount, start: tailStart } = nameArea(original);
    const out = body.slice();
    // Desired custom names: every managed field currently pointing into the tail, plus this one.
    const custom = new Map();
    for (const f of fields) if (resolve(out, f) >= tailStart) custom.set(f, utf16At(out, resolve(out, f)));
    if (text === utf16At(original, resolve(original, field))) custom.delete(field); else custom.set(field, text);
    // Restore original pointers for fields no longer custom, then rewrite the tail compactly.
    for (const f of fields) if (!custom.has(f)) out.set(original.subarray(f, f + 4), f);
    out.set(original.subarray(tailStart, NAME_AREA_LIMIT), tailStart); // back to the original (empty) bytes
    let pos = tailStart;
    for (const [f, s] of custom) {
      const bytes = (s.length + 1) * 2;
      if (pos + bytes > NAME_AREA_LIMIT) return { error: 'Not enough spare name space in this book.' };
      for (let i = 0; i < s.length; i++) { out[pos + i * 2] = s.charCodeAt(i); out[pos + i * 2 + 1] = 0; }
      pointTo(out, f, pos);
      pos += bytes;
    }
    putU32(out, NAME_COUNT_FIELD, custom.size ? (pos - NAME_POOL) / 2 : origCount);
    return { body: out };
  }

  function setFormationName(body, original, book, formationIndex, name) {
    const text = String(name).trim();
    if (!text) return { error: 'Enter a formation name.' };
    if (text.length > 40) return { error: 'Formation names can be at most 40 characters.' };
    if (!/^[\x20-\x7E]+$/.test(text)) return { error: 'Use plain letters, digits and punctuation in formation names.' };
    return setManagedName(body, original, managedNameFields(book), FORMATION_BASE + formationIndex * FORMATION_SIZE, text);
  }

  // The book's own name, which the game shows when picking playbooks before a game. The game's editor
  // sets it to the name you save under (KCorig1 -> KC341), so saving under a new team code does too.
  function bookName(body) { return utf16At(body, resolve(body, BOOK_NAME_FIELD)); }
  function setBookName(body, original, book, name) {
    const text = String(name).trim();
    if (!/^[A-Za-z0-9]{1,16}$/.test(text)) return { error: 'Book names use 1 to 16 letters or digits.' };
    if (text === bookName(body)) return { body, unchanged: true };
    return setManagedName(body, original, managedNameFields(book), BOOK_NAME_FIELD, text);
  }

  function formationName(body, formationIndex) {
    return utf16At(body, resolve(body, FORMATION_BASE + formationIndex * FORMATION_SIZE));
  }

  // Restores a formation's spots and name.
  function resetFormation(body, original, book, formationIndex) {
    const off = FORMATION_BASE + formationIndex * FORMATION_SIZE;
    const out = body.slice();
    out.set(original.subarray(off + 4, off + FORMATION_SIZE), off + 4); // everything but the name pointer
    const a = auxOf(formationIndex);
    out.set(original.subarray(a + AUX_DEFAULT, a + AUX_MASK + 4), a + AUX_DEFAULT); // packages
    const named = setFormationName(out, original, book, formationIndex, formationName(original, formationIndex)).body;
    return resetFormationSubs(named, original, formationIndex);
  }

  // True when the play's record or any of its steps differ from the original book.
  function isEdited(body, original, playIndex) {
    const off = PLAY_BASE + playIndex * PLAY_SIZE;
    for (let s = 0; s < SLOT_COUNT; s++) {
      if (u32(body, off + 8 + s * 8) !== u32(original, off + 8 + s * 8)) return true;
    }
    const now = readAssignments(body, playIndex), was = readAssignments(original, playIndex);
    return now.some((a, s) => a.nodes.some((n, k) => n.packed !== was[s].nodes[k].packed || n.op !== was[s].nodes[k].op));
  }

  // A flipped (mirrored) play shows sideways values negated, lanes mirrored (9 - lane) and
  // block turns swapped, exactly as the game's decoder mirrors them.
  function displayValue(node, field, flip) {
    const v = fieldValue(node, field);
    if (!flip) return v;
    if (field.kind === 'x') return -v;
    if (field.kind === 'lane') return 9 - v;
    if (field.kind === 'rushlane') return 16 - v;
    if (field.key === 'turn' && (v === 0 || v === 1)) return 1 - v;
    return v;
  }
  function storedValue(field, value, flip) {
    const v = Number(value);
    if (!flip) return v;
    if (field.kind === 'x') return -v;
    if (field.kind === 'lane') return 9 - v;
    if (field.kind === 'rushlane') return 16 - v;
    if (field.key === 'turn' && (v === 0 || v === 1)) return 1 - v;
    return v;
  }

  // Plain-language summary of one step. `labelOf(slot)` names other players; `flip` mirrors left/right.
  function describeNode(node, flip, labelOf) {
    const v = Codec.nodeOperands(node), name = Codec.OPCODE_NAMES[node.op] || `op 0x${node.op.toString(16)}`;
    const num = cm => (Math.abs(cm) / YD_CM).toFixed(1).replace(/\.0$/, '');
    const across = cm => (Math.abs(cm) < 15 ? '' : `${num(cm)} yd ${(cm > 0) !== !!flip ? 'right' : 'left'}`);
    const down = cm => (Math.abs(cm) < 15 ? '' : `${num(cm)} yd ${cm > 0 ? 'downfield' : 'back'}`);
    const both = (x, y) => [across(x), down(y)].filter(Boolean).join(', ') || 'in place';
    const who = s => (labelOf ? `${labelOf(s)} (slot ${s})` : `slot ${s}`);
    const lane = l => (flip ? 9 - l : l);
    switch (node.op) {
      case 0x01: return v[3] ? `Start (wait ${v[3].toFixed(1)} s)` : 'Start';
      case 0x02: return `Snap to ${who(v[0])}`;
      case 0x03: return 'Take the snap';
      case 0x04: return v[0] === 0 ? `Drop back ${num(-v[2])} yd` : `Special move (mode ${v[0]})`;
      case 0x06: return 'Pass';
      case 0x09: return `Run to point (${both(v[1], v[2])})`;
      case 0x11: {
        const angle = v[4] === 0 || v[4] === 1 ? `, angled ${(v[4] === 0) !== !!flip ? 'left' : 'right'}` : '';
        return `${Codec.BLOCK_LEG_TYPES[v[0]] || 'Block'}${v[0] === 8 || v[0] === 9 ? '' : ` (${both(v[5], v[6])})`}${angle}${v[1] ? `, wait ${v[1].toFixed(1)} s` : ''}`;
      }
      case 0x12: return v[0] === 9 ? Codec.ROUTE_SEGMENT_TYPES[9] : `${Codec.ROUTE_SEGMENT_TYPES[v[0]] || 'Route'}, ${num(v[2])} yd`;
      case 0x13: return `Hand off to ${who(v[0])}`;
      case 0x14: return `Fake handoff to ${who(v[0])}`;
      case 0x15: return v[0] === 2 ? `Follow ${who(v[5])} through the hole` : `Run path (${both(v[1], v[2])})`;
      case 0x16: return `Take handoff${v[2] ? `, aim lane ${lane(v[2])}` : ''}`;
      case 0x17: return 'Fake take handoff';
      case 0x18: return `Release downfield (${both(v[1], v[2])})`;
      case 0x1A: return 'Motion / read';
      case 0x1B: return 'Defensive set';
      case 0x1C: return 'Defensive alignment';
      case 0x0B: case 0x0C: {
        if (v[1] === 17) return 'Rush';
        const label = RUSH_LANE_OPTIONS[flip ? 16 - v[1] : v[1]].label.replace(/^\d+ · /, '');
        return `Rush gap ${flip ? 16 - v[1] : v[1]} (${label})${v[2] ? `, wait ${v[2].toFixed(1)} s` : ''}`;
      }
      case 0x0D: return `Zone drop to ${[across(v[0]), `${num(v[1])} yd deep`].filter(Boolean).join(', ')}${Math.abs(v[0]) < 15 ? ' (middle)' : ''}`;
      case 0x0E: return `Man coverage, ${num(v[1])} yd cushion`;
      default: return name;
    }
  }

  const api = {
    NODE_CAPACITY, parseBook, readAssignments, playFlags, validate, sharedWith, editableFields, fieldValue,
    displayValue, storedValue, defenseKind, isPlaceholder, jobOf, jobOptions, applyJob,
    formationPackages, packageCompatible, setPackageMember, setDefaultPackage, bookName, setBookName,
    SUB_KINDS, readSubs, formationSub, subOptions, setFormationSub,
    isOffenseFormation, readSlots, moveSlot, addedViolations, formationWarnings, formationEdited, setFormationName, formationName, resetFormation,
    setCarrier, carrierOptions, applyEdit, resetPlay, isEdited, describeNode, collectGarbage,
  };
  root.BookEdit = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
