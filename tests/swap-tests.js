// Defense swap tests: `node tests/swap-tests.js`. Uses the Xbox sample books in the parent folder.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const BookEdit = require('../js/bookedit.js');
const DefenseSwap = require('../js/defenseswap.js');
const Saves = require('../js/saves.js');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, '53450030');
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const content = (b, p) => JSON.stringify(BookEdit.readAssignments(b, p).map(a => [a.desc, a.nodes.map(n => [n.op, n.flags, n.packed])]));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); process.exitCode = 1; }
}

const books = fs.existsSync(DIR) ? fs.readdirSync(DIR).map(d => path.join(DIR, d, 'SAVEGAME.DAT'))
  .filter(f => fs.existsSync(f) && fs.statSync(f).size === 0x13390).map(f => new Uint8Array(fs.readFileSync(f))) : [];
const name = b => BookEdit.parseBook(b).bookName;
const byName = n => books.find(b => name(b) === n);

function checkSwap(target, donor) {
  const plan = DefenseSwap.planDefenseSwap(target, donor);
  assert(!plan.error, plan.error);
  const r = DefenseSwap.applyDefenseSwap(target, donor, plan);
  assert(!r.error, r.error);
  const out = r.body, tb = BookEdit.parseBook(target), db = BookEdit.parseBook(donor), ob = BookEdit.parseBook(out);
  assert.strictEqual(ob.formations.length, tb.formations.length, 'no formations added');
  assert.strictEqual(ob.plays.length, tb.plays.length, 'no plays added');
  assert.strictEqual(ob.categories.length, tb.categories.length, 'no packages added');
  assert(u32(out, 0x40) <= 3500);
  assert.strictEqual(out[0x13380], target[0x13380], 'end marker kept');
  for (const p of ob.plays) assert.strictEqual(BookEdit.validate(out, p.index), null, `${p.name} fails the game check`);
  const swapped = new Set(plan.assign.values());
  for (const p of tb.plays) {
    if (swapped.has(p.index)) continue;
    assert.strictEqual(content(out, p.index), content(target, p.index), `${p.name} changed`);
    assert.strictEqual(ob.plays[p.index].name, p.name);
    assert.strictEqual(ob.plays[p.index].flags, p.flags);
  }
  for (const [d, t] of plan.assign) {
    assert.strictEqual(content(out, t), content(donor, d), `${db.plays[d].name} not copied exactly`);
    assert.strictEqual(ob.plays[t].flags, db.plays[d].flags);
    assert.strictEqual(ob.plays[t].name, db.plays[d].name);
  }
  const defense = new Set(plan.pairs.map(p => p.t));
  for (const f of tb.formations) {
    if (defense.has(f.index)) continue;
    const o = 0x134 + f.index * 0xB4, a = 0x245C + f.index * 0x50;
    assert(out.subarray(o + 4, o + 0xB4).every((v, i) => v === target[o + 4 + i]), `${f.name} record changed`);
    assert(out.subarray(a, a + 0x50).every((v, i) => v === target[a + i]), `${f.name} menu changed`);
  }
  for (const { t, d } of plan.pairs) {
    const of = ob.formations[t], df = db.formations[d];
    assert.strictEqual(of.name, df.name);
    assert.strictEqual(of.typeCode, df.typeCode);
    assert.deepStrictEqual(of.positions, df.positions, `${df.name} personnel`);
    assert.deepStrictEqual(of.links.map(p => ob.plays[p].name), df.links.filter(p => plan.assign.has(p)).map(p => db.plays[p].name), `${df.name} menu`);
    const mismatched = plan.warnings.some(w => w.includes(`'s ${df.name} `));
    for (const p of of.links) {
      const code = ob.plays[p].flags & 63;
      assert(code === of.typeCode || code === 14 || mismatched, `${ob.plays[p].name} code ${code} in ${of.name} (type ${of.typeCode}) without a donor warning`);
    }
  }
  const audible = (b, bk, i) => { const f = b[0x56 + i * 2], l = b[0x57 + i * 2]; const v = (b[0x245C + f * 0x50 + l * 2] | (b[0x245C + f * 0x50 + l * 2 + 1] << 8)) & 0x1FF; return `${bk.formations[f].name}/${bk.plays[v].name}`; };
  for (let i = 0; i < 5; i++) assert.strictEqual(audible(out, ob, i), audible(donor, db, i), 'defensive audible');
  for (let o = 0x4C; o < 0x56; o++) assert.strictEqual(out[o], target[o], 'offensive audibles unchanged');
  return { out, plan };
}

if (books.length < 2) {
  console.log('skipped: needs the 53450030 sample books');
} else {
  test('4-3 to 3-4: GB takes PIT\'s whole defense', () => {
    const { out } = checkSwap(byName('GB'), byName('PIT'));
    const base = BookEdit.parseBook(out).formations.find(f => f.typeCode >= 4 && f.typeCode <= 7);
    assert.strictEqual(base.name, '3-4');
  });

  let pairs = 0;
  test('every book pair swaps cleanly in both directions', () => {
    let refused = 0; const reasons = new Set();
    for (const t of books) for (const d of books) {
      if (t === d) continue;
      const plan = DefenseSwap.planDefenseSwap(t, d);
      if (plan.error) { refused++; reasons.add(plan.error); continue; }
      checkSwap(t, d); pairs++;
    }
    assert(pairs >= 20, `only ${pairs} swaps checked`);
    console.log(`     (${pairs} swaps checked; ${refused} refused safely)`);
    for (const r of reasons) console.log(`       refused: ${r}`);
  });

  test('a donor converted by another tool (3-4 formation with 4-3 calls) is flagged', () => {
    const plan = DefenseSwap.planDefenseSwap(byName('PIT'), byName('GB'));
    assert(plan.warnings.some(w => w.includes("GB's 3-4")), 'GB is flagged');
    assert.strictEqual(DefenseSwap.planDefenseSwap(byName('GB'), byName('PIT')).warnings.length, 0, 'PIT is a clean donor');
  });

  test('a swapped book saves for PS2 and Xbox and reads back identically', () => {
    const { out } = checkSwap(byName('GB'), byName('PIT'));
    const ps2 = Saves.loadPlaybookFile('x.max', Saves.convertXboxToPs2(out, 'GB', 'max').bytes);
    assert(ps2.extraOk && ps2.containerOk);
    assert(out.subarray(0x20).every((v, i) => v === ps2.body[0x20 + i]));
  });
}

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
