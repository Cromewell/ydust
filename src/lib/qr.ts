/**
 * Pure TypeScript ISO/IEC 18004 QR Code encoder (Byte mode, Error Correction Level L,
 * Versions 1–10, up to 271 UTF-8 bytes) — zero external dependencies.
 */

export type QrMatrix = {
  version: number;
  size: number;
  modules: boolean[][];
};

type VersionSpec = {
  version: number;
  /** [blockCount, dataCodewordsPerBlock] groups; ecPerBlock is the same for all blocks in the version. */
  groups: [number, number][];
  ecPerBlock: number;
  align: number[];
};

// ISO/IEC 18004 Table 9 (EC Level L) & Table E.1 (Alignment pattern coordinates), Versions 1–10.
const VERSIONS: VersionSpec[] = [
  { version: 1, groups: [[1, 19]], ecPerBlock: 7, align: [] },
  { version: 2, groups: [[1, 34]], ecPerBlock: 10, align: [6, 18] },
  { version: 3, groups: [[1, 55]], ecPerBlock: 15, align: [6, 22] },
  { version: 4, groups: [[1, 80]], ecPerBlock: 20, align: [6, 26] },
  { version: 5, groups: [[1, 108]], ecPerBlock: 26, align: [6, 30] },
  { version: 6, groups: [[2, 68]], ecPerBlock: 18, align: [6, 34] },
  { version: 7, groups: [[2, 78]], ecPerBlock: 20, align: [6, 22, 38] },
  { version: 8, groups: [[2, 97]], ecPerBlock: 24, align: [6, 24, 42] },
  { version: 9, groups: [[2, 116]], ecPerBlock: 30, align: [6, 26, 46] },
  {
    version: 10,
    groups: [
      [2, 68],
      [2, 69],
    ],
    ecPerBlock: 18,
    align: [6, 28, 50],
  },
];

