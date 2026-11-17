// NFL 2K5 custom playbook body ("PLAY"/"plb", 0x13390 bytes). Identical layout on Xbox and PS2;
// layout per 2k-football-mod-tools/ASTRA_PLAYBOOK_PAIR_REPORT.md.
(function (root) {
  'use strict';

  const SIZE = 0x13390;

  // Fixed tables: [key, label, offset, recordSize, capacity]
  const TABLES = [
    ['formations', 'Formations', 0x134, 180, 50],
    ['formationAux', 'Formation links', 0x245C, 80, 50],
    ['plays', 'Plays', 0x33FC, 96, 270],
    ['categories', 'Categories', 0x993C, 16, 26],
    ['nodes', 'Route nodes', 0x9ADC, 8, 3500],
  ];
  const NAMES_OFFSET = 0x1083C; // u32 UTF-16 character count, then the name pool

  // Header words 0x10..0x1F are runtime values written by whichever console saved the book:
  // two pointers into its custom-book buffer and two code addresses.
  const PLATFORM_HEADER = {
    xbox: [0x00B75A60, 0x00B75A40, 0x001665A0, 0x001665B0],
    ps2: [0x00C15C90, 0x00C15C70, 0x004CD298, 0x004CD2B8],
  };
  const PLATFORM_HEADER_RANGE = [0x10, 0x20];

  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function putU32(b, o, v) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; }
  function ascii(b, o, n) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]); return s; }

  function detectPlatform(body) {
    const code = u32(body, 0x18);
    if (code === PLATFORM_HEADER.xbox[2]) return 'xbox';
    if (code === PLATFORM_HEADER.ps2[2]) return 'ps2';
    return 'unknown';
  }

  function readNames(body) {
    const count = u32(body, NAMES_OFFSET);
    const end = Math.min(SIZE, NAMES_OFFSET + 4 + count * 2);
    const names = [];
    let cur = '';
    for (let o = NAMES_OFFSET + 4; o + 1 < end; o += 2) {
      const ch = body[o] | (body[o + 1] << 8);
      if (ch === 0) { names.push(cur); cur = ''; } else cur += String.fromCharCode(ch);
    }
    if (cur) names.push(cur);
    return names;
  }

  // Validates a body and returns its summary. errors[] empty means it looks like a playbook.
  function inspect(body) {
    const errors = [];
    if (!body || body.length !== SIZE) {
      errors.push(`Expected ${SIZE} bytes, got ${body ? body.length : 0}.`);
      return { ok: false, errors };
    }
    if (ascii(body, 0x0C, 4) !== 'PLAY') errors.push('Missing "PLAY" tag at 0x0C.');
    if (body[0x20] !== 0x70 || body[0x22] !== 0x6C || body[0x24] !== 0x62) errors.push('Missing "plb" tag at 0x20.');
    const counts = {
      formations: u32(body, 0x34),
      plays: u32(body, 0x38),
      categories: u32(body, 0x3C),
      nodes: u32(body, 0x40),
    };
    for (const [key, label, , , cap] of TABLES) {
      if (key in counts && counts[key] > cap) errors.push(`${label} count ${counts[key]} exceeds capacity ${cap}.`);
    }
    const names = errors.length ? [] : readNames(body);
    return {
      ok: errors.length === 0,
      errors,
      platform: detectPlatform(body),
      counts,
      names,
      bookName: names[0] || '',
    };
  }

  // Returns a copy of an Xbox (or already-PS2) body with PS2 runtime header words.
  function toPs2(body) {
    const out = new Uint8Array(body);
    PLATFORM_HEADER.ps2.forEach((v, i) => putU32(out, 0x10 + i * 4, v));
    return out;
  }

  // Returns a copy with Xbox runtime header words (used when saving a PS2-sourced book for Xbox).
  function toXbox(body) {
    const out = new Uint8Array(body);
    PLATFORM_HEADER.xbox.forEach((v, i) => putU32(out, 0x10 + i * 4, v));
    return out;
  }

  // Byte-level comparison grouped by table/record. Returns { regions[], totalBytes, unexpectedBytes }.
  function compare(a, b) {
    const regions = [];
    function diffRange(start, end) {
      const bytes = [];
      for (let o = start; o < end; o++) if (a[o] !== b[o]) bytes.push(o);
      return bytes;
    }
    function pushRegion(key, label, start, end, recordSize, expectedRanges) {
      const records = [];
      let count = 0, unexpected = 0;
      const n = recordSize ? (end - start) / recordSize : 1;
      for (let i = 0; i < n; i++) {
        const rs = start + i * (recordSize || end - start);
        const re = recordSize ? rs + recordSize : end;
        const bytes = diffRange(rs, re);
        if (!bytes.length) continue;
        const expected = bytes.filter(o => (expectedRanges || []).some(([s, e]) => o >= s && o < e));
        count += bytes.length;
        unexpected += bytes.length - expected.length;
        records.push({ index: recordSize ? i : null, start: rs, end: re, bytes, expectedCount: expected.length });
      }
      regions.push({ key, label, start, end, recordSize, records, count, unexpected });
    }
    pushRegion('header', 'Header', 0, 0x134, 0, [PLATFORM_HEADER_RANGE]);
    for (const [key, label, off, size, cap] of TABLES) pushRegion(key, label, off, off + size * cap, size);
    pushRegion('names', 'Name pool', NAMES_OFFSET, SIZE, 0);
    const totalBytes = regions.reduce((s, r) => s + r.count, 0);
    const unexpectedBytes = regions.reduce((s, r) => s + r.unexpected, 0);
    return { regions, totalBytes, unexpectedBytes };
  }

  const api = { SIZE, TABLES, NAMES_OFFSET, PLATFORM_HEADER, PLATFORM_HEADER_RANGE, u32, putU32, inspect, readNames, detectPlatform, toPs2, toXbox, compare };
  root.Playbook = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
