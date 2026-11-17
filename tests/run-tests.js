// Node test run: `node tests/run-tests.js [outDir]`. Uses the sample saves in the parent folder.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Lzari = require('../js/lzari.js');
const Playbook = require('../js/playbook.js');
const Saves = require('../js/saves.js');

const ROOT = path.resolve(__dirname, '..', '..');
const PS2_SAMPLE = path.join(ROOT, 'Ps2Playbooks', 'SLUS-20919 ESPN NFL 2K5 NE (5B208D0D).max');
const XBOX_DIR = path.join(ROOT, 'XboxPlaybooks');
const outDir = process.argv[2];

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; }
}
const read = p => new Uint8Array(fs.readFileSync(p));
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

test('LZARI round-trips varied data', () => {
  const samples = [new Uint8Array(0x20).fill(7), Uint8Array.from({ length: 50000 }, (_, i) => (i * 7919) % 251), Uint8Array.from({ length: 9000 }, () => Math.random() * 256)];
  for (const s of samples) assert(eq(Lzari.decode(Lzari.encode(s), s.length), s));
});

const sample = read(PS2_SAMPLE);
const sampleSave = Saves.readMax(sample);
const samplePb = Saves.ps2PlaybookFromSave(sampleSave);

test('reads retail PS2 .max (container CRC, EXTRA CRC, playbook)', () => {
  assert.strictEqual(sampleSave.crcOk, true);
  assert.strictEqual(samplePb.extraOk, true);
  assert.strictEqual(samplePb.code, 'NE');
  const info = Playbook.inspect(samplePb.body);
  assert(info.ok, info.errors.join(' '));
  assert.strictEqual(info.platform, 'ps2');
});

test('rebuilding the retail PS2 save reproduces every file byte-for-byte', () => {
  const rebuilt = Saves.ps2PlaybookFiles(samplePb.body, 'NE');
  assert.deepStrictEqual(rebuilt.files.map(f => f.name), sampleSave.files.map(f => f.name));
  rebuilt.files.forEach((f, i) => assert(eq(f.data, sampleSave.files[i].data), `${f.name} differs`));
  const max = Saves.buildMax(rebuilt);
  assert.strictEqual(Playbook.u32(max, 0x58), Playbook.u32(sample, 0x58), 'archive size differs');
  assert(eq(max.subarray(0x10, 0x50), sample.subarray(0x10, 0x50)), 'dir name/title differ');
  const back = Saves.readMax(max);
  assert(back.crcOk);
  back.files.forEach((f, i) => assert(eq(f.data, sampleSave.files[i].data)));
});

test('LZARI stream decodes regardless of trailing bytes', () => {
  const max = Saves.buildMax(Saves.ps2PlaybookFiles(samplePb.body, 'NE'));
  const rawSize = Playbook.u32(max, 0x58);
  const stream = max.subarray(0x5C);
  const a = Lzari.decode(stream, rawSize);
  const b = Lzari.decode(Uint8Array.from([...stream, 255, 255, 255, 255, 255, 255, 255, 255]), rawSize);
  assert(eq(a, b));
});

for (const dir of fs.readdirSync(XBOX_DIR)) {
  const datPath = path.join(XBOX_DIR, dir, 'SAVEGAME.DAT');
  if (!fs.existsSync(datPath)) continue;
  const body = read(datPath);
  const code = Saves.sanitizeCode(Saves.parseSaveMeta(read(path.join(XBOX_DIR, dir, 'SaveMeta.xbx'))));

  test(`Xbox ${dir} (${code}) converts to .max and .psu`, () => {
    const info = Playbook.inspect(body);
    assert(info.ok, info.errors.join(' '));
    assert.strictEqual(info.platform, 'xbox');
    for (const format of ['max', 'psu']) {
      const out = Saves.convertXboxToPs2(body, code, format);
      const loaded = Saves.loadPlaybookFile(out.fileName, out.bytes);
      assert.strictEqual(loaded.code, code);
      assert.strictEqual(loaded.extraOk, true);
      if (format === 'max') assert.strictEqual(loaded.containerOk, true);
      assert.strictEqual(Playbook.inspect(loaded.body).platform, 'ps2');
      const cmp = Playbook.compare(body, loaded.body);
      assert.strictEqual(cmp.unexpectedBytes, 0, 'body changed outside the platform header words');
      if (outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, out.fileName), out.bytes);
      }
    }
  });
}

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
