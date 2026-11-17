// Play viewer/editor tests: `node tests/edit-tests.js`. Uses the Xbox sample books in the parent folder.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const Codec = require('../js/playcodec.js');
const BookEdit = require('../js/bookedit.js');
const Saves = require('../js/saves.js');

const ROOT = path.resolve(__dirname, '..', '..');
const BOOK_DIRS = ['XboxPlaybooks', '53450030'].map(d => path.join(ROOT, d)).filter(fs.existsSync);

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); process.exitCode = 1; }
}
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

const books = [];
for (const dir of BOOK_DIRS) {
  for (const d of fs.readdirSync(dir)) {
    const dat = path.join(dir, d, 'SAVEGAME.DAT');
    if (fs.existsSync(dat) && fs.statSync(dat).size === 0x13390) books.push({ dir: path.join(dir, d), body: new Uint8Array(fs.readFileSync(dat)) });
  }
}
const buf = books.find(b => BookEdit.parseBook(b.body).bookName === 'GB') || books[0];
const base = buf.body;
const baseCount = u32(base, 0x40);
const book = BookEdit.parseBook(base);

// First pass play / slot / step whose route distance is editable and shared (or unique) with others.
function findRouteStep(wantShared) {
  for (const p of book.plays.filter(x => x.kind === 'pass')) {
    const asg = BookEdit.readAssignments(base, p.index);
    for (let s = 0; s < 11; s++) {
      const k = asg[s].nodes.findIndex(n => n.op === 0x12 && BookEdit.editableFields(n).some(f => f.key === 'dist'));
      if (k < 0) continue;
      if ((BookEdit.sharedWith(base, p.index, s).length > 0) === wantShared) return { play: p.index, slot: s, step: k, len: asg[s].nodes.length };
    }
  }
  throw new Error('no suitable route step found');
}

