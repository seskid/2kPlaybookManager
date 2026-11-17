// LZARI (Haruhiko Okumura, 1989) - the compressor used by Action Replay MAX (.max) PS2 saves.
// Port of the reference lzari.c: N=4096 ring buffer, F=60 lookahead, adaptive arithmetic coding.
(function (root) {
  'use strict';

  const N = 4096, F = 60, THRESHOLD = 2, NIL = N;
  const M = 15, Q1 = 1 << M, Q2 = 2 * Q1, Q3 = 3 * Q1, Q4 = 4 * Q1, MAX_CUM = Q1 - 1;
  const N_CHAR = 256 - THRESHOLD + F;

  function createModel() {
    const m = {
      charToSym: new Int32Array(N_CHAR),
      symToChar: new Int32Array(N_CHAR + 1),
      symFreq: new Int32Array(N_CHAR + 1),
      symCum: new Int32Array(N_CHAR + 1),
      positionCum: new Int32Array(N + 1),
    };
    m.symCum[N_CHAR] = 0;
    for (let sym = N_CHAR; sym >= 1; sym--) {
      const ch = sym - 1;
      m.charToSym[ch] = sym;
      m.symToChar[sym] = ch;
      m.symFreq[sym] = 1;
      m.symCum[sym - 1] = m.symCum[sym] + m.symFreq[sym];
    }
    m.symFreq[0] = 0;
    m.positionCum[N] = 0;
    for (let i = N; i >= 1; i--) m.positionCum[i - 1] = m.positionCum[i] + Math.floor(10000 / (i + 200));
    return m;
  }

  function updateModel(m, sym) {
    if (m.symCum[0] >= MAX_CUM) {
      let c = 0;
      for (let i = N_CHAR; i > 0; i--) {
        m.symCum[i] = c;
        c += (m.symFreq[i] = (m.symFreq[i] + 1) >> 1);
      }
      m.symCum[0] = c;
    }
    let i = sym;
    while (m.symFreq[i] === m.symFreq[i - 1]) i--;
    if (i < sym) {
      const chI = m.symToChar[i], chSym = m.symToChar[sym];
      m.symToChar[i] = chSym; m.symToChar[sym] = chI;
      m.charToSym[chI] = sym; m.charToSym[chSym] = i;
    }
    m.symFreq[i]++;
    while (--i >= 0) m.symCum[i]++;
  }

  // ---------------------------------------------------------------- decode
  function decode(input, outLength) {
    let inPos = 0, mask = 0, buf = 0;
    function getBit() {
      if ((mask >>= 1) === 0) {
        buf = inPos < input.length ? input[inPos] : 0;
        inPos++;
        mask = 128;
      }
      return (buf & mask) ? 1 : 0;
    }

    const m = createModel();
    let low = 0, high = Q4, value = 0;
    for (let i = 0; i < M + 2; i++) value = 2 * value + getBit();

    function normalize() {
      for (;;) {
        if (low >= Q2) { value -= Q2; low -= Q2; high -= Q2; }
        else if (low >= Q1 && high <= Q3) { value -= Q1; low -= Q1; high -= Q1; }
        else if (high > Q2) break;
        low += low; high += high;
        value = 2 * value + getBit();
      }
    }
    function searchSym(x) {
      let i = 1, j = N_CHAR;
      while (i < j) { const k = (i + j) >> 1; if (m.symCum[k] > x) i = k + 1; else j = k; }
      return i;
    }
    function searchPos(x) {
      let i = 1, j = N;
      while (i < j) { const k = (i + j) >> 1; if (m.positionCum[k] > x) i = k + 1; else j = k; }
      return i - 1;
    }
    function decodeChar() {
      const range = high - low;
      const sym = searchSym(Math.floor(((value - low + 1) * m.symCum[0] - 1) / range));
      high = low + Math.floor((range * m.symCum[sym - 1]) / m.symCum[0]);
      low += Math.floor((range * m.symCum[sym]) / m.symCum[0]);
      normalize();
      const ch = m.symToChar[sym];
      updateModel(m, sym);
      return ch;
    }
    function decodePosition() {
      const range = high - low;
      const pos = searchPos(Math.floor(((value - low + 1) * m.positionCum[0] - 1) / range));
      high = low + Math.floor((range * m.positionCum[pos]) / m.positionCum[0]);
      low += Math.floor((range * m.positionCum[pos + 1]) / m.positionCum[0]);
      normalize();
      return pos;
    }

    const text = new Uint8Array(N).fill(0x20);
    const out = new Uint8Array(outLength);
    let r = N - F, o = 0;
    while (o < outLength) {
      const c = decodeChar();
      if (c < 256) {
        out[o++] = c; text[r] = c; r = (r + 1) & (N - 1);
      } else {
        const i = (r - decodePosition() - 1) & (N - 1);
        const j = c - 255 + THRESHOLD;
        for (let k = 0; k < j && o < outLength; k++) {
          const c2 = text[(i + k) & (N - 1)];
          out[o++] = c2; text[r] = c2; r = (r + 1) & (N - 1);
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- encode
  function encode(input) {
    const out = [];
    let bitBuf = 0, bitMask = 128;
    function putBit(bit) {
      if (bit) bitBuf |= bitMask;
      if ((bitMask >>= 1) === 0) { out.push(bitBuf); bitBuf = 0; bitMask = 128; }
    }
    function flushBits() { for (let i = 0; i < 7; i++) putBit(0); }

    const m = createModel();
    let low = 0, high = Q4, shifts = 0;
    function output(bit) { putBit(bit); for (; shifts > 0; shifts--) putBit(bit ? 0 : 1); }
    function renormalize() {
      for (;;) {
        if (high <= Q2) output(0);
        else if (low >= Q2) { output(1); low -= Q2; high -= Q2; }
        else if (low >= Q1 && high <= Q3) { shifts++; low -= Q1; high -= Q1; }
        else break;
        low += low; high += high;
      }
    }
    function encodeChar(ch) {
      const sym = m.charToSym[ch];
      const range = high - low;
      high = low + Math.floor((range * m.symCum[sym - 1]) / m.symCum[0]);
      low += Math.floor((range * m.symCum[sym]) / m.symCum[0]);
      renormalize();
      updateModel(m, sym);
    }
    function encodePosition(position) {
      const range = high - low;
      high = low + Math.floor((range * m.positionCum[position]) / m.positionCum[0]);
      low += Math.floor((range * m.positionCum[position + 1]) / m.positionCum[0]);
      renormalize();
    }

    // Binary search tree for longest-match lookup.
    const text = new Uint8Array(N + F - 1);
    const lson = new Int32Array(N + 1), rson = new Int32Array(N + 257), dad = new Int32Array(N + 1);
    let matchPosition = 0, matchLength = 0;
    for (let i = N + 1; i <= N + 256; i++) rson[i] = NIL;
    for (let i = 0; i < N; i++) dad[i] = NIL;

    function insertNode(r) {
      let cmp = 1, p = N + 1 + text[r], i;
      rson[r] = lson[r] = NIL;
      matchLength = 0;
      for (;;) {
        if (cmp >= 0) {
          if (rson[p] !== NIL) p = rson[p];
          else { rson[p] = r; dad[r] = p; return; }
        } else {
          if (lson[p] !== NIL) p = lson[p];
          else { lson[p] = r; dad[r] = p; return; }
        }
        for (i = 1; i < F; i++) if ((cmp = text[r + i] - text[p + i]) !== 0) break;
        if (i > THRESHOLD) {
          if (i > matchLength) {
            matchPosition = (r - p) & (N - 1);
            if ((matchLength = i) >= F) break;
          } else if (i === matchLength) {
            const temp = (r - p) & (N - 1);
            if (temp < matchPosition) matchPosition = temp;
          }
        }
      }
      dad[r] = dad[p]; lson[r] = lson[p]; rson[r] = rson[p];
      dad[lson[p]] = r; dad[rson[p]] = r;
      if (rson[dad[p]] === p) rson[dad[p]] = r; else lson[dad[p]] = r;
      dad[p] = NIL;
    }
    function deleteNode(p) {
      let q;
      if (dad[p] === NIL) return;
      if (rson[p] === NIL) q = lson[p];
      else if (lson[p] === NIL) q = rson[p];
      else {
        q = lson[p];
        if (rson[q] !== NIL) {
          do { q = rson[q]; } while (rson[q] !== NIL);
          rson[dad[q]] = lson[q]; dad[lson[q]] = dad[q];
          lson[q] = lson[p]; dad[lson[p]] = q;
        }
        rson[q] = rson[p]; dad[rson[p]] = q;
      }
      dad[q] = dad[p];
      if (rson[dad[p]] === p) rson[dad[p]] = q; else lson[dad[p]] = q;
      dad[p] = NIL;
    }

    let inPos = 0, s = 0, r = N - F, len;
    for (let i = s; i < r; i++) text[i] = 0x20;
    for (len = 0; len < F && inPos < input.length; len++) text[r + len] = input[inPos++];
    if (len === 0) return new Uint8Array(0);
    for (let i = 1; i <= F; i++) insertNode(r - i);
    insertNode(r);
    do {
      if (matchLength > len) matchLength = len;
      if (matchLength <= THRESHOLD) {
        matchLength = 1;
        encodeChar(text[r]);
      } else {
        encodeChar(255 - THRESHOLD + matchLength);
        encodePosition(matchPosition - 1);
      }
      const lastMatchLength = matchLength;
      let i;
      for (i = 0; i < lastMatchLength && inPos < input.length; i++) {
        const c = input[inPos++];
        deleteNode(s);
        text[s] = c;
        if (s < F - 1) text[s + N] = c;
        s = (s + 1) & (N - 1); r = (r + 1) & (N - 1);
        insertNode(r);
      }
      while (i++ < lastMatchLength) {
        deleteNode(s);
        s = (s + 1) & (N - 1); r = (r + 1) & (N - 1);
        if (--len) insertNode(r);
      }
    } while (len > 0);

    shifts++;
    output(low < Q1 ? 0 : 1);
    flushBits();
    return Uint8Array.from(out);
  }

  const api = { encode, decode };
  root.Lzari = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