// GF(256) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGenerator(ecCount);
  const rem = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecCount - 1] = 0;
    for (let j = 0; j < ecCount; j++) {
      rem[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return rem;
}

function formatBits(mask: number): number {
  // EC Level L = 0b01
  const data = (0b01 << 3) | mask;
  let rem = data << 10;
  for (let i = 4; i >= 0; i--) {
    if (rem & (1 << (i + 10))) rem ^= 0x537 << i;
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version: number): number {
  let rem = version << 12;
  for (let i = 5; i >= 0; i--) {
    if (rem & (1 << (i + 12))) rem ^= 0x1f25 << i;
  }
  return (version << 12) | rem;
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalty(grid: boolean[][]): number {
  const n = grid.length;
  let score = 0;
  // Rule 1: runs of 5+ same-coloured modules in rows & columns
  for (let r = 0; r < n; r++) {
    let runR = 1;
    let runC = 1;
    for (let i = 1; i < n; i++) {
      if (grid[r][i] === grid[r][i - 1]) runR++;
      else {
        if (runR >= 5) score += runR - 2;
        runR = 1;
      }
      if (grid[i][r] === grid[i - 1][r]) runC++;
      else {
        if (runC >= 5) score += runC - 2;
        runC = 1;
      }
    }
    if (runR >= 5) score += runR - 2;
    if (runC >= 5) score += runC - 2;
  }
  // Rule 2: 2x2 blocks
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
    }
  }
  // Rule 4: dark/light balance
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (grid[r][c]) dark++;
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/** Encode a UTF-8 string (up to ~271 bytes) into a QR Code matrix. */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const spec = VERSIONS.find((v) => {
    const cap = v.groups.reduce((sum, [cnt, dc]) => sum + cnt * dc, 0);
    const overheadBits = 4 + (v.version <= 9 ? 8 : 16);
    return Math.ceil((overheadBits + bytes.length * 8) / 8) <= cap;
  });
  if (!spec) throw new Error("Text is too long for QR versions 1–10.");

  const totalDataCw = spec.groups.reduce((sum, [cnt, dc]) => sum + cnt * dc, 0);
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  // Mode 0100 (Byte), count, payload, terminator, byte-align, pad bytes
  pushBits(0b0100, 4);
  pushBits(bytes.length, spec.version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);
  const maxBits = totalDataCw * 8;
  pushBits(0, Math.min(4, maxBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const pad = [0xec, 0x11];
  for (let i = 0; bits.length < maxBits; i++) pushBits(pad[i & 1], 8);

  const dataCw = new Uint8Array(totalDataCw);
  for (let i = 0; i < totalDataCw; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
    dataCw[i] = b;
  }

  // Split into RS blocks & interleave
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [count, len] of spec.groups) {
    for (let i = 0; i < count; i++) {
      const slice = dataCw.subarray(offset, offset + len);
      offset += len;
      dataBlocks.push(slice);
      ecBlocks.push(rsRemainder(slice, spec.ecPerBlock));
    }
  }
  const codewords: number[] = [];
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const b of dataBlocks) if (i < b.length) codewords.push(b[i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const e of ecBlocks) codewords.push(e[i]);
  }

  // Build matrix & function patterns
  const size = spec.version * 4 + 17;
  const base: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  const isFunc: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  const setFunc = (r: number, c: number, dark: boolean) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    base[r][c] = dark;
    isFunc[r][c] = true;
  };

  // Finder patterns + separators
  const drawFinder = (r0: number, c0: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const border = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunc(r0 + dr, c0 + dc, inside && (border || core));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  for (const ar of spec.align) {
    for (const ac of spec.align) {
      if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunc(ar + dr, ac + dc, dist !== 1);
        }
      }
    }
  }

  // Reserve format info + dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFunc(8, i, false);
      setFunc(i, 8, false);
    }
  }
  for (let i = size - 8; i < size; i++) {
    setFunc(8, i, false);
    setFunc(i, 8, false);
  }
  setFunc(size - 8, 8, true);

  // Version info (versions >= 7)
  if (spec.version >= 7) {
    const vb = versionBits(spec.version);
    for (let i = 0; i < 18; i++) {
      const bit = ((vb >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFunc(a, b, bit);
      setFunc(b, a, bit);
    }
  }

  // Place data bits in zigzag columns
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let dx = 0; dx < 2; dx++) {
        const c = right - dx;
        if (isFunc[r][c]) continue;
        let dark = false;
        if (bitIdx < totalBits) {
          dark = ((codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) === 1;
          bitIdx++;
        }
        base[r][c] = dark;
      }
    }
  }

  const writeFormat = (grid: boolean[][], mask: number) => {
    const fb = formatBits(mask);
    // Around top-left finder
    for (let i = 0; i <= 5; i++) grid[8][i] = ((fb >>> (14 - i)) & 1) === 1;
    grid[8][7] = ((fb >>> 8) & 1) === 1;
    grid[8][8] = ((fb >>> 7) & 1) === 1;
    grid[7][8] = ((fb >>> 6) & 1) === 1;
    for (let i = 9; i < 15; i++) grid[14 - i][8] = ((fb >>> (14 - i)) & 1) === 1;
    // Bottom-left & top-right
    for (let i = 0; i < 7; i++) grid[size - 1 - i][8] = ((fb >>> (14 - i)) & 1) === 1;
    for (let i = 0; i < 8; i++) grid[8][size - 8 + i] = ((fb >>> (7 - i)) & 1) === 1;
  };

  // Pick the lowest-penalty mask
  let bestGrid = base;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    const fn = MASKS[m];
    const grid = base.map((row, r) => row.map((v, c) => (isFunc[r][c] ? v : fn(r, c) ? !v : v)));
    writeFormat(grid, m);
    const sc = penalty(grid);
    if (sc < bestScore) {
      bestScore = sc;
      bestGrid = grid;
    }
  }

  return { version: spec.version, size, modules: bestGrid };
}

/** Build a single SVG path string (`d`) for all dark modules (1×1 units, offset by quietZone). */
export function qrSvgPath(qr: QrMatrix, quietZone = 4): string {
  const parts: string[] = [];
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r][c]) parts.push(`M${c + quietZone},${r + quietZone}h1v1h-1z`);
    }
  }
  return parts.join("");
}