(async () => {
  await test(`every play in ${books.length} books passes the game check`, () => {
    for (const b of books) {
      for (const p of BookEdit.parseBook(b.body).plays) assert.strictEqual(BookEdit.validate(b.body, p.index), null, `${p.name}`);
    }
  });

  await test('every step re-encodes byte-for-byte', () => {
    for (const b of books) {
      for (const p of BookEdit.parseBook(b.body).plays) {
        for (const a of BookEdit.readAssignments(b.body, p.index)) {
          for (const n of a.nodes) if (n.op !== 0x19) assert.strictEqual(Codec.encodeOperands(n.op, Codec.nodeOperands(n)), n.packed);
        }
      }
    }
  });

  const shared = findRouteStep(true);
  let edited;
  await test('editing a shared route changes only that play (private copy)', () => {
    const before = BookEdit.readAssignments(base, shared.play)[shared.slot].nodes[shared.step];
    const oldDist = BookEdit.fieldValue(before, { kind: 'y', lo: 24, n: 8 });
    const r = BookEdit.applyEdit(base, baseCount, shared.play, shared.slot, shared.step, 'dist', oldDist + 3);
    assert(!r.error, r.error);
    assert.strictEqual(r.copied, true);
    edited = r.body;
    assert.strictEqual(u32(edited, 0x40), baseCount + shared.len, 'node count grows by one chain');
    const after = BookEdit.readAssignments(edited, shared.play)[shared.slot].nodes[shared.step];
    assert.strictEqual(BookEdit.fieldValue(after, { kind: 'y', lo: 24, n: 8 }), oldDist + 3);
    assert.strictEqual(after.op, before.op);
    assert.strictEqual(after.flags, before.flags);
    for (const p of book.plays) {
      assert.strictEqual(BookEdit.validate(edited, p.index), null, p.name);
      if (p.index === shared.play) continue;
      const a = BookEdit.readAssignments(base, p.index), b = BookEdit.readAssignments(edited, p.index);
      assert.deepStrictEqual(b, a, `${p.name} changed`);
    }
    assert(BookEdit.isEdited(edited, base, shared.play));
    assert.strictEqual(book.plays.filter(p => BookEdit.isEdited(edited, base, p.index)).length, 1);
  });

  await test('a second edit of the same player reuses the private copy', () => {
    const r = BookEdit.applyEdit(edited, baseCount, shared.play, shared.slot, shared.step, 'route', 0);
    assert(!r.error, r.error);
    assert.strictEqual(r.copied, false);
    assert.strictEqual(u32(r.body, 0x40), baseCount + shared.len);
    edited = r.body;
  });

  await test('resetting the play restores the original book byte-for-byte', () => {
    assert(eq(BookEdit.resetPlay(edited, base, baseCount, shared.play), base));
  });

  await test('editing an unshared route changes it in place (no new steps)', () => {
    const unique = findRouteStep(false);
    const r = BookEdit.applyEdit(base, baseCount, unique.play, unique.slot, unique.step, 'dist', 12);
    assert(!r.error, r.error);
    assert.strictEqual(r.copied, false);
    assert.strictEqual(u32(r.body, 0x40), baseCount);
    let changed = 0;
    for (let i = 0; i < base.length; i++) if (base[i] !== r.body[i]) changed++;
    assert(changed > 0 && changed <= 6, `${changed} bytes changed`);
    assert(eq(BookEdit.resetPlay(r.body, base, baseCount, unique.play), base));
  });

  await test('out-of-range and unknown edits are refused without changing the book', () => {
    const copy = base.slice();
    assert(BookEdit.applyEdit(copy, baseCount, shared.play, shared.slot, shared.step, 'dist', -5).error);
    assert(BookEdit.applyEdit(copy, baseCount, shared.play, shared.slot, shared.step, 'route', 9).error);
    assert(BookEdit.applyEdit(copy, baseCount, shared.play, shared.slot, shared.step, 'opcode', 1).error);
    assert(eq(copy, base));
  });

  await test('every editable field of every run/pass play accepts its current value unchanged', () => {
    for (const p of book.plays.filter(x => x.kind !== 'other')) {
      BookEdit.readAssignments(base, p.index).forEach((a, s) => a.nodes.forEach((n, k) => {
        for (const f of BookEdit.editableFields(n)) {
          const r = BookEdit.applyEdit(base, baseCount, p.index, s, k, f.key, BookEdit.fieldValue(n, f));
          assert(r.unchanged, `${p.name} slot ${s} step ${k} ${f.key}: ${r.error || 'changed'}`);
        }
      }));
    }
  });

  await test('flipped view mirrors values and stores them back unchanged', () => {
    let checked = 0;
    for (const p of book.plays.filter(x => x.kind === 'run')) {
      BookEdit.readAssignments(base, p.index).forEach((a, s) => a.nodes.forEach((n, k) => {
        for (const f of BookEdit.editableFields(n)) {
          const shown = BookEdit.displayValue(n, f, true);
          const r = BookEdit.applyEdit(base, baseCount, p.index, s, k, f.key, BookEdit.storedValue(f, shown, true));
          assert(r.unchanged, `${p.name} ${f.key}`);
          if (f.kind === 'x' && BookEdit.fieldValue(n, f)) assert.strictEqual(shown, -BookEdit.fieldValue(n, f));
          if (f.kind === 'lane') assert.strictEqual(shown, 9 - BookEdit.fieldValue(n, f));
          checked++;
        }
      }));
    }
    assert(checked > 100);
  });

  await test('follow-the-blocker runs are drawn to the followed player', () => {
    const fm = book.formations.find(f => f.links.some(i => /Dive/.test(book.plays[i].name) && book.plays[i].kind === 'run'));
    const play = book.plays[fm.links.find(i => /Dive/.test(book.plays[i].name))];
    const asg = BookEdit.readAssignments(base, play.index);
    const s = asg.findIndex(a => a.nodes.some(n => n.op === 0x15 && Codec.nodeOperands(n)[0] === 2));
    const follow = Codec.nodeOperands(asg[s].nodes.find(n => n.op === 0x15))[5];
    const starts = fm.slots.map(p => [p.x, p.z]);
    const segs = Codec.playArt(asg[s].nodes, starts[s], starts[s][0] < 0, starts);
    const path = segs.find(g => g.end === 'arrow');
    assert(path, 'no arrow drawn for the ball carrier');
    assert(Math.abs(path.points[1][0] - starts[follow][0]) < 31, 'path does not reach the followed player');
  });

  await test('defense: a shared zone spot edit changes only that coverage', () => {
    const cover = book.plays.filter(p => p.kind === 'defense' && BookEdit.defenseKind(base, p.index) === 'cover');
    assert(cover.length > 5, 'no coverages found');
    let done = false;
    for (const p of cover) {
      const asg = BookEdit.readAssignments(base, p.index);
      const s = asg.findIndex((a, i) => a.nodes.some(n => n.op === 0x0D) && BookEdit.sharedWith(base, p.index, i).length);
      if (s < 0) continue;
      const k = asg[s].nodes.findIndex(n => n.op === 0x0D);
      const depth = BookEdit.fieldValue(asg[s].nodes[k], { kind: 'y', lo: 16, n: 8 });
      const r = BookEdit.applyEdit(base, baseCount, p.index, s, k, 'y', depth + 3);
      assert(!r.error, r.error);
      assert.strictEqual(r.copied, true);
      for (const q of book.plays) {
        assert.strictEqual(BookEdit.validate(r.body, q.index), null, q.name);
        if (q.index !== p.index) assert.deepStrictEqual(BookEdit.readAssignments(r.body, q.index), BookEdit.readAssignments(base, q.index));
      }
      assert(eq(BookEdit.resetPlay(r.body, base, baseCount, p.index), base));
      done = true;
      break;
    }
    assert(done, 'no shared zone drop found');
  });

  await test('defense: rush gaps mirror as 16 - gap and every defensive field round-trips', () => {
    let rush = 0;
    for (const p of book.plays.filter(x => x.kind === 'defense')) {
      BookEdit.readAssignments(base, p.index).forEach((a, s) => a.nodes.forEach((n, k) => {
        for (const f of BookEdit.editableFields(n)) {
          for (const flip of [false, true]) {
            const r = BookEdit.applyEdit(base, baseCount, p.index, s, k, f.key, BookEdit.storedValue(f, BookEdit.displayValue(n, f, flip), flip));
            assert(r.unchanged, `${p.name} slot ${s} ${f.key}: ${r.error || 'changed'}`);
          }
          if (f.kind === 'rushlane') { assert.strictEqual(BookEdit.displayValue(n, f, true), 16 - BookEdit.fieldValue(n, f)); rush++; }
        }
      }));
    }
    assert(rush > 20, `only ${rush} rush gaps checked`);
  });

  await test('defense: every job change passes the game check and changes only that call', () => {
    let swaps = 0;
    for (const f of book.formations) {
      const plays = f.links.map(i => book.plays[i]).filter(p => p.kind === 'defense');
      for (const p of plays) {
        const kind = BookEdit.defenseKind(base, p.index);
        for (let s = 0; s < 11; s++) {
          const options = BookEdit.jobOptions(base, book, f.index, p.index, s);
          if (kind === 'front') { assert.strictEqual(options.length, 0, 'fronts offer no job changes'); continue; }
          for (const o of options) {
            for (const fi of p.formations) assert(book.plays[o.donorPlay].formations.includes(fi), `${p.name}: donor “${book.plays[o.donorPlay].name}” is not used by every formation of this play`);
            if (o.job === 'front') assert(!['LB', 'MLB', 'OLB', 'CB', 'FS', 'SS'].some(x => Codec.positionLabel(f.positions[s]).startsWith(x)), 'back seven must never be left to the front');
            const r = BookEdit.applyJob(base, book, baseCount, f.index, p.index, s, o.donorPlay);
            assert(!r.error, `${p.name} slot ${s}: ${r.error}`);
            assert.strictEqual(u32(r.body, 0x40), baseCount, 'a job change creates no steps');
            assert.deepStrictEqual(BookEdit.readAssignments(r.body, p.index)[s].nodes, o.assignment.nodes);
            swaps++;
            if (swaps % 25 === 0) {
              for (const q of book.plays) if (q.index !== p.index) assert.deepStrictEqual(BookEdit.readAssignments(r.body, q.index), BookEdit.readAssignments(base, q.index));
              assert(eq(BookEdit.resetPlay(r.body, base, baseCount, p.index), base));
            }
          }
        }
      }
    }
    assert(swaps > 500, `only ${swaps} job changes checked`);
    console.log(`     (${swaps} job changes checked)`);
  });

  await test('defense: tuning a swapped-in job copies it, leaving the donor call untouched', () => {
    for (const f of book.formations) {
      for (const p of f.links.map(i => book.plays[i]).filter(x => x.kind === 'defense')) {
        for (let s = 0; s < 11; s++) {
          const o = BookEdit.jobOptions(base, book, f.index, p.index, s).find(x => x.job === 'zone');
          if (!o) continue;
          const swapped = BookEdit.applyJob(base, book, baseCount, f.index, p.index, s, o.donorPlay).body;
          const k = BookEdit.readAssignments(swapped, p.index)[s].nodes.findIndex(n => n.op === 0x0D);
          const depth = BookEdit.fieldValue(BookEdit.readAssignments(swapped, p.index)[s].nodes[k], { kind: 'y', lo: 16, n: 8 });
          const r = BookEdit.applyEdit(swapped, baseCount, p.index, s, k, 'y', depth + 2);
          assert(!r.error && r.copied, r.error || 'expected a private copy');
          assert.deepStrictEqual(BookEdit.readAssignments(r.body, o.donorPlay), BookEdit.readAssignments(base, o.donorPlay));
          assert(eq(BookEdit.resetPlay(r.body, base, baseCount, p.index), base));
          return;
        }
      }
    }
    assert.fail('no zone job option found');
  });

  await test('formations: moving players and renaming never touches plays, and reset restores the book', () => {
    for (const b of books) {
      const bk = BookEdit.parseBook(b.body), count = u32(b.body, 0x40);
      let body = b.body;
      const touched = [];
      for (const f of bk.formations.slice(0, 6)) {
        const s = f.positions.findIndex(c => [9, 15, 18].includes(c & 31)); // a WR, OLB or CB
        if (s < 0) continue;
        const before = BookEdit.readSlots(body, f.index)[s];
        const r = BookEdit.moveSlot(body, bk, f.index, s, f.slots[s].x + (f.slots[s].x >= 0 ? 91 : -91), f.slots[s].z);
        assert(!r.error, r.error);
        body = r.body;
        const after = BookEdit.readSlots(body, f.index)[s];
        after.x.forEach((v, k) => assert(Math.abs(v - before.x[k] - (after.x[0] - before.x[0])) <= 1, 'alternate spots shift with the base spot'));
        body = BookEdit.setFormationName(body, b.body, bk, f.index, `${f.name} Mod`).body;
        assert.strictEqual(BookEdit.formationName(body, f.index), `${f.name} Mod`);
        touched.push(f.index);
      }
      assert.strictEqual(body[0x13380], b.body[0x13380], 'end marker byte kept');
      assert.strictEqual(u32(body, 0x40), count, 'no steps added');
      for (const p of bk.plays) {
        assert.deepStrictEqual(BookEdit.readAssignments(body, p.index), BookEdit.readAssignments(b.body, p.index));
        assert.strictEqual(BookEdit.validate(body, p.index), null);
      }
      for (const fi of touched) body = BookEdit.resetFormation(body, b.body, bk, fi);
      assert(eq(body, b.body), `${bk.bookName}: reset did not restore the book`);
    }
  });

  await test('formations: moving the QB across shotgun depth updates the alignment flag; nobody leaves the field', () => {
    const f = book.formations.find(x => BookEdit.isOffenseFormation(x.typeCode));
    const qb = f.positions.findIndex(c => (c & 31) === 0);
    const gun = f.slots[qb].z <= -250;
    const off = 0x134 + f.index * 0xB4;
    const r = BookEdit.moveSlot(base, book, f.index, qb, 0, gun ? -91 : -457);
    assert(!r.error, r.error);
    assert.strictEqual(r.alignment, gun ? 'under center' : 'shotgun');
    assert.strictEqual((u32(r.body, off + 4) >> 18) & 3, gun ? 1 : 2, 'flag bits 18-19 follow the QB');
    assert.strictEqual(u32(r.body, off + 4) & ~0xC0000, u32(base, off + 4) & ~0xC0000, 'no other flag bits change');
    for (const p of book.plays) assert.strictEqual(BookEdit.validate(r.body, p.index), null);
    assert(eq(BookEdit.resetFormation(r.body, base, book, f.index), base));
    assert(BookEdit.moveSlot(base, book, f.index, qb, 30 * 91.44, f.slots[qb].z).error, 'out of bounds must be refused');
    const d = book.formations.find(x => !BookEdit.isOffenseFormation(x.typeCode) && x.links.length);
    assert(BookEdit.moveSlot(base, book, d.index, 0, d.slots[0].x, -3 * 91.44).error, 'defense across the line must be refused');
  });

  await test('formations: real-football eligibility; edits never add a violation', () => {
    let blocked = 0, allowed = 0;
    for (const b of books) {
      const bk = BookEdit.parseBook(b.body);
      for (const f of bk.formations.filter(x => x.typeCode <= 3 && x.links.length)) {
        const onLine = f.slots.map((p, s) => s).filter(s => Math.abs(f.slots[s].z) <= 15);
        const back = f.slots.findIndex((p, s) => [10, 11].includes(f.positions[s] & 31) && p.z < -91);
        if (back < 0 || onLine.length < 2) continue;
        // On the line between the two innermost linemen's neighbours: always covered -> blocked.
        const r1 = BookEdit.moveSlot(b.body, bk, f.index, back, f.slots[onLine[0]].x + 45, 0);
        if (r1.error) { assert(/covered|neither|on top/.test(r1.error) || /Not a legal/.test(r1.error), r1.error); blocked++; }
        // Half a yard back: no-man's-land -> blocked.
        assert(BookEdit.moveSlot(b.body, bk, f.index, back, f.slots[back].x, -46).error, 'half-yard depth must be refused');
        // Staying a back, sliding over a yard: allowed.
        const r2 = BookEdit.moveSlot(b.body, bk, f.index, back, f.slots[back].x + 91, f.slots[back].z);
        assert(!r2.error, `${bk.bookName} ${f.name}: ${r2.error}`);
        allowed++;
      }
    }
    assert(blocked > 20 && allowed > 20, `blocked ${blocked}, allowed ${allowed}`);
  });

  await test('packages: adding a compatible package or making it default changes only that formation', () => {
    let checked = 0;
    for (const b of books) {
      const bk = BookEdit.parseBook(b.body);
      for (const f of bk.formations.filter(x => x.typeCode <= 3 && x.links.length)) {
        const { def, members } = BookEdit.formationPackages(b.body, f.index);
        assert(members.includes(def), 'the default package is always a member');
        for (const c of bk.categories.filter(c => !members.includes(c.index) && BookEdit.packageCompatible(bk, f.index, c.index, b.body))) {
          let body = BookEdit.setPackageMember(b.body, bk, f.index, c.index, true).body;
          body = BookEdit.setDefaultPackage(body, bk, f.index, c.index).body;
          assert(BookEdit.setPackageMember(body, bk, f.index, c.index, false).error, 'the default cannot be removed');
          const changed = [];
          for (let i = 0; i < body.length; i++) if (body[i] !== b.body[i]) changed.push(i);
          const aux = 0x245C + f.index * 0x50;
          assert(changed.every(i => i >= aux + 0x48 && i < aux + 0x50), 'only this formation\'s package words change');
          // Same kinds in QB/line slots and eligible players everywhere else: eligibility unchanged.
          const kinds = cat => bk.categories[cat].positions.map(x => x & 31);
          kinds(c.index).forEach((k, s) => assert(s > 5 ? [8, 9, 10, 11].includes(k) : k === kinds(def)[s]));
          assert(eq(BookEdit.resetFormation(body, b.body, bk, f.index), b.body));
          checked++;
        }
      }
    }
    assert(checked > 50, `only ${checked} package changes checked`);
    console.log(`     (${checked} package changes checked)`);
  });

  await test('formations: draft moves pass through illegal states; the finished formation is what is checked', () => {
    let checked = 0;
    for (const b of books) {
      const bk = BookEdit.parseBook(b.body);
      for (const f of bk.formations.filter(x => x.typeCode <= 3 && x.links.length)) {
        const back = f.slots.findIndex((p, s) => [10, 11].includes(f.positions[s] & 31) && p.z < -91);
        const onLine = f.slots.map((p, s) => s).filter(s => Math.abs(f.slots[s].z) <= 15);
        if (back < 0 || onLine.length < 2) continue;
        const inside = f.slots[onLine[0]].x + 45;
        if (!BookEdit.moveSlot(b.body, bk, f.index, back, inside, 0).error) continue; // only illegal-on-the-line cases
        const draft = BookEdit.moveSlot(b.body, bk, f.index, back, inside, 0, { draft: true });
        assert(!draft.error, `draft move refused: ${draft.error}`);
        assert(BookEdit.addedViolations(b.body, draft.body, bk, f.index).length > 0, 'the illegal draft is reported');
        const fixed = BookEdit.moveSlot(draft.body, bk, f.index, back, f.slots[back].x, f.slots[back].z, { draft: true });
        assert.deepStrictEqual(BookEdit.addedViolations(b.body, fixed.body, bk, f.index), [], 'moving him back makes it legal again');
        assert(BookEdit.moveSlot(b.body, bk, f.index, back, 40 * 91.44, 0, { draft: true }).error, 'hard limits still apply to drafts');
        checked++;
      }
    }
    assert(checked > 20, `only ${checked} formations checked`);
  });

  await test('book name follows the team code and can be changed back exactly', () => {
    for (const b of books) {
      const bk = BookEdit.parseBook(b.body);
      let body = BookEdit.setBookName(b.body, b.body, bk, 'DAL').body;
      assert.strictEqual(BookEdit.bookName(body), 'DAL');
      assert.strictEqual(BookEdit.parseBook(body).bookName, 'DAL');
      body = BookEdit.setFormationName(body, b.body, bk, 0, 'Renamed Formation').body;
      assert.strictEqual(BookEdit.bookName(body), 'DAL', 'a formation rename keeps the book name');
      assert.strictEqual(BookEdit.formationName(body, 0), 'Renamed Formation');
      for (const p of bk.plays) assert.deepStrictEqual(BookEdit.readAssignments(body, p.index), BookEdit.readAssignments(b.body, p.index));
      assert.strictEqual(body[0x13380], b.body[0x13380]);
      body = BookEdit.setBookName(body, b.body, bk, bk.bookName).body;
      body = BookEdit.resetFormation(body, b.body, bk, 0);
      assert(eq(body, b.body), `${bk.bookName}: renames did not undo exactly`);
      assert(BookEdit.setBookName(b.body, b.body, bk, 'Bad Name!').error);
    }
  });

  await test('400 random edits either fail cleanly or change only their own play', () => {
    let seed = 11;
    const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const editable = book.plays.filter(x => x.kind !== 'other');
    let body = base, applied = 0, refused = 0;
    for (let t = 0; t < 400; t++) {
      const p = editable[rnd(editable.length)].index;
      const asg = BookEdit.readAssignments(body, p);
      const s = rnd(11), k = rnd(asg[s].nodes.length);
      const fields = BookEdit.editableFields(asg[s].nodes[k]);
      if (!fields.length) continue;
      const f = fields[rnd(fields.length)];
      const value = f.options ? f.options[rnd(f.options.length)].value : Math.round((f.min + rnd(1000) / 1000 * (f.max - f.min)) * 3) / 3;
      const r = BookEdit.applyEdit(body, baseCount, p, s, k, f.key, value);
      if (r.error) { refused++; continue; }
      for (const q of book.plays) {
        if (q.index !== p) assert.deepStrictEqual(BookEdit.readAssignments(r.body, q.index), BookEdit.readAssignments(body, q.index));
        assert.strictEqual(BookEdit.validate(r.body, q.index), null);
      }
      body = r.body; applied++;
    }
    assert(applied > 100, `only ${applied} edits applied`);
    let restored = body;
    for (const q of book.plays) if (BookEdit.isEdited(restored, base, q.index)) restored = BookEdit.resetPlay(restored, base, baseCount, q.index);
    assert(eq(restored, base), 'resetting every edited play restores the original');
    console.log(`     (${applied} applied, ${refused} refused by the game check, ${u32(body, 0x40) - baseCount} steps used for private copies)`);
  });

  await test('Xbox save signature matches the retail EXTRA and re-signs edited books', async () => {
    const extra = new Uint8Array(fs.readFileSync(path.join(buf.dir, 'EXTRA')));
    assert(eq(await Saves.signXboxSave(base), extra));
    const files = await Saves.buildXboxSave(edited, 'GB');
    const expect = crypto.createHmac('sha1', Buffer.from('722E7565FB841B09E938DA756393FF80', 'hex')).update(files[0].data).digest();
    assert(eq(files[1].data, expect));
    assert.strictEqual(Saves.xboxFolderName('GB'), '000000470042');
    assert.strictEqual(Saves.xboxFolderName('BUF'), '004200550046');
  });

  await test('an edited book converts to PS2 and reads back with the edit intact', () => {
    const out = Saves.convertXboxToPs2(edited, 'GB', 'max');
    const loaded = Saves.loadPlaybookFile(out.fileName, out.bytes);
    assert(loaded.extraOk && loaded.containerOk);
    const a = BookEdit.readAssignments(edited, shared.play), b = BookEdit.readAssignments(loaded.body, shared.play);
    assert.deepStrictEqual(b, a);
  });

  await test('ball carrier swap moves the handoff, validates, and undoes cleanly', () => {
    const run = book.plays.find(p => p.name === 'Weak FB Dive') || book.plays.filter(p => p.kind === 'run').find(p => BookEdit.carrierOptions(base, baseCount, p.index).slots.length);
    const { current, slots } = BookEdit.carrierOptions(base, baseCount, run.index);
    assert(current >= 0 && slots.length);
    const to = slots[slots.length - 1];
    const r = BookEdit.setCarrier(base, baseCount, run.index, to);
    assert(!r.error, r.error);
    assert.strictEqual(BookEdit.validate(r.body, run.index), null);
    assert.strictEqual(BookEdit.carrierOptions(r.body, baseCount, run.index).current, to);
    const other = book.plays.find(p => p.index !== run.index);
    assert.deepStrictEqual(BookEdit.readAssignments(r.body, other.index), BookEdit.readAssignments(base, other.index));
    const back = BookEdit.setCarrier(r.body, baseCount, run.index, current);
    assert(!back.error && !BookEdit.isEdited(back.body, base, run.index));
  });

  await test('every ball carrier option on every run play passes the game check', () => {
    for (const p of book.plays.filter(x => x.kind === 'run')) {
      for (const s of BookEdit.carrierOptions(base, baseCount, p.index).slots) {
        assert.strictEqual(BookEdit.validate(BookEdit.setCarrier(base, baseCount, p.index, s).body, p.index), null, p.name);
      }
    }
  });

  // ---- player substitutions: rebuild every in-game save from subcompare/ byte for byte
  const SUBDIR = path.join(__dirname, '..', 'subcompare');
  const subFile = re => {
    const n = fs.existsSync(SUBDIR) && fs.readdirSync(SUBDIR).find(x => re.test(x));
    return n ? Saves.loadPlaybookFile(n, new Uint8Array(fs.readFileSync(path.join(SUBDIR, n)))).body : null;
  };
  const chi = subFile(/CHI \(/), sfBase = subFile(/SFbase/i);
  if (chi && sfBase) {
    const chiBook = BookEdit.parseBook(chi), sfBook = BookEdit.parseBook(sfBase);
    const apply = (body, bk, steps) => steps.reduce((b, [f, kind, d]) => { const r = BookEdit.setFormationSub(b, bk, f, kind, d); assert(!r.error, r.error); return r.body; }, body);

    await test('substitutions: HB -> HB2 reproduces the in-game CHI1 and CHI2 saves exactly', () => {
      assert(eq(apply(chi, chiBook, [[0, 'hb', 1]]), subFile(/CHI1/)));
      assert(eq(apply(chi, chiBook, [[0, 'hb', 1], [1, 'hb', 1]]), subFile(/CHI2/)));
    });

    await test('substitutions: FB -> TE1..TE4 reproduce the in-game SF saves exactly', () => {
      assert(eq(apply(sfBase, sfBook, [[7, 'fb', 3]]), subFile(/SFFTE/)), 'I Pro TE4');
      assert(eq(apply(sfBase, sfBook, [[7, 'fb', 2]]), subFile(/SFte3/)), 'I Pro TE3');
      assert(eq(apply(sfBase, sfBook, [[9, 'fb', 0]]), subFile(/SFispre/)), 'I Spread TE1');
      assert(eq(apply(sfBase, sfBook, [[9, 'fb', 1]]), subFile(/SFte2/)), 'I Spread TE2');
      assert(eq(apply(sfBase, sfBook, [[15, 'fb', 1], [18, 'fb', 0]]), subFile(/SFss/)), 'Split Pro TE2 + Split Spread TE1');
    });

    await test('substitutions: remove and reset restore the original, unknown entries are kept', () => {
      const sub = apply(sfBase, sfBook, [[7, 'fb', 3], [9, 'fb', 1]]);
      assert(eq(apply(sub, sfBook, [[7, 'fb', null], [9, 'fb', null]]), sfBase));
      assert(eq(BookEdit.resetFormation(sub, sfBase, sfBook, 7).slice(0x6C, 0x134), apply(sfBase, sfBook, [[9, 'fb', 1]]).slice(0x6C, 0x134)));
      assert(!BookEdit.formationEdited(BookEdit.resetFormation(sub, sfBase, sfBook, 7), sfBase, 7));
      assert(BookEdit.formationEdited(sub, sfBase, 7));
      // Entries of kinds not understood (CHIsub's five, copied from the user's in-game save) survive edits.
      const withUnknown = sfBase.slice();
      [0x007821A6, 0x0148A1A6, 0x01E82226, 0x0298A82A, 0x02D9242A].forEach((v, i) => { for (let k = 0; k < 4; k++) withUnknown[0x6C + i * 4 + k] = (v >>> (8 * k)) & 255; });
      const unknown = BookEdit.readSubs(withUnknown);
      assert.strictEqual(unknown.length, 5);
      const changed = apply(withUnknown, sfBook, [[0, 'hb', 1], [0, 'hb', null]]);
      assert(eq(changed, withUnknown), 'adding then removing a sub leaves every other entry as it was');
      const added = BookEdit.readSubs(apply(withUnknown, sfBook, [[2, 'hb', 1]])).map(x => x.raw);
      assert(unknown.every(x => added.includes(x.raw)) && added.length === 6);
      const dropped = BookEdit.readSubs(apply(withUnknown, sfBook, [[7, 'fb', 1], [7, 'fb', null]])).map(x => x.raw);
      assert.deepStrictEqual(dropped, unknown.map(x => x.raw));
    });

    await test('substitutions: only offered where the package has that player; changing depth replaces', () => {
      const kinds = f => BookEdit.subOptions(sfBase, sfBook, f).map(o => o.kind);
      assert.deepStrictEqual(kinds(7), ['hb', 'fb']);
      assert(!kinds(0).includes('fb'), 'Triple has no fullback');
      assert(BookEdit.setFormationSub(sfBase, sfBook, 0, 'fb', 1).error);
      assert(BookEdit.setFormationSub(sfBase, sfBook, 7, 'hb', 0).error, 'HB1 is the starter');
      const twice = apply(sfBase, sfBook, [[7, 'fb', 1], [7, 'fb', 3]]);
      assert.strictEqual(BookEdit.readSubs(twice).length, 1);
      assert.strictEqual(BookEdit.formationSub(twice, 7, 'fb').depth, 3);
    });
  }

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
