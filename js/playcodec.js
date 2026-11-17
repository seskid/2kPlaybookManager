// NFL 2K5 play codec: assignment nodes, operand bit layouts, the game's play validator and play art.
// Ported from 2k-football-mod-tools mod_editor/core/nfl2k5_play_codec.py (MIT, Noah and contributors),
// which in turn ports the retail consumers in default.xbe.
//
// A node is 8 bytes: opcode, flag byte, two zero bytes, then a 32-bit packed operand word.
// Coordinates are stored in feet (x biased by 0x80, y by 0x40) and decoded here to centimetres.
(function (root) {
  'use strict';

  const FT_CM = 30.48, YD_CM = 91.44;
  const SLOT_COUNT = 11;

  // Opcode table flags (retail 0x521078). Low nibble: which play families may use the opcode;
  // 0x80 needs the ball, 0x40 changes possession, 0x2000 may end an assigned chain.
  const OPCODE_FLAGS = [
    0x200F, 0x000F, 0x08C5, 0x1805, 0x3081, 0x20C4, 0x20C1, 0x20C4, 0x2044,
    0x2348, 0x2004, 0x2002, 0x2008, 0x210A, 0x210A, 0x210A, 0x2008, 0x200D,
    0x2101, 0x20C1, 0x2481, 0x2089, 0x2141, 0x2501, 0x200F, 0x220A, 0x2205,
    0x080A, 0x080A,
  ];
  const OPCODE_COUNT = OPCODE_FLAGS.length;

  const OPCODE_NAMES = {
    0x00: 'None', 0x01: 'Start', 0x02: 'Snap To', 0x03: 'Ball Action', 0x04: 'Special Move',
    0x05: 'Hold For Kick', 0x06: 'Dropback / Pass', 0x07: 'Punt Kick', 0x08: 'Place Kick',
    0x09: 'Run To Point', 0x0A: 'Coverage Sprint', 0x0B: 'Rush Lane', 0x0C: 'Rush Lane B',
    0x0D: 'Zone Coverage', 0x0E: 'Man Coverage', 0x0F: 'Move', 0x10: 'Rush Direction',
    0x11: 'Block Leg', 0x12: 'Route Segment', 0x13: 'Handoff To', 0x14: 'Fake Handoff To',
    0x15: 'Follow / Run Path', 0x16: 'Take Handoff', 0x17: 'Fake Take Handoff',
    0x18: 'Release Downfield', 0x19: '(invalid)', 0x1A: 'Motion / Link', 0x1B: 'Defense Start',
    0x1C: 'Defense Align',
  };

  const LANE_TABLE_CM = [-685.8, -533.4, -457.2, -381.0, -304.8, -228.6, -152.4, -76.2, 0.0,
    76.2, 152.4, 228.6, 304.8, 381.0, 457.2, 533.4, 685.8];
  const LANE_NONE = 17;
  const NAMED_SPOT_X_FT = [11, -14, 2, -6, 7, -11, -2, 8, -9, 37, -36, 0];
  const NAMED_SPOT_Y_FT = [2, 2, 2, 2, 11, 11, 11, 30, 30, 10, 9, 0];

  const ROUTE_SEGMENT_TYPES = {
    0: 'Straight', 1: 'Straight, then 30° break', 2: 'Straight, then 45° break (post/corner)',
    3: 'Straight, then 60° break', 4: 'Lateral in', 5: 'Lateral out',
    6: 'Straight, then 45° opposite break', 7: 'Comeback', 8: 'Chip block',
    9: 'Pass block (side)', 10: 'Straight, then block', 11: 'Comeback (opposite side)',
  };
  const BLOCK_LEG_TYPES = {
    0: 'Drive block (run)', 1: 'Pass set', 2: 'Pull / trap', 3: 'Release, then block',
    4: 'Lead block', 5: 'Move to offset', 6: 'Release (special teams)',
    7: 'Return to formation spot', 8: 'Move to absolute point', 9: 'Move to named spot',
  };
  // Block angle, from the in-game play art: 0 squares up 45° to the left, 1 to the right.
  // The game's mirror swaps 0 and 1.
  const LEG_TURN = { 0: 'Angle left (45°)', 1: 'Angle right (45°)', 2: 'Straight ahead', 3: '(3)' };

  // Category position codes: low 5 bits = kind, high 3 bits = variant.
  const POSITION_KINDS = { 0: 'QB', 1: 'P', 2: 'K', 3: 'H', 4: 'KR', 5: 'T', 6: 'C', 7: 'G', 8: 'TE',
    9: 'WR', 10: 'HB', 11: 'FB', 12: 'DE', 13: 'DT', 14: 'MLB', 15: 'OLB', 16: 'FS', 17: 'SS', 18: 'CB' };

  function positionLabel(code) {
    const kind = code & 0x1F, variant = code >> 5;
    const base = POSITION_KINDS[kind] || `P${kind}`;
    return variant === 0 ? base : `${base}${variant + 1}`;
  }

  // ------------------------------------------------------------ operand codec
  const bits = (p, lo, n) => Math.floor(p / 2 ** lo) % 2 ** n; // safe for unsigned 32-bit
  const decX = (b, mirror) => (mirror ? -(b - 0x80) : b - 0x80) * FT_CM;
  const decY = b => (b - 0x40) * FT_CM;
  const roundHalfAway = v => (v >= 0 ? Math.floor(v + 0.5) : -Math.floor(-v + 0.5));
  const encX = cm => (roundHalfAway(cm / FT_CM) + 0x80) & 0xFF;
  const encY = cm => (roundHalfAway(cm / FT_CM) + 0x40) & 0xFF;
  const encTime = s => Math.max(0, Math.min(63, roundHalfAway(s * 10)));
  const decLane = (v, mirror) => (v === 0x11 ? LANE_NONE : mirror ? 0x10 - v : v);
  const encLane = v => (v === LANE_NONE ? 0x11 : v & 0x1F);
  const swapSide = side => ((side & 3) === 1 ? (side & ~3) | 2 : (side & 3) === 2 ? (side & ~3) | 1 : side);

  // Port of the per-opcode decode callbacks. Returns operands in cm / seconds / ints.
  function decodeOperands(op, p, mirror) {
    const b = (lo, n) => bits(p, lo, n);
    switch (op) {
      case 0x00: case 0x05: return [];
      case 0x01: return [b(0, 2), b(8, 4), b(12, 2), b(2, 6) * 0.1, decX(b(24, 8), mirror), decY(b(16, 8))];
      case 0x02: case 0x03: return [b(0, 4)];
      case 0x04: return [b(0, 2), decX(b(24, 8), mirror), decY(b(16, 8)), b(2, 1)];
      case 0x06: return [b(0, 3), b(4, 4), b(8, 4), b(12, 4), b(16, 4), b(20, 6) * 0.1];
      case 0x07: case 0x08: return [b(0, 3), decX(b(24, 8), mirror), decY(b(16, 8)), b(3, 5) * 3 - 30];
      case 0x09: return [b(0, 4), decX(b(24, 8), mirror), decY(b(16, 8)), b(4, 3)];
      case 0x0A: case 0x10: {
        const t = b(0, 4), y = decY(b(16, 8));
        return [t, decX(b(24, 8), mirror), t === 2 || t === 3 ? -y : y];
      }
      case 0x0B: case 0x0C: return [b(0, 4), decLane(b(27, 5), mirror), b(4, 6) * 0.1];
      case 0x0D: {
        const side = mirror ? swapSide(b(8, 4)) : b(8, 4);
        return [decX(b(24, 8), mirror), decY(b(16, 8)), b(0, 4), b(4, 4), side, b(12, 1), b(13, 3)];
      }
      case 0x0E: {
        const side = mirror ? swapSide(b(20, 4)) : b(20, 4);
        return [b(0, 1), decY(b(4, 8)), b(12, 4), b(16, 4), side, b(24, 4), b(1, 3), b(28, 1)];
      }
      case 0x0F: return [b(0, 4), b(4, 4), b(8, 4), decX(b(24, 8), mirror), decY(b(16, 8))];
      case 0x11: {
        const v = b(0, 5), leg = v % 10, group = Math.floor(v / 10);
        let turn = b(14, 2);
        if (mirror && turn === 0) turn = 1; else if (mirror && turn === 1) turn = 0;
        const xy = leg === 9 ? [b(24, 8), b(16, 8)] : [decX(b(24, 8), mirror), decY(b(16, 8))];
        return [leg, b(6, 6) * 0.1, b(5, 1), b(12, 2), turn, xy[0], xy[1], group];
      }
      case 0x12: {
        const t = b(0, 4);
        let d = decY(b(24, 8));
        if (t === 9 && mirror) d = -d;
        return [t, b(4, 1), d, b(20, 4)];
      }
      case 0x13: case 0x14: return [b(0, 4), b(4, 4)];
      case 0x15: return [b(14, 2), decX(b(24, 8), mirror), decY(b(16, 8)), b(8, 2), b(0, 4), b(4, 4), b(10, 4)];
      case 0x16: case 0x17: {
        const v = b(28, 4);
        return [b(0, 4), b(4, 6) * 0.1, v === 0 ? 0 : mirror ? 9 - v : v];
      }
      case 0x18: return [b(14, 2), decX(b(24, 8), mirror), decY(b(16, 8)), b(12, 2), b(0, 4), b(4, 4), b(8, 4)];
      case 0x19: return [b(0, 3), decX(b(24, 8), mirror), decY(b(16, 8)), b(4, 4), b(8, 3), b(3, 1), b(12, 4)];
      case 0x1A: return [b(0, 3), decX(b(24, 8), mirror), decY(b(16, 8)), b(12, 4), b(8, 3), b(3, 1), b(4, 4), b(11, 1)];
      case 0x1B: return [b(0, 2), b(2, 2), decX(b(24, 8), mirror), decY(b(16, 8)), decLane(b(4, 5), mirror), b(9, 1)];
      case 0x1C: return [b(0, 2), decLane(b(2, 5), mirror), b(8, 2), 0, b(16, 4), 0];
      default: return [];
    }
  }

  // Port of the per-opcode encode callbacks (inverse of decode, unmirrored).
  function encodeOperands(op, v) {
    const i = (k, n) => Math.round(Number(v[k] || 0)) & ((1 << n) - 1);
    const sh = (x, n) => x * 2 ** n; // shifts without 32-bit sign problems
    let r;
    switch (op) {
      case 0x00: case 0x05: return 0;
      case 0x01: r = i(0, 2) + sh(i(1, 4), 8) + sh(i(2, 2), 12) + sh(encTime(v[3]), 2) + sh(encX(v[4]), 24) + sh(encY(v[5]), 16); break;
      case 0x02: case 0x03: r = i(0, 4); break;
      case 0x04: r = i(0, 2) + sh(encX(v[1]), 24) + sh(encY(v[2]), 16) + sh(i(3, 1), 2); break;
      case 0x06: r = i(0, 3) + sh(i(1, 4), 4) + sh(i(2, 4), 8) + sh(i(3, 4), 12) + sh(i(4, 4), 16) + sh(encTime(v[5]), 20); break;
      case 0x07: case 0x08: {
        const a = Math.max(0, Math.min(31, roundHalfAway((Number(v[3]) + 30) / 3)));
        r = i(0, 3) + sh(encX(v[1]), 24) + sh(encY(v[2]), 16) + sh(a, 3); break;
      }
      case 0x09: r = i(0, 4) + sh(encX(v[1]), 24) + sh(encY(v[2]), 16) + sh(i(3, 3), 4); break;
      case 0x0A: case 0x10: {
        const t = i(0, 4), y = t === 2 || t === 3 ? -Number(v[2]) : Number(v[2]);
        r = t + sh(encX(v[1]), 24) + sh(encY(y), 16); break;
      }
      case 0x0B: case 0x0C: r = i(0, 4) + sh(encLane(Math.round(v[1])), 27) + sh(encTime(v[2]), 4); break;
      case 0x0D: r = sh(encX(v[0]), 24) + sh(encY(v[1]), 16) + i(2, 4) + sh(i(3, 4), 4) + sh(i(4, 4), 8) + sh(i(5, 1), 12) + sh(i(6, 3), 13); break;
      case 0x0E: r = i(0, 1) + sh(encY(v[1]), 4) + sh(i(2, 4), 12) + sh(i(3, 4), 16) + sh(i(4, 4), 20) + sh(i(5, 4), 24) + sh(i(6, 3), 1) + sh(i(7, 1), 28); break;
      case 0x0F: r = i(0, 4) + sh(i(1, 4), 4) + sh(i(2, 4), 8) + sh(encX(v[3]), 24) + sh(encY(v[4]), 16); break;
      case 0x11: {
        const leg = Math.round(v[0]) % 10, group = v.length > 7 ? Math.round(v[7]) : 0;
        const code = (leg + 10 * group) & 0x1F;
        const xy = leg === 9 ? sh(Math.round(v[5]) & 0xFF, 24) + sh(Math.round(v[6]) & 0xFF, 16) : sh(encX(v[5]), 24) + sh(encY(v[6]), 16);
        r = code + sh(encTime(v[1]), 6) + sh(i(2, 1), 5) + sh(i(3, 2), 12) + sh(i(4, 2), 14) + xy; break;
      }
      case 0x12: r = i(0, 4) + sh(i(1, 1), 4) + sh(i(3, 4), 20) + sh(encY(v[2]), 24); break;
      case 0x13: case 0x14: r = i(0, 4) + sh(i(1, 4), 4); break;
      case 0x15: r = sh(i(0, 2), 14) + sh(encX(v[1]), 24) + sh(encY(v[2]), 16) + sh(i(3, 2), 8) + i(4, 4) + sh(i(5, 4), 4) + sh(i(6, 4), 10); break;
      case 0x16: case 0x17: r = i(0, 4) + sh(encTime(v[1]), 4) + sh(i(2, 4), 28); break;
      case 0x18: r = sh(i(0, 2), 14) + sh(encX(v[1]), 24) + sh(encY(v[2]), 16) + sh(i(3, 2), 12) + i(4, 4) + sh(i(5, 4), 4) + sh(i(6, 4), 8); break;
      case 0x19: r = i(0, 3) + sh(encX(v[1]), 24) + sh(encY(v[2]), 16) + sh(i(3, 4), 4) + sh(i(4, 3), 8) + sh(i(5, 1), 3) + sh(i(6, 4), 12); break;
      case 0x1A: r = i(0, 3) + sh(encX(v[1]), 24) + sh(encY(v[2]), 16) + sh(i(3, 4), 12) + sh(i(4, 3), 8) + sh(i(5, 1), 3) + sh(i(6, 4), 4) + sh(i(7, 1), 11); break;
      case 0x1B: r = i(0, 2) + sh(i(1, 2), 2) + sh(encX(v[2]), 24) + sh(encY(v[3]), 16) + sh(encLane(Math.round(v[4])), 4) + sh(i(5, 1), 9); break;
      case 0x1C: r = i(0, 2) + sh(encLane(Math.round(v[1])), 2) + sh(i(2, 2), 8) + sh(i(4, 4), 16); break;
      default: throw new Error(`unknown opcode 0x${op.toString(16)}`);
    }
    return r >>> 0;
  }

  // A node as stored: { op, flags, packed } plus helpers.
  function readNode(body, offset) {
    const packed = (body[offset + 4] | (body[offset + 5] << 8) | (body[offset + 6] << 16) | (body[offset + 7] << 24)) >>> 0;
    return { op: body[offset], flags: body[offset + 1], packed };
  }
  const nodeOperands = n => decodeOperands(n.op, n.packed, false);
  const entryFlags = op => OPCODE_FLAGS[op >= 0 && op < OPCODE_COUNT ? op : 0];
  const opget = (n, idx) => { const v = nodeOperands(n); return idx < v.length ? v[idx] : 0; };

  // ------------------------------------------------------------ validator (port of FUN_001a9840 and helpers)
  function validateCallback(n, slot, playFlags) {
    const p = n.packed;
    if (n.op === 0x02 || n.op === 0x13 || n.op === 0x14) { const v = p & 0xF; return v <= 10 && v !== slot; }
    if (n.op === 0x03) {
      const v = p & 0xF, fam = (playFlags >> 6) & 7;
      return ({ 0: v !== 2, 2: v === 3, 4: v === 1, 6: v === 2 })[fam] || false;
    }
    if (n.op === 0x12) {
      if ((p & 0xF) === 9) return true;
      return !((bits(p, 24, 8) - 0x40) * FT_CM < 0);
    }
    return true;
  }

  // assignments: [{ desc, nodes: [node] }] for all 11 slots. Port of FUN_001a91a0.
  function analyzeChain(playFlags, assignments, slot, descOverride) {
    const nodes = assignments[slot].nodes;
    const desc = descOverride !== undefined ? descOverride : assignments[slot].desc;
    const count = desc & 0xF;
    const fail = (reason, andNib, feat) => ({ ok: false, reason, andNib, feat });
    if (count === 0 || count > nodes.length) return fail('node count is 0 or exceeds chain', 0xF, 0);
    if (!(nodes[count - 1].flags & 0x02)) return fail('last step lacks the end marker', 0xF, 0);
    let andNib = 0xF, feat = 0, sawActionFlag = false, terminal = false, sawDStart = false;
    for (let i = count - 1; i >= 0; i--) {
      const n = nodes[i], op = n.op, ef = entryFlags(op), u16 = n.op | (n.flags << 8);
      const name = OPCODE_NAMES[op] || op;
      if ((desc & 0x10000) && (u16 & 0x200) && !(ef & 0x2000)) return fail(`step ${i} (${name}) may not end an assigned chain`, andNib, feat);
      if (!validateCallback(n, slot, playFlags)) return fail(`step ${i} (${name}) has an invalid value`, andNib, feat);
      if (u16 & 0x400) sawActionFlag = true;
      andNib &= ef;
      if (ef & 0x80) feat |= 1;
      if (op === 0x01) {
        if (sawActionFlag && !terminal) {
          if (Math.trunc(opget(n, 0)) === 1) {
            const o1 = Math.trunc(opget(n, 1));
            if (o1 === 1 || o1 === 3 || o1 === 6) terminal = true;
            else if (o1 === 2) terminal = (feat & 2) === 2;
          } else terminal = false;
        }
      } else if (op === 0x02) feat |= 0x22;
      else if (op === 0x05 || op === 0x13) feat |= 0x20;
      else if (op === 0x03) { feat |= 8; terminal = true; }
      else if (op === 0x04) { if (Math.trunc(opget(n, 0)) === 2) feat |= 4; }
      else if (op === 0x06) feat |= 0x24;
      else if (op === 0x07 || op === 0x08) feat |= 4;
      else if (op === 0x09) feat |= 1;
      else if (op === 0x0B) feat |= Math.trunc(opget(n, 0)) !== 0 ? 0x10 : 0x20;
      else if (op === 0x0C || op === 0x12) feat |= 0x10;
      else if (op === 0x0D) feat |= 2;
      else if (op === 0x0E) feat |= 8;
      else if (op === 0x11) feat |= 0x40;
      else if (op === 0x15 || op === 0x18) {
        if (op === 0x18 && terminal) feat |= 0x80;
        if (Math.trunc(opget(n, 0)) === 2) {
          const t = Math.trunc(opget(n, 5));
          if (t === slot || t < 0 || t > 10) return fail(`step ${i}: follow target slot ${t} is invalid`, andNib, feat);
          if (Math.trunc(opget(n, 6)) >= (assignments[t].desc & 0xF)) return fail(`step ${i}: follow step exceeds slot ${t}'s chain`, andNib, feat);
        }
      } else if (op === 0x19) return fail(`step ${i}: opcode 0x19 is rejected by the game`, andNib, feat);
      else if (op === 0x1A) {
        const t = Math.trunc(opget(n, 3));
        if (Math.trunc(opget(n, 7)) >= count) return fail(`step ${i}: motion step index exceeds chain`, andNib, feat);
        const kind = Math.trunc(opget(n, 0));
        if (kind === 2 || kind === 3 || kind === 5) {
          if (t === slot || t < 0 || t > 10) return fail(`step ${i}: motion target slot ${t} is invalid`, andNib, feat);
        } else if (kind === 6) {
          if (Math.trunc(opget(n, 5)) !== 0 || Math.trunc(opget(n, 7)) !== 0 || t === slot || t < 0 || t > 10) return fail(`step ${i}: motion link fields are invalid`, andNib, feat);
          const idx = Math.trunc(opget(n, 6));
          if (idx >= (assignments[t].desc & 0xF) || assignments[t].nodes[idx].op !== 0x1A) return fail(`step ${i}: motion link must point at a Motion step of slot ${t}`, andNib, feat);
        }
      } else if (op === 0x1B) {
        if (sawActionFlag && !terminal) terminal = true;
        sawDStart = true;
      } else if (op === 0x1C) {
        if (sawDStart && sawActionFlag && !terminal) terminal = true;
      }
    }
    const err = ballSim(playFlags, assignments, slot, desc);
    if (err) return fail(err, andNib, feat);
    if (!terminal) return fail('chain has no final action', andNib, feat);
    if (!(sawDStart || (playFlags & 0x1C0) !== 0x40 || count < 3)) return fail('defensive chains with 3+ steps must start with Defense Start', andNib, feat);
    if (andNib !== ((desc >> 4) & 0xF)) return fail(`descriptor side nibble does not match its steps`, andNib, feat);
    if (feat !== ((desc >> 8) & 0xFF)) return fail(`descriptor feature byte does not match its steps`, andNib, feat);
    return { ok: true, reason: '', andNib, feat };
  }

  // Port of FUN_001a8fb0: ball possession simulation for carrier chains.
  function ballSim(playFlags, assignments, slot, desc) {
    const nodes = assignments[slot].nodes, count = desc & 0xF;
    if ((desc & 0xF0) !== 0x10) return null;
    let hasBall = !!(desc & 0x200), gotSnap = false, branchState = false, branchIdx = 9999;
    for (let i = 0; i < count; i++) {
      const n = nodes[i], op = n.op, ef = entryFlags(op), name = OPCODE_NAMES[op] || op;
      if (i === branchIdx) hasBall = branchState;
      if (!hasBall && !gotSnap) {
        for (let j = 0; j < SLOT_COUNT; j++) {
          const a = assignments[j];
          if (a.desc & 0x200) {
            for (let k = 0; k < (a.desc & 0xF); k++) {
              if (a.nodes[k].op === 0x02) {
                if (Math.trunc(opget(a.nodes[k], 0)) === slot && k <= i) { hasBall = true; gotSnap = true; }
                break;
              }
            }
          }
        }
      }
      if (op === 0x1A) { branchIdx = Math.trunc(opget(n, 4)); branchState = hasBall; }
      if (ef & 0x80) {
        if (!hasBall) return `step ${i} (${name}) needs the ball but nobody gave it to slot ${slot}`;
      } else if (hasBall && ![0x00, 0x01, 0x03, 0x1A, 0x1B].includes(op)) {
        return `step ${i} (${name}) cannot run while holding the ball`;
      }
      if (ef & 0x40) {
        if ([0x02, 0x06, 0x07, 0x08, 0x13].includes(op)) {
          if (!hasBall) return `step ${i} (${name}) gives the ball away without having it`;
          hasBall = false;
        } else if ([0x05, 0x09, 0x16].includes(op)) {
          if (hasBall) return `step ${i} (${name}) takes the ball while already holding it`;
          hasBall = true;
        } else return `step ${i} (${name}) unexpected ball flag`;
      }
    }
    return null;
  }

  function handoffSums(assignments, slot) {
    const { desc, nodes } = assignments[slot];
    const count = desc & 0xF, a = new Array(count).fill(0), b = new Array(count).fill(0);
    for (let i = count - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.op === 0x13) { const t = Math.trunc(opget(n, 0)); if (t === slot) return null; a[i] = t; }
      else if (n.op === 0x14) { const t = Math.trunc(opget(n, 0)); if (t === slot) return null; b[i] = t; }
      else if (n.op === 0x16) a[i] = -slot;
      else if (n.op === 0x17) b[i] = -slot;
    }
    for (let hi = count - 1; hi >= 0; hi--) {
      for (let lo = hi - 1; lo >= 0; lo--) {
        const differ = ((nodes[hi].flags & 1) === 1) !== ((nodes[lo].flags & 1) === 1);
        if (a[hi] === a[lo] && differ) a[lo] = 0;
        if (b[hi] === b[lo] && differ) b[lo] = 0;
      }
    }
    return [a.reduce((s, x) => s + x, 0), b.reduce((s, x) => s + x, 0)];
  }

  // Returns null when the game would accept the play, else a reason.
  function validatePlay(playFlags, assignments) {
    const fam = (playFlags >> 6) & 7, cat = playFlags & 0x3F;
    if (cat !== 0xE) {
      const ok = { 0: cat <= 3 || cat === 0xC || cat === 0xA, 1: cat >= 4 && cat <= 7, 2: cat === 10, 3: cat === 11,
        4: cat === 12, 5: cat === 13, 6: cat === 8, 7: cat === 9 }[fam];
      if (!ok) return `play type code ${cat} is invalid for family ${fam}`;
    }
    let sumA = 0, sumB = 0, need1 = false, need2 = false, need3 = false;
    for (let s = 0; s < SLOT_COUNT; s++) {
      const chk = analyzeChain(playFlags, assignments, s);
      if (!chk.ok) return `slot ${s}: ${chk.reason}`;
      const sums = handoffSums(assignments, s);
      if (!sums) return `slot ${s}: handoff targets itself`;
      sumA += sums[0]; sumB += sums[1];
      const desc = assignments[s].desc;
      let sideOk;
      if (fam === 0) {
        sideOk = (desc & 0x10) === 0x10;
        if ((desc >> 8) & 2) need1 = true;
        if ((desc >> 8) & 8) need3 = true;
        need2 = true;
      } else if (fam === 1) {
        sideOk = (desc & 0x20) === 0x20;
        need1 = need2 = need3 = true;
      } else if (fam === 2 || fam === 4 || fam === 6) {
        if ((fam === 2 || fam === 4) && (desc & 0x200)) need1 = true;
        sideOk = (desc & 0x40) === 0x40;
        if (need1 || fam === 6) need1 = true;
        if ((desc >> 8) & 4) need2 = true;
        if ((desc >> 8) & 8) need3 = true;
      } else {
        sideOk = (desc & 0x80) === 0x80;
        need1 = need2 = need3 = true;
      }
      if (!sideOk) return `slot ${s}: a step type is not allowed for this play family`;
    }
    if (sumA !== 0 || sumB !== 0) return 'every handoff must be matched by a take-handoff in the target slot';
    if (!(need2 && need3)) return 'play needs a ball handler';
    if (!need1) return 'play needs a snapper';
    return null;
  }

  // Recomputes a descriptor's side nibble and feature byte for its (unchanged-length) chain,
  // keeping the count, high bytes and every other bit exactly as they were.
  function refreshDescriptor(playFlags, assignments, slot) {
    const old = assignments[slot].desc;
    const probe = (old & 0xF) | (0xB0 << 16);
    const chk = analyzeChain(playFlags, assignments, slot, probe);
    return ((old & ~0xFFF0) | (chk.andNib << 4) | (chk.feat << 8)) >>> 0;
  }

  // ------------------------------------------------------------ play art (port of play_art)
  const rot = (dx, dy, deg) => {
    const a = deg * Math.PI / 180;
    return [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
  };

  // Approximate play-call art for one chain. Coordinates in cm, offense-relative (y = downfield).
  // Each segment: { points: [[x,y],...], style, end }, plus nodeIndex for highlighting.
  //
  // Sideways offsets are absolute (+ = offense's right) for every player, not mirrored per side:
  // in stock zone runs every lineman, left and right, carries the same sign, and take-handoff lanes
  // 1-4 pair with rightward paths and 5-8 with leftward ones across all stock run plays.
  // Route segments keep in/out semantics relative to the receiver's side (wideLeft).
  // slotStarts (optional) gives every slot's start so "follow slot N" paths can be drawn.
  //
  // Ball carriers: the in-game play-call art aims the carrier's arrow at his take-handoff lane
  // (dives at the guard, lane 1 tosses just outside the tight end), not along the run-path step.
  // So a carrier gets a solid arrow to the lane's hole (laneTargets, from laneHoles()) and the
  // run-path step itself is drawn faint and dashed.
  function playArt(nodes, start, wideLeft, slotStarts, laneTargets) {
    const side = 1;
    const segs = [];
    let [x, y] = start;
    const add = (points, style, end, nodeIndex) => segs.push({ points, style: style || 'solid', end: end || '', nodeIndex });
    // Only a back who takes a handoff with an aim lane gets the lane arrow; a QB keeper or
    // bootleg has no lane, so his run path is drawn as the main solid arrow.
    const pathIdx = nodes.findIndex(n => n.op === 0x15);
    const hasLane = nodes.some(n => n.op === 0x16 && nodeOperands(n)[2] > 0);
    const freeRun = hasLane && pathIdx >= 0 && Math.trunc(nodeOperands(nodes[pathIdx])[0]) !== 2;
    nodes.forEach((nd, idx) => {
      const v = nodeOperands(nd), op = nd.op;
      if (op === 0x16 && freeRun && laneTargets && laneTargets[v[2]] !== undefined) {
        const hx = laneTargets[v[2]];
        add([[x, y], [hx, 0], [hx, 182.88]], 'solid', 'arrow', idx);
        return; // the carrier's position continues from where he took the handoff
      }
      if (op === 0x15 && freeRun && laneTargets) {
        add([[x, y], [x + v[1], y + v[2]]], 'faint', '', idx);
        x += v[1]; y += v[2];
        return;
      }
      if (op === 0x1A) {
        add([[x, y], [x + v[1] * side, y + v[2]]], 'dashed', 'branch', idx);
      } else if (op === 0x11) {
        let [leg, , , , turn, dx, dy] = v;
        let nx, ny;
        if (leg === 9) { dx = NAMED_SPOT_X_FT[Math.trunc(dx) % 12] * FT_CM; dy = NAMED_SPOT_Y_FT[Math.trunc(dy) % 12] * FT_CM; }
        if (leg === 7) [nx, ny] = start;
        else if (leg === 8) [nx, ny] = [dx, dy];
        else if (leg === 2) {
          add([[x, y], [x, y - 152.4]], 'solid', '', idx); y -= 152.4;
          nx = x + dx * side; ny = y;
          add([[x, y], [nx, ny]], 'solid', '', idx); x = nx; y = ny;
          nx = x; ny = y + dy + 152.4;
        } else { nx = x + dx * side; ny = y + dy; }
        add([[x, y], [nx, ny]], 'solid', [0, 1, 3, 4].includes(leg) ? 'block' : '', idx);
        if ([0, 1, 3, 4].includes(leg) && (turn === 0 || turn === 1)) {
          // Angled block (turn 0 = left, 1 = right): a short stem leaning that way with the block bar
          // across its tip, so the drawing points the way the blocker turns.
          const len = Math.hypot(nx - x, ny - y);
          let [fx, fy] = len > 1 ? [(nx - x) / len, (ny - y) / len] : [0, 1];
          [fx, fy] = rot(fx, fy, turn === 0 ? 45 : -45);
          const stem = 110, half = 73, tx = nx + fx * stem, ty = ny + fy * stem;
          const last = segs[segs.length - 1];
          last.points.push([tx, ty]);
          last.bar = [[tx - fy * half, ty + fx * half], [tx + fy * half, ty - fx * half]];
        }
        x = nx; y = ny;
      } else if (op === 0x12) {
        const t = v[0], dist = Number(v[2]), s = wideLeft ? -1 : 1;
        if (t === 0) { add([[x, y], [x, y + dist]], 'solid', 'arrow', idx); y += dist; }
        else if ([1, 2, 3, 6].includes(t)) {
          add([[x, y], [x, y + dist]], 'solid', '', idx); y += dist;
          const ang = { 1: 30, 2: -45, 3: 60, 6: 45 }[t] * s;
          const [dx, dy] = rot(0, 457.2, -ang);
          add([[x, y], [x + dx, y + dy]], 'solid', 'arrow', idx); x += dx; y += dy;
        } else if (t === 4 || t === 5) {
          const d = dist * s * (t === 4 ? 1 : -1);
          add([[x, y], [x - d, y]], 'solid', 'arrow', idx); x -= d;
        } else if (t === 7 || t === 11) {
          const d = t === 7 ? -60.96 * s : 60.96 * s;
          add([[x, y], [x + d, y - 121.92]], 'solid', 'arrow', idx); x += d; y -= 121.92;
        } else if (t === 8) add([[x, y], [x + 121.92 * s, y]], 'block', 'block', idx);
        else if (t === 9) add([[x, y], [x + (dist >= 0 ? 243.84 : -243.84), y]], 'block', 'block', idx);
        else if (t === 10) {
          add([[x, y], [x, y + dist]], 'solid', '', idx); y += dist;
          add([[x, y], [x + 60.96 * s, y]], 'block', 'block', idx);
        }
      } else if (op === 0x0D) { add([[x, y], [v[0], v[1]]], 'zone', 'zone', idx); [x, y] = [v[0], v[1]]; }
      else if (op === 0x0E) add([[x, y], [x, y - 182.88]], 'man', 'man', idx);
      else if (op === 0x0B || op === 0x0C) {
        const lane = Math.trunc(v[1]);
        const lx = lane >= 0 && lane < LANE_TABLE_CM.length ? LANE_TABLE_CM[lane] : x;
        // Rushers attack past the line, whether they start on it or blitz from depth.
        const ry = Math.min(y, 0) - 213.36;
        // The in-game art draws rush mode 2 (the linebackers' blitzes) dotted and mode 1 solid.
        const style = op === 0x0C ? 'dashed' : Math.trunc(v[0]) === 2 ? 'dotted' : 'solid';
        add([[x, y], [lx, ry]], style, 'arrow', idx); x = lx; y = ry;
      } else if (op === 0x0A || op === 0x10 || op === 0x09) {
        const dx = v[1], dy = v[2];
        add([[x, y], [x + dx * side, y + dy]], 'solid', 'arrow', idx); x += dx * side; y += dy;
      } else if (op === 0x15 && v[0] === 2 && slotStarts && slotStarts[v[5]]) {
        // Follow slot N: run at that player's spot (plus the small offset), through the line.
        const [fx, fy] = slotStarts[v[5]];
        const hx = fx + v[1], hy = Math.max(fy, 0) + v[2];
        add([[x, y], [hx, hy], [hx, hy + 182.88]], 'solid', 'arrow', idx);
        x = hx; y = hy + 182.88;
      } else if (op === 0x15 || op === 0x18) {
        add([[x, y], [x + v[1] * side, y + v[2]]], 'solid', 'arrow', idx);
        x += v[1] * side; y += v[2];
      } else if (op === 0x04) {
        // QB drop / setup move (not drawn by the retail art; shown so drop depth is visible).
        add([[x, y], [x + v[1] * side, y + v[2]]], 'dashed', '', idx); x += v[1] * side; y += v[2];
      } else if (op === 0x08) add([[x, y], [x, y + 182.88]], 'solid', 'arrow', idx);
      else if (op === 0x14) add([[x, y], [x, y - 182.88]], 'dashed', '', idx);
      else if (op === 0x0F) { add([[x, y], [x + v[3] * side, y + v[4]]], 'solid', '', idx); x += v[3] * side; y += v[4]; }
    });
    return segs;
  }

  // Hole positions (cm across) for take-handoff lanes 1-8, placed on the formation's own line:
  // 4/5 at the guards, 3/6 at the tackles, 2/7 a tight-end width outside, 1/8 wide.
  // Lanes 1-4 are on the offense's right (stock runs pair them with rightward paths).
  // Anchored on the in-game art: lane 4 dives end at the guard, lane 1 tosses aim outside the TE.
  function laneHoles(slots, positionCodes) {
    const xs = kind => slots.filter((s, i) => (positionCodes[i] & 0x1F) === kind).map(s => s.x);
    const guards = xs(7), tackles = xs(5);
    const rg = guards.length ? Math.max(...guards) : 155, lg = guards.length ? Math.min(...guards) : -155;
    const rt = tackles.length ? Math.max(...tackles) : 305, lt = tackles.length ? Math.min(...tackles) : -305;
    return { 1: rt + 4.5 * YD_CM, 2: rt + 1.7 * YD_CM, 3: rt, 4: rg, 5: lg, 6: lt, 7: lt - 1.7 * YD_CM, 8: lt - 4.5 * YD_CM };
  }

  const api = {
    FT_CM, YD_CM, SLOT_COUNT, LANE_TABLE_CM, laneHoles, OPCODE_FLAGS, OPCODE_NAMES, ROUTE_SEGMENT_TYPES, BLOCK_LEG_TYPES, LEG_TURN,
    POSITION_KINDS, positionLabel, bits, decodeOperands, encodeOperands, readNode, nodeOperands, entryFlags,
    analyzeChain, validatePlay, refreshDescriptor, playArt,
  };
  root.PlayCodec = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
