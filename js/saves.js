// Save containers: Xbox playbook folders, PS2 AR MAX (.max) and EMS/uLaunchELF (.psu).
(function (root) {
  'use strict';

  const Lzari = root.Lzari || (typeof require !== 'undefined' && require('./lzari.js'));
  const Playbook = root.Playbook || (typeof require !== 'undefined' && require('./playbook.js'));
  const Assets = root.PlaybookAssets || (typeof require !== 'undefined' && require('./assets.js'));
  const { u32, putU32 } = Playbook;

  const PS2_GAME_ID = 'BASLUS-20919';
  const PS2_TITLE = 'ESPN NFL 2K5';
  const TYPE_FILE = Uint8Array.from([0x50, 0, 0x42, 0, 0x4B, 0, 0, 0]); // "PBK" UTF-16

  // ------------------------------------------------------------ helpers
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function base64ToBytes(s) {
    if (typeof atob === 'function') return Uint8Array.from(atob(s), c => c.charCodeAt(0));
    return new Uint8Array(Buffer.from(s, 'base64'));
  }
  function cString(b, o, n) {
    let s = '';
    for (let i = 0; i < n && b[o + i]; i++) s += String.fromCharCode(b[o + i]);
    return s;
  }
  function putCString(b, o, n, s) {
    for (let i = 0; i < n; i++) b[o + i] = i < s.length ? s.charCodeAt(i) & 0xFF : 0;
  }
  function concat(parts) {
    const len = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function u32Bytes(v) { const b = new Uint8Array(4); putU32(b, 0, v); return b; }

  // Team/book codes become part of PS2 file names, so keep them to plain letters and digits.
  function sanitizeCode(code) {
    return String(code || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
  }

  // ------------------------------------------------------------ Xbox
  // SaveMeta.xbx is UTF-16LE text such as "Name=GB\r\n".
  function parseSaveMeta(bytes) {
    let s = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    s = s.replace(/^﻿/, '');
    const m = /Name=([^\r\n]*)/.exec(s);
    return m ? m[1] : '';
  }

  // EXTRA = HMAC-SHA1(SigKey16, SAVEGAME.DAT). SigKey16 is derived from the retail ESPN NFL 2K5
  // certificate key and is the same for every copy of the game (from 2k-football-mod-tools,
  // nfl2k5_roster_records.SIG_KEY; the game rejects a save whose EXTRA does not match).
  const XBOX_SIG_KEY = Uint8Array.from([0x72, 0x2E, 0x75, 0x65, 0xFB, 0x84, 0x1B, 0x09, 0xE9, 0x38, 0xDA, 0x75, 0x63, 0x93, 0xFF, 0x80]);

  async function signXboxSave(savegame) {
    const subtle = (typeof crypto !== 'undefined' && crypto.subtle) || require('crypto').webcrypto.subtle;
    const key = await subtle.importKey('raw', XBOX_SIG_KEY, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    return new Uint8Array(await subtle.sign('HMAC', key, savegame));
  }

  function makeSaveMeta(name) {
    const text = `Name=${name}\r\n`;
    const out = new Uint8Array(2 + text.length * 2);
    out[0] = 0xFF; out[1] = 0xFE;
    for (let i = 0; i < text.length; i++) { out[2 + i * 2] = text.charCodeAt(i) & 255; out[3 + i * 2] = text.charCodeAt(i) >> 8; }
    return out;
  }

  // Xbox playbook save folders seen so far are named by the code's UTF-16 units, e.g. GB -> 000000470042.
  function xboxFolderName(code) {
    const units = code.slice(0, 3).padStart(3, '\0');
    return [...units].map(c => c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join('');
  }

  // The four files of an Xbox playbook save folder, signed.
  async function buildXboxSave(body, code, saveMeta) {
    const savegame = Playbook.detectPlatform(body) === 'xbox' ? body : Playbook.toXbox(body);
    return [
      { name: 'SAVEGAME.DAT', data: savegame },
      { name: 'EXTRA', data: await signXboxSave(savegame) },
      { name: 'TYPE', data: TYPE_FILE.slice() },
      { name: 'SaveMeta.xbx', data: saveMeta || makeSaveMeta(code) },
    ];
  }

  // ------------------------------------------------------------ PS2 icon.sys
  // Full-width Shift-JIS for the ASCII subset we allow (A-Z, a-z, 0-9, space).
  function toFullwidthSjis(str) {
    const out = [];
    for (const ch of str) {
      const c = ch.charCodeAt(0);
      if (c >= 0x30 && c <= 0x39) out.push(0x82, 0x4F + (c - 0x30));
      else if (c >= 0x41 && c <= 0x5A) out.push(0x82, 0x60 + (c - 0x41));
      else if (c >= 0x61 && c <= 0x7A) out.push(0x82, 0x81 + (c - 0x61));
      else out.push(0x81, 0x40);
    }
    return out;
  }

  // Title is two lines: "ESPN NFL 2K5" then the team code; offset 6 holds the line-break byte offset.
  function makeIconSys(code) {
    const icon = base64ToBytes(Assets.iconSys);
    const line1 = toFullwidthSjis(PS2_TITLE);
    const title = line1.concat(toFullwidthSjis(code));
    icon.fill(0, 0xC0, 0xC0 + 68);
    icon.set(title.slice(0, 68), 0xC0);
    icon[6] = line1.length; icon[7] = 0;
    return icon;
  }

  // The files that make up a PS2 2K5 playbook save, in the game's own order.
  function ps2PlaybookFiles(body, code) {
    const dirName = PS2_GAME_ID + code;
    return {
      dirName,
      title: `${PS2_TITLE} ${code}`,
      files: [
        { name: 'icon.sys', data: makeIconSys(code) },
        { name: 'VIEW.ICO', data: base64ToBytes(Assets.viewIco) },
        { name: 'TYPE', data: TYPE_FILE.slice() },
        { name: dirName, data: body },
        { name: 'EXTRA', data: u32Bytes(crc32(body)) },
      ],
    };
  }

  // ------------------------------------------------------------ AR MAX (.max)
  // Header: "Ps2PowerSave", CRC32 (of whole file with this field zeroed), dir name[32], title[32],
  // stored size (LZARI bytes + 4), file count, raw size, LZARI stream. Raw archive entries are
  // { u32 size, char name[32], data } padded so every entry starts at 8 mod 16.
  const MAX_MAGIC = 'Ps2PowerSave';

  function packMaxArchive(files) {
    const parts = [];
    let off = 0;
    for (const f of files) {
      const head = new Uint8Array(36);
      putU32(head, 0, f.data.length);
      putCString(head, 4, 32, f.name);
      parts.push(head, f.data);
      off += 36 + f.data.length;
      const padded = Math.ceil((off + 8) / 16) * 16 - 8;
      parts.push(new Uint8Array(padded - off));
      off = padded;
    }
    return concat(parts);
  }

  function buildMax(save) {
    const raw = packMaxArchive(save.files);
    const packed = Lzari.encode(raw);
    const header = new Uint8Array(0x5C);
    putCString(header, 0, 12, MAX_MAGIC);
    putCString(header, 0x10, 32, save.dirName);
    putCString(header, 0x30, 32, save.title);
    putU32(header, 0x50, packed.length + 4);
    putU32(header, 0x54, save.files.length);
    putU32(header, 0x58, raw.length);
    const out = concat([header, packed]);
    putU32(out, 0x0C, crc32(out));
    return out;
  }

  function readMax(bytes) {
    if (cString(bytes, 0, 12) !== MAX_MAGIC) throw new Error('Not an AR MAX save (missing Ps2PowerSave header).');
    const stored = u32(bytes, 0x0C);
    const zeroed = bytes.slice(); zeroed.fill(0, 0x0C, 0x10);
    const count = u32(bytes, 0x54), rawSize = u32(bytes, 0x58);
    const raw = Lzari.decode(bytes.subarray(0x5C), rawSize);
    const files = [];
    let off = 0;
    for (let i = 0; i < count; i++) {
      const size = u32(raw, off);
      files.push({ name: cString(raw, off + 4, 32), data: raw.slice(off + 36, off + 36 + size) });
      off = Math.ceil((off + 36 + size + 8) / 16) * 16 - 8;
    }
    return {
      format: 'max',
      dirName: cString(bytes, 0x10, 32),
      title: cString(bytes, 0x30, 32),
      files,
      crcOk: crc32(zeroed) === stored,
    };
  }

  // ------------------------------------------------------------ PSU (.psu)
  // Sequence of 512-byte memory-card directory entries; file data padded to 1 KB.
  const PSU_DIR = 0x8427, PSU_PARENT = 0xA426, PSU_FILE = 0x8497;

  function psuTime(date) {
    const t = new Uint8Array(8);
    t[1] = date.getSeconds(); t[2] = date.getMinutes(); t[3] = date.getHours();
    t[4] = date.getDate(); t[5] = date.getMonth() + 1;
    t[6] = date.getFullYear() & 255; t[7] = date.getFullYear() >> 8;
    return t;
  }
  function psuEntry(mode, length, name, date) {
    const e = new Uint8Array(512);
    e[0] = mode & 255; e[1] = mode >> 8;
    putU32(e, 4, length);
    e.set(psuTime(date), 8);
    e.set(psuTime(date), 24);
    putCString(e, 64, 32, name);
    return e;
  }

  function buildPsu(save, date) {
    date = date || new Date();
    const parts = [
      psuEntry(PSU_DIR, save.files.length + 2, save.dirName, date),
      psuEntry(PSU_DIR, 0, '.', date),
      psuEntry(PSU_PARENT, 0, '..', date),
    ];
    for (const f of save.files) {
      parts.push(psuEntry(PSU_FILE, f.data.length, f.name, date), f.data);
      const pad = (1024 - (f.data.length % 1024)) % 1024;
      if (pad) parts.push(new Uint8Array(pad));
    }
    return concat(parts);
  }

  function readPsu(bytes) {
    const dirName = cString(bytes, 64, 32);
    const entryCount = u32(bytes, 4);
    const files = [];
    let off = 512 * 3;
    for (let i = 0; i < entryCount - 2 && off + 512 <= bytes.length; i++) {
      const size = u32(bytes, off + 4);
      const name = cString(bytes, off + 64, 32);
      files.push({ name, data: bytes.slice(off + 512, off + 512 + size) });
      off += 512 + Math.ceil(size / 1024) * 1024;
    }
    return { format: 'psu', dirName, title: '', files };
  }

  // ------------------------------------------------------------ high level
  // Finds the playbook body inside a PS2 save and checks its EXTRA CRC.
  function ps2PlaybookFromSave(save) {
    const bodyFile = save.files.find(f => f.name === save.dirName) || save.files.find(f => f.data.length === Playbook.SIZE);
    if (!bodyFile) throw new Error('No playbook data file found in the PS2 save.');
    const extra = save.files.find(f => f.name === 'EXTRA');
    const extraOk = extra && extra.data.length === 4 ? u32(extra.data, 0) === crc32(bodyFile.data) : null;
    return { body: bodyFile.data, code: save.dirName.startsWith(PS2_GAME_ID) ? save.dirName.slice(PS2_GAME_ID.length) : '', extraOk };
  }

  // Loads any supported single file: .max, .psu, an Xbox SAVEGAME.DAT, or a raw body.
  function loadPlaybookFile(name, bytes) {
    const lower = name.toLowerCase();
    if (cString(bytes, 0, 12) === MAX_MAGIC) {
      const save = readMax(bytes);
      return Object.assign({ source: 'PS2 .max', containerOk: save.crcOk }, ps2PlaybookFromSave(save));
    }
    if (lower.endsWith('.psu') || (bytes.length > 1536 && u32(bytes, 0) === PSU_DIR)) {
      return Object.assign({ source: 'PS2 .psu', containerOk: null }, ps2PlaybookFromSave(readPsu(bytes)));
    }
    if (bytes.length === Playbook.SIZE) {
      return { source: lower.endsWith('.dat') ? 'Xbox SAVEGAME.DAT' : 'Raw playbook', body: bytes, code: '', extraOk: null, containerOk: null };
    }
    throw new Error(`Unrecognized file (${bytes.length} bytes). Expected .max, .psu or a ${Playbook.SIZE}-byte playbook.`);
  }

  function convertXboxToPs2(xboxBody, code, format) {
    code = sanitizeCode(code);
    if (!code) throw new Error('A team/book code (letters or digits) is required.');
    const body = Playbook.toPs2(xboxBody);
    const save = ps2PlaybookFiles(body, code);
    if (format === 'psu') return { fileName: `${save.dirName}.psu`, bytes: buildPsu(save) };
    return { fileName: `SLUS-20919 ESPN NFL 2K5 ${code}.max`, bytes: buildMax(save) };
  }

  const api = {
    PS2_GAME_ID, crc32, sanitizeCode, parseSaveMeta, signXboxSave, makeSaveMeta, xboxFolderName, buildXboxSave, toFullwidthSjis, makeIconSys, ps2PlaybookFiles,
    buildMax, readMax, buildPsu, readPsu, ps2PlaybookFromSave, loadPlaybookFile, convertXboxToPs2,
  };
  root.Saves = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
