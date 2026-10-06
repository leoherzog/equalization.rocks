// Module Worker for the Mixer tab: reads a .zip or loose audio files, parses WAV and AIFF headers, unpacks every
// track round-robin into 16-bit stereo-or-mono pieces at the AudioContext rate, stores them in the origin private
// file system, and serves chunks to each track's AudioWorklet node over that track's own MessagePort. One worker per
// loaded session.

const AUDIO_EXT = /\.(wav|wave|aif|aiff|aifc|flac|mp3|m4a|ogg|opus)$/i;
const PIECE_SECONDS = 5;
const PROGRESS_MS = 250;
const HEADER_READS = 6;
const HEAD_BYTES = 4096;
const READ_BYTES = 1024 * 1024;
// Digital silence inflates about 1000:1, which bounds STEP_MAX.
const STEP_MIN = 512;
const STEP_MAX = 32 * 1024;
const EMPTY = new Uint8Array(0);
const DRAINED = {};
const INT8 = 1 / 128;
const INT16 = 1 / 32768;
const INT24 = 1 / 8388608;
const INT32 = 1 / 2147483648;
const YIELD_MS = 8;
// Float sources and stereo folds of multichannel files can exceed full scale, so they are stored at 1/8 scale.
const HEADROOM = 8;
const SAMPLE_BYTES = { uint8: 1, int8: 1, int16: 2, int24: 3, int32: 4, float32: 4, float64: 8 };

let tracks = [];
let rate = 0;
let blockFrames = 0;
let pieceFrames = 0;
let stopped = false;
let decodeWaiter = null;
// This session's OPFS file and its length. Each track's `pieces` hold byte offsets into it, or the pieces themselves
// where OPFS is unavailable and `store` stays null.
let store = null;
let storeEnd = 0;

self.onmessage = ({ data }) => {
  if (data.type === 'open') open(data.files);
  else if (data.type === 'extract') extract(data.sampleRate);
  else if (data.type === 'connect') connect(data.id, data.port);
  else if ((data.type === 'pcm' || data.type === 'pcm-error') && decodeWaiter?.id === data.id) decodeWaiter.resolve(data);
};

// --- Enumeration ---

async function open(files) {
  const found = [];
  for (const file of files) {
    if (isJunk(file.name)) continue;
    if (!/\.zip$/i.test(file.name)) {
      found.push({ file, path: file.name, method: 0, start: 0, size: file.size, usize: file.size });
      continue;
    }
    try {
      found.push(...await zipEntries(file));
    } catch (err) {
      found.push({ file, path: file.name, error: `This zip file could not be read. ${err.message}` });
    }
  }
  found.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  tracks = found.map((t, id) => ({
    ...t, id, name: baseName(t.path), kind: 'decode',
    queue: [], generation: -Infinity, pieces: [], outDone: 0, finished: false, failed: false,
  }));
  await pool(tracks, HEADER_READS, classify);
  postMessage({
    type: 'tracks',
    tracks: tracks.map((t) => {
      const pcm = t.kind === 'pcm';
      return {
        id: t.id, name: t.name, path: t.path, kind: t.kind,
        rate: pcm ? t.rate : null, channels: pcm ? t.channels : null, frames: pcm ? t.frames : null,
        error: t.error ?? null,
      };
    }),
  });
}

/** Sets kind to 'pcm', 'decode', or 'error' from the entry's header. */
async function classify(t) {
  if (!t.error && t.method !== 0 && t.method !== 8) t.error = `This zip uses an unsupported compression method (${t.method}).`;
  if (t.error) {
    t.kind = 'error';
    return;
  }
  try {
    if (t.lho !== undefined) t.start = await localDataStart(t.file, t.lho);
    const pcm = await readHeader(t);
    if (pcm) Object.assign(t, pcm, { kind: 'pcm' });
    else if (!AUDIO_EXT.test(t.path) && !t.file.type.startsWith('audio/')) t.error = 'This is not an audio file.';
    if (pcm && !pcm.frames) t.error = 'This track has no audio.';
  } catch (err) {
    t.error = `This file could not be read. ${err.message}`;
  }
  if (t.error) t.kind = 'error';
}

function baseName(path) {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');
}

async function pool(items, limit, fn) {
  let next = 0;
  const run = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

// --- Zip reading ---
// Offsets pass 2^31 in real sessions: read them with getUint32 and use plain Number math, never bitwise operators.

async function view(blob, start, end) {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

async function readEocd(file) {
  const tail = Math.min(file.size, 22 + 0xffff + 20);
  const base = file.size - tail;
  const v = await view(file, base, file.size);
  for (let i = tail - 22; i >= 0; i--) {
    if (v.getUint32(i, true) !== 0x06054b50 || i + 22 + v.getUint16(i + 20, true) > tail) continue;
    const eocd = { cdSize: v.getUint32(i + 12, true), cdOffset: v.getUint32(i + 16, true) };
    if (i >= 20 && v.getUint32(i - 20, true) === 0x07064b50) {
      const at = Number(v.getBigUint64(i - 12, true));
      const z = await view(file, at, at + 56);
      if (z.getUint32(0, true) === 0x06064b50) {
        eocd.cdSize = Number(z.getBigUint64(40, true));
        eocd.cdOffset = Number(z.getBigUint64(48, true));
      }
    }
    return eocd;
  }
  throw new Error('Its directory is missing.');
}

/** Lists the audio entries of a zip, skipping folders and macOS metadata. Sizes come only from the central directory. */
async function zipEntries(file) {
  const { cdOffset, cdSize } = await readEocd(file);
  if (cdOffset + cdSize > file.size) throw new Error('Its directory is damaged.');
  const v = await view(file, cdOffset, cdOffset + cdSize);
  const decoder = new TextDecoder();
  const entries = [];
  for (let p = 0; p + 46 <= v.byteLength && v.getUint32(p, true) === 0x02014b50;) {
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const path = decoder.decode(new Uint8Array(v.buffer, p + 46, nameLen));
    const e = { file, path, method: v.getUint16(p + 10, true), size: v.getUint32(p + 20, true), usize: v.getUint32(p + 24, true), lho: v.getUint32(p + 42, true) };
    // Zip64 extra: only the fields whose 32-bit slot is 0xFFFFFFFF are present, in this order.
    for (let x = p + 46 + nameLen, end = x + extraLen; x + 4 <= end; x += 4 + v.getUint16(x + 2, true)) {
      if (v.getUint16(x, true) !== 0x0001) continue;
      let q = x + 4;
      for (const key of ['usize', 'size', 'lho']) {
        if (e[key] === 0xffffffff) {
          e[key] = Number(v.getBigUint64(q, true));
          q += 8;
        }
      }
    }
    if (!isJunk(path) && AUDIO_EXT.test(path)) entries.push(e);
    p += 46 + nameLen + extraLen + v.getUint16(p + 32, true);
  }
  return entries;
}

function isJunk(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return path.endsWith('/') || path.startsWith('__MACOSX/') || path.includes('/__MACOSX/') || base.startsWith('._') || base === '.DS_Store';
}

/** Data start from the local header: its extra field length differs from the central directory's. */
async function localDataStart(file, lho) {
  const v = await view(file, lho, lho + 30);
  if (v.getUint32(0, true) !== 0x04034b50) throw new Error('Its zip entry header is damaged.');
  return lho + 30 + v.getUint16(26, true) + v.getUint16(28, true);
}

// --- WAV and AIFF parsing ---

async function readHeader(t) {
  for (let n = HEAD_BYTES; ; n *= 4) {
    const u8 = await headBytes(t, Math.min(n, t.size));
    const pcm = (fourcc(u8, 0) === 'FORM' ? parseAiff : parseWav)(u8, t.usize);
    if (pcm !== undefined || n >= t.size) return pcm ?? null;
  }
}

/** First bytes of an entry, from a bounded compressed prefix so silent tracks are not inflated whole. */
async function headBytes(t, n) {
  const src = t.file.slice(t.start, t.start + n);
  if (t.method === 0) return new Uint8Array(await src.arrayBuffer());
  const reader = src.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
    }
  } catch {
    // Expected: the prefix ends mid-stream ('Compressed input was truncated').
  }
  return concat(parts, parts.reduce((sum, p) => sum + p.length, 0));
}

function fourcc(u8, p) {
  return String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
}

/**
 * Walks RIFF chunks to 'data'. Classifies by format tag, never by fmt size.
 * @returns {object|null|undefined} the stream format, null if not a streamable WAV, undefined if more bytes are needed
 */
function parseWav(u8, size) {
  const complete = u8.length >= size;
  if (u8.length < 12) return complete ? null : undefined;
  if (!['RIFF', 'RF64', 'BW64'].includes(fourcc(u8, 0)) || fourcc(u8, 8) !== 'WAVE') return null;
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let fmt = null;
  let size64 = 0;
  for (let p = 12; p + 8 <= u8.length;) {
    const id = fourcc(u8, p);
    const len = v.getUint32(p + 4, true);
    if (id === 'ds64') {
      if (p + 24 > u8.length) break;
      size64 = Number(v.getBigUint64(p + 16, true));
    } else if (id === 'fmt ') {
      if (p + 24 > u8.length) break;
      let tag = v.getUint16(p + 8, true);
      if (tag === 0xfffe && len >= 40) {
        if (p + 34 > u8.length) break;
        tag = v.getUint16(p + 32, true);
      }
      fmt = sampleFormat(tag, v.getUint16(p + 10, true), v.getUint32(p + 12, true), v.getUint16(p + 20, true), v.getUint16(p + 22, true));
    } else if (id === 'data') {
      if (!fmt) return null;
      // RF64 keeps the real size in ds64. An unfinalized recording leaves the sizes 0 with its audio still in the file.
      const bytes = len === 0xffffffff && size64 ? size64 : len === 0 && v.getUint32(4, true) + 8 < size ? Infinity : len;
      return withFrames(fmt, p + 8, bytes, size);
    }
    p += 8 + len + (len % 2);
  }
  return complete ? null : undefined;
}

function sampleFormat(tag, channels, sampleRate, blockAlign, bits) {
  const bytes = blockAlign / channels;
  const int = tag === 1 && [1, 2, 3, 4].includes(bytes) && Math.ceil(bits / 8) === bytes;
  const float = tag === 3 && (bytes === 4 || bytes === 8) && bits === bytes * 8;
  if (!(int || float) || channels > 32 || !sampleRate) return null;
  const sample = float ? `float${bits}` : bytes === 1 ? 'uint8' : `int${bytes * 8}`;
  return { rate: sampleRate, channels, blockAlign, sample, le: true };
}

/**
 * Walks AIFF and AIFC chunks to 'SSND'. Samples are big-endian except in AIFC 'sowt'.
 * @returns {object|null|undefined} as parseWav
 */
function parseAiff(u8, size) {
  const complete = u8.length >= size;
  if (u8.length < 12) return complete ? null : undefined;
  const form = fourcc(u8, 8);
  if (form !== 'AIFF' && form !== 'AIFC') return null;
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let fmt = null;
  let frames = 0;
  for (let p = 12; p + 8 <= u8.length;) {
    const id = fourcc(u8, p);
    const len = v.getUint32(p + 4);
    if (id === 'COMM') {
      if (p + (form === 'AIFC' ? 30 : 26) > u8.length) break;
      const type = form === 'AIFC' ? fourcc(u8, p + 26) : 'NONE';
      fmt = aiffFormat(type, v.getUint16(p + 8), v.getUint16(p + 14), extended(v, p + 16));
      if (!fmt) return null;
      frames = v.getUint32(p + 10);
    } else if (id === 'SSND') {
      if (!fmt) return null;
      if (p + 16 > u8.length) break;
      const offset = v.getUint32(p + 8);
      return withFrames(fmt, p + 16 + offset, Math.min(len - 8 - offset, frames * fmt.blockAlign), size);
    }
    p += 8 + len + (len % 2);
  }
  return complete ? null : undefined;
}

function aiffFormat(type, channels, bits, rate) {
  const bytes = Math.ceil(bits / 8);
  let sample = null;
  if (['NONE', 'twos', 'sowt', 'in24', 'in32'].includes(type) && bytes >= 1 && bytes <= 4) sample = `int${bytes * 8}`;
  else if (type === 'fl32' || type === 'FL32') sample = 'float32';
  else if (type === 'fl64' || type === 'FL64') sample = 'float64';
  if (!sample || !channels || channels > 32 || !rate) return null;
  return { rate, channels, blockAlign: channels * SAMPLE_BYTES[sample], sample, le: type === 'sowt', aiff: true };
}

/** An 80-bit extended float, which AIFF uses for its sample rate. */
function extended(v, p) {
  const exponent = (v.getUint16(p) & 0x7fff) - 16383 - 63;
  return (v.getUint32(p + 2) * 2 ** 32 + v.getUint32(p + 6)) * 2 ** exponent;
}

/** The format plus where its samples start and how many whole frames the entry holds. */
function withFrames(fmt, dataOffset, bytes, size) {
  return { ...fmt, dataOffset, frames: Math.floor(Math.max(0, Math.min(bytes, size - dataOffset)) / fmt.blockAlign) };
}

/** Converts interleaved samples to planar floats in dst[c][at...]. Power-of-two scales are exact. */
function toFloat(u8, frames, channels, sample, le, dst, at) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const size = SAMPLE_BYTES[sample];
  const stride = size * channels;
  const end = at + frames;
  const lo = le ? 0 : 2;
  const hi = 2 - lo;
  for (let c = 0; c < channels; c++) {
    const out = dst[c];
    let p = c * size;
    if (sample === 'int24') {
      for (let i = at; i < end; i++, p += stride) out[i] = (((u8[p + lo] | (u8[p + 1] << 8) | (u8[p + hi] << 16)) << 8) >> 8) * INT24;
    } else if (sample === 'int16') {
      for (let i = at; i < end; i++, p += stride) out[i] = v.getInt16(p, le) * INT16;
    } else if (sample === 'uint8') {
      for (let i = at; i < end; i++, p += stride) out[i] = (u8[p] - 128) * INT8;
    } else if (sample === 'int8') {
      for (let i = at; i < end; i++, p += stride) out[i] = ((u8[p] << 24) >> 24) * INT8;
    } else if (sample === 'int32') {
      for (let i = at; i < end; i++, p += stride) out[i] = v.getInt32(p, le) * INT32;
    } else if (sample === 'float32') {
      for (let i = at; i < end; i++, p += stride) out[i] = v.getFloat32(p, le);
    } else {
      for (let i = at; i < end; i++, p += stride) out[i] = v.getFloat64(p, le);
    }
  }
}

/** Gain that keeps n source channels folded into two near their original level. */
const foldGain = (n) => 1 / Math.sqrt(Math.ceil(n / 2));

/** Folds source channels past the second into the first two and applies the track's storage gain, over [from, to). */
function fold(t, s, from, to) {
  for (let c = 2; c < t.inChannels; c++) {
    const src = s[c];
    const dst = s[c % 2];
    for (let i = from; i < to; i++) dst[i] += src[i];
  }
  if (t.gain === 1) return;
  for (let c = 0; c < t.channels; c++) {
    const d = s[c];
    for (let i = from; i < to; i++) d[i] *= t.gain;
  }
}

// --- Entry readers ---

function concat(parts, n) {
  if (parts.length === 1 && parts[0].length === n) return parts[0];
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p.subarray(0, n - o), o);
    o += Math.min(p.length, n - o);
    if (o === n) break;
  }
  return out;
}

/** Serves an entry's bytes in order from parts that subclasses add in fill(). */
class Reader {
  constructor(file, start, end) {
    Object.assign(this, { file, pos: start, end, parts: [], have: 0 });
  }

  /** The next slice of the File range, or null at its end. Keeps one slice in flight, so reads overlap other tracks' turns. */
  async read() {
    const u8 = await (this.ahead ?? this.slice());
    this.ahead = this.slice();
    return u8;
  }

  slice() {
    if (this.pos === this.end) return null;
    const next = Math.min(this.pos + READ_BYTES, this.end);
    const read = this.file.slice(this.pos, next).arrayBuffer().then((b) => new Uint8Array(b));
    read.catch(() => {});
    this.pos = next;
    return read;
  }

  push(u8) {
    this.parts.push(u8);
    this.have += u8.length;
  }

  /** The next n bytes; fewer only where the entry ends. */
  async take(n) {
    await this.fill(n);
    const m = Math.min(n, this.have);
    const out = concat(this.parts, m);
    let drop = m;
    while (drop && drop >= this.parts[0].length) drop -= this.parts.shift().length;
    if (drop) this.parts[0] = this.parts[0].subarray(drop);
    this.have -= m;
    return out;
  }

  close() {
    this.parts = [];
    this.ahead = null;
  }
}

/** Reads a stored entry or a loose file. */
class RawReader extends Reader {
  async fill(want) {
    while (this.have < want) {
      const u8 = await this.read();
      if (!u8) return;
      this.push(u8);
    }
  }
}

/**
 * Inflates a deflated entry in small steps, each fully drained before the next, so the bytes held per track stay
 * near what was asked for. Chrome inflates a whole input chunk at once, and silence expands about 1000:1.
 */
class Inflater extends Reader {
  constructor(file, start, end) {
    super(file, start, end);
    const ds = new DecompressionStream('deflate-raw');
    Object.assign(this, { writer: ds.writable.getWriter(), reader: ds.readable.getReader() });
    this.buf = EMPTY;
    this.at = 0;
    this.ratio = 1;
    this.step = STEP_MIN;
    this.pending = null;
  }

  async fill(want) {
    while (this.have < want) {
      if (this.at === this.buf.length) {
        const u8 = await this.read();
        if (!u8) return;
        this.buf = u8;
        this.at = 0;
      }
      // Size each step from the last output ratio, growing at most 4x per step.
      const cap = Math.min(Math.max(STEP_MIN, Math.ceil((want - this.have) / this.ratio)), this.step * 4, STEP_MAX);
      const size = Math.min(cap, this.buf.length - this.at);
      const got = await this.inflate(this.buf.subarray(this.at, this.at + size));
      this.at += size;
      this.step = cap;
      if (got) this.ratio = Math.max(1, got / size);
    }
  }

  /** Inflates one step and collects all of its output. The empty write completes only once that output is drained. */
  async inflate(input) {
    const drained = this.writer.write(input).then(() => this.writer.write(EMPTY)).then(() => DRAINED);
    drained.catch(() => {});
    let got = 0;
    for (;;) {
      if (!this.pending) {
        this.pending = this.reader.read();
        this.pending.catch(() => {});
      }
      const r = await Promise.race([this.pending, drained]);
      if (r === DRAINED) return got;
      this.pending = null;
      if (r.done) return got;
      this.push(r.value);
      got += r.value.length;
    }
  }

  close() {
    super.close();
    this.reader.cancel().catch(() => {});
    this.writer.abort().catch(() => {});
  }
}

// --- Decimation ---
// Output frame j is centered on input frame j * k: the filter is symmetric and indexed around its middle tap,
// which compensates its group delay so tracks with different k stay frame-aligned.

let scratch = [];

/**
 * Kaiser-windowed sinc lowpass for decimation by k: 32k - 1 taps, cutoff at the output Nyquist frequency, unity DC
 * gain. Every k-th tap from the center is zero (a half-band filter for k = 2), and the folded tap list skips those.
 */
function decimationFilter(k) {
  const n = 32 * k - 1;
  const d = (n - 1) / 2;
  const fc = 0.5 / k;
  const beta = 7;
  const h = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const m = i - d;
    if (m !== 0 && m % k === 0) continue;
    const r = m / d;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    h[i] = sinc * bessel0(beta * Math.sqrt(1 - r * r)) / bessel0(beta);
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum;
  const idx = [];
  for (let i = 0; i < d; i++) if (h[i] !== 0) idx.push(i);
  return { last: n - 1, d, center: h[d], idx: Int32Array.from(idx), val: Float64Array.from(idx, (i) => h[i]) };
}

function bessel0(x) {
  let term = 1;
  let sum = 1;
  for (let j = 1; j < 40; j++) {
    term *= x / (2 * j);
    sum += term * term;
  }
  return sum;
}

function scratchFor(channels, frames) {
  if (scratch.length < channels || scratch[0].length < frames) {
    const size = Math.max(frames, scratch[0]?.length ?? 0);
    scratch = Array.from({ length: Math.max(channels, scratch.length) }, () => new Float64Array(size));
  }
  return scratch;
}

function quantize(x) {
  const v = Math.round(x * 32768);
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

/** Writes n filtered outputs to out[q], out[q + step], ...; output j is centered on sc[j * k + d]. */
function fir(sc, f, k, n, out, q, step) {
  const { idx, val, last, d, center } = f;
  const taps = idx.length;
  let j = 0;
  // Four outputs per pass share each tap load; every output still sums its terms in tap order.
  for (; j + 4 <= n; j += 4) {
    const b0 = j * k;
    const b1 = b0 + k;
    const b2 = b1 + k;
    const b3 = b2 + k;
    let a0 = 0;
    let a1 = 0;
    let a2 = 0;
    let a3 = 0;
    for (let m = 0; m < taps; m++) {
      const i = idx[m];
      const r = last - i;
      const c = val[m];
      a0 += c * (sc[b0 + i] + sc[b0 + r]);
      a1 += c * (sc[b1 + i] + sc[b1 + r]);
      a2 += c * (sc[b2 + i] + sc[b2 + r]);
      a3 += c * (sc[b3 + i] + sc[b3 + r]);
    }
    out[q] = quantize(a0 + center * sc[b0 + d]);
    out[q + step] = quantize(a1 + center * sc[b1 + d]);
    out[q + 2 * step] = quantize(a2 + center * sc[b2 + d]);
    out[q + 3 * step] = quantize(a3 + center * sc[b3 + d]);
    q += 4 * step;
  }
  for (; j < n; j++, q += step) {
    const b = j * k;
    let a = 0;
    for (let m = 0; m < taps; m++) a += val[m] * (sc[b + idx[m]] + sc[b + last - idx[m]]);
    out[q] = quantize(a + center * sc[b + d]);
  }
}

/** Produces output frames [t.outPos, t.outPos + n) into out at frame offset o, reading only the input it needs. */
async function unpackBlock(t, n, out, o) {
  const { k, channels, inChannels } = t;
  if (k === 1) {
    const bytes = await take(t, n);
    const s = scratchFor(inChannels, n);
    toFloat(bytes, n, inChannels, t.sample, t.le, s, 0);
    fold(t, s, 0, n);
    for (let c = 0; c < channels; c++) {
      const sc = s[c];
      for (let j = 0, q = o * channels + c; j < n; j++, q += channels) out[q] = quantize(sc[j]);
    }
    t.outPos += n;
    return;
  }
  const f = t.filter;
  const d = f.d;
  const lo = t.outPos * k - d;
  const hi = (t.outPos + n - 1) * k + d + 1;
  const from = Math.max(lo, 0);
  const readEnd = Math.min(hi, t.frames);
  const bytes = readEnd > t.inPos ? await take(t, readEnd - t.inPos) : null;
  const s = scratchFor(inChannels, hi - lo);
  const histFrom = t.inPos - t.histLen;
  for (let c = 0; c < channels; c++) {
    const sc = s[c];
    sc.fill(0, 0, from - lo);
    if (t.inPos > from) sc.set(t.hist[c].subarray(from - histFrom, t.histLen), from - lo);
    sc.fill(0, Math.max(readEnd, from) - lo, hi - lo);
  }
  if (bytes) {
    toFloat(bytes, readEnd - t.inPos, inChannels, t.sample, t.le, s, t.inPos - lo);
    fold(t, s, t.inPos - lo, readEnd - lo);
  }
  for (let c = 0; c < channels; c++) fir(s[c], f, k, n, out, o * channels + c, channels);
  const keepFrom = Math.max(0, (t.outPos + n) * k - d);
  t.histLen = Math.max(0, readEnd - keepFrom);
  for (let c = 0; c < channels; c++) t.hist[c].set(s[c].subarray(keepFrom - lo, keepFrom - lo + t.histLen));
  t.inPos = Math.max(t.inPos, readEnd);
  t.outPos += n;
}

/** Reads the next `frames` input frames of a track as bytes. */
async function take(t, frames) {
  const want = frames * t.blockAlign;
  const bytes = await t.reader.take(want);
  if (bytes.length < want) throw new Error('The audio data ends early.');
  return bytes;
}

// --- Unpacking ---

async function extract(sampleRate) {
  await openStore();
  rate = sampleRate;
  blockFrames = Math.round(rate);
  pieceFrames = PIECE_SECONDS * blockFrames;
  const streaming = [];
  const decoding = [];
  for (const t of tracks) {
    const k = t.kind === 'pcm' ? t.rate / rate : 0;
    if (t.kind === 'error') t.failed = true;
    else if (k === 1 || k === 2 || k === 4) streaming.push(Object.assign(t, { k, total: Math.ceil(t.frames / k), streaming: true }, storage(t)));
    else decoding.push(t);
  }
  for (const t of streaming) postMessage({ type: 'format', id: t.id, channels: t.channels, frames: t.total });
  progress();
  unpackAll(streaming);
  decodeAll(decoding);
}

/** Stored layout of a streaming track: at most two channels, scaled down where samples can exceed full scale. */
function storage(t) {
  const hot = t.sample.startsWith('float') || t.channels > 2;
  return {
    inChannels: t.channels,
    channels: Math.min(t.channels, 2),
    gain: (hot ? 1 / HEADROOM : 1) * foldGain(t.channels),
    unit: hot ? INT16 * HEADROOM : INT16,
  };
}

async function unpackAll(list) {
  let live = list;
  while (live.length && !stopped) {
    for (const t of live) {
      if (stopped) break;
      try {
        await unpackPiece(t);
      } catch (err) {
        if (!stopped) fail(t, `This track could not be unpacked. ${err.message}`);
      }
    }
    live = live.filter((t) => !t.finished && !t.failed);
  }
}

async function openReader(t) {
  const end = t.start + t.size;
  const reader = t.method === 0 ? new RawReader(t.file, t.start + t.dataOffset, end) : new Inflater(t.file, t.start, end);
  if (t.method !== 0) await reader.take(t.dataOffset);
  Object.assign(t, { reader, inPos: 0, outPos: 0, histLen: 0 });
  if (t.k > 1) {
    t.filter = decimationFilter(t.k);
    t.hist = Array.from({ length: t.channels }, () => new Float64Array(t.filter.last + 1));
  }
}

/** Unpacks one piece of a track in one-second blocks, yielding often enough that chunk requests stay responsive. */
async function unpackPiece(t) {
  if (!t.reader) await openReader(t);
  const count = Math.min(pieceFrames, t.total - t.outDone);
  const out = new Int16Array(count * t.channels);
  for (let o = 0; o < count; o += blockFrames) {
    await unpackBlock(t, Math.min(blockFrames, count - o), out, o);
    if (performance.now() - yieldedAt >= YIELD_MS) await nextTask();
    if (stopped || t.failed) return;
  }
  storePiece(t, out, count);
  if (t.outDone === t.total) finish(t);
}

/**
 * Removes the files of ended sessions, whose Web Locks are free, then opens this session's OPFS file under a lock that
 * the worker holds until it ends. Blobs would not do: Firefox keeps constructed Blobs in memory.
 */
async function openStore() {
  try {
    const root = await navigator.storage.getDirectory();
    const name = `mixer-${crypto.randomUUID()}.pcm`;
    await new Promise((held) => navigator.locks.request(name, () => {
      held();
      return new Promise(() => {});
    }));
    const ended = [];
    for await (const key of root.keys()) if (key.startsWith('mixer-')) ended.push(key);
    await Promise.all(ended.map((key) => navigator.locks.request(key, { ifAvailable: true }, (lock) => lock && root.removeEntry(key).catch(() => {}))));
    // One file, opened before unpacking starts: in Chromium, opens that overlapped unpacking sometimes never settled.
    const file = await root.getFileHandle(name, { create: true });
    store = await file.createSyncAccessHandle();
  } catch {
    // Expected where OPFS is unavailable, as in a Firefox private window.
  }
}

/** Appends a piece to the session's OPFS file and records its offset, or keeps the piece in memory without OPFS. */
function storePiece(t, int16, frames) {
  if (store) {
    try {
      if (store.write(int16, { at: storeEnd }) !== int16.byteLength) throw new Error('A write came up short.');
    } catch (err) {
      storageFailed(err);
      return;
    }
    t.pieces.push(storeEnd);
    storeEnd += int16.byteLength;
  } else {
    t.pieces.push(int16);
  }
  t.outDone += frames;
  drain(t);
  progress();
}

function finish(t) {
  t.finished = true;
  closeReader(t);
  drain(t);
  progress();
}

function fail(t, message) {
  t.failed = true;
  closeReader(t);
  postMessage({ type: 'error', id: t.id, message });
  drain(t);
  progress();
}

function closeReader(t) {
  t.reader?.close();
  t.reader = null;
  t.hist = null;
}

function storageFailed(err) {
  if (stopped) return;
  stopped = true;
  for (const t of tracks) {
    closeReader(t);
    drain(t);
  }
  postMessage({ type: 'error', id: null, storage: true, message: `The browser ran out of storage space for unpacked audio, so unpacking stopped. What is already unpacked still plays. (${err?.name ?? 'Error'})` });
  progress(true);
}

const yielder = new MessageChannel();
const yielded = [];
let yieldedAt = 0;
yielder.port1.onmessage = () => {
  yieldedAt = performance.now();
  yielded.shift()();
};

/** Resolves in a new task, so queued messages run first. setTimeout would clamp to 4 ms when nested. */
function nextTask() {
  return new Promise((resolve) => {
    yielded.push(resolve);
    yielder.port2.postMessage(null);
  });
}

// --- Decode path ---
// One track at a time, so main never holds more than one decoded file.

async function decodeAll(list) {
  for (const t of list) {
    if (stopped) {
      fail(t, 'There was not enough storage left to unpack this track.');
      continue;
    }
    try {
      const blob = t.aiff ? await aiffAsWav(t) : await entryBlob(t);
      const reply = new Promise((resolve) => { decodeWaiter = { id: t.id, resolve }; });
      postMessage({ type: 'decode', id: t.id, blob });
      const msg = await reply;
      decodeWaiter = null;
      if (msg.type === 'pcm') await storeDecoded(t, msg.channels);
      else {
        t.failed = true;
        progress();
      }
    } catch (err) {
      fail(t, `This track could not be decoded. ${err.message}`);
    }
  }
}

/** The original file bytes of an entry. */
async function entryBlob(t) {
  const blob = t.file.slice(t.start, t.start + t.size);
  if (t.method === 0) return blob;
  const inflated = await new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
  if (inflated.size !== t.usize) throw new Error('The zip entry is damaged.');
  return inflated;
}

/** A float WAV copy of an AIFF entry, because decodeAudioData in Chrome and Firefox cannot read AIFF. */
async function aiffAsWav(t) {
  await openReader(t);
  const ch = t.channels;
  const parts = [wavHeader(ch, t.rate, t.frames)];
  for (let f = 0; f < t.frames; f += blockFrames) {
    const n = Math.min(blockFrames, t.frames - f);
    const bytes = await take(t, n);
    const s = scratchFor(ch, n);
    toFloat(bytes, n, ch, t.sample, t.le, s, 0);
    const out = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) for (let i = 0, q = c; i < n; i++, q += ch) out[q] = s[c][i];
    parts.push(out);
  }
  closeReader(t);
  return new Blob(parts);
}

function wavHeader(channels, sampleRate, frames) {
  const v = new DataView(new ArrayBuffer(44));
  const tag = (p, id) => [...id].forEach((c, i) => v.setUint8(p + i, c.charCodeAt(0)));
  const bytes = frames * channels * 4;
  tag(0, 'RIFF');
  v.setUint32(4, 36 + bytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 4, true);
  v.setUint16(32, channels * 4, true);
  v.setUint16(34, 32, true);
  tag(36, 'data');
  v.setUint32(40, bytes, true);
  return v;
}

/** Stores browser-decoded audio like a streamed track, folded to stereo and scaled by a power of two to fit 16 bits. */
async function storeDecoded(t, channels) {
  const total = channels[0].length;
  Object.assign(t, { inChannels: channels.length, channels: Math.min(channels.length, 2), gain: foldGain(channels.length) });
  fold(t, channels, 0, total);
  // NaN fails `a > peak` and infinities fail `a < Infinity`, so one bad sample cannot make the scale non-finite.
  let peak = 0;
  for (let c = 0; c < t.channels; c++) {
    for (let i = 0; i < total; i++) {
      const a = Math.abs(channels[c][i]);
      if (a > peak && a < Infinity) peak = a;
    }
  }
  const scale = 2 ** Math.max(0, Math.ceil(Math.log2(peak)));
  Object.assign(t, { total, k: 1, unit: INT16 * scale });
  for (let f = 0; f < total && !stopped; f += pieceFrames) {
    const n = Math.min(pieceFrames, total - f);
    const out = new Int16Array(n * t.channels);
    for (let c = 0; c < t.channels; c++) {
      const src = channels[c];
      for (let i = 0, q = c; i < n; i++, q += t.channels) out[q] = quantize(src[f + i] / scale);
    }
    storePiece(t, out, n);
    await nextTask();
  }
  if (stopped) throw new Error('There was not enough storage left.');
  postMessage({ type: 'format', id: t.id, channels: t.channels, frames: t.total });
  finish(t);
}

// --- Progress ---

let lastProgress = null;
let lastProgressAt = -Infinity;
let progressTimer = 0;

/** Posts {frontier, done} at most four times a second; the final done message goes out at once. */
function progress(now = false) {
  let frontier = Infinity;
  let longest = 0;
  for (const t of tracks) {
    if (t.streaming && !t.finished && !t.failed) frontier = Math.min(frontier, t.outDone);
    if (t.finished) longest = Math.max(longest, t.total);
  }
  if (frontier === Infinity) frontier = longest;
  const done = tracks.every((t) => t.finished || t.failed);
  if (lastProgress && lastProgress.frontier === frontier && lastProgress.done === done) return;
  const wait = lastProgressAt + PROGRESS_MS - performance.now();
  if (!done && !now && wait > 0) {
    progressTimer ||= setTimeout(() => {
      progressTimer = 0;
      progress(true);
    }, wait);
    return;
  }
  clearTimeout(progressTimer);
  progressTimer = 0;
  lastProgress = { frontier, done };
  lastProgressAt = performance.now();
  postMessage({ type: 'progress', frontier, done });
}

// --- Serving ---

function connect(id, port) {
  const t = tracks[id];
  t.port = port;
  port.onmessage = ({ data }) => {
    if (data.type === 'need') need(t, data);
  };
}

function need(t, { generation, frame, frames }) {
  if (generation < t.generation) return;
  t.generation = generation;
  t.queue.push({ generation, frame, frames });
  drain(t);
}

/** Serves queued requests that are unpacked, keeps the ones still coming, and drops stale or unservable ones. */
function drain(t) {
  if (!t.queue.length) return;
  const keep = [];
  for (const r of t.queue) {
    if (r.generation < t.generation) continue;
    const end = r.frame + r.frames;
    if (end <= t.outDone) serve(t, r.generation, r.frame, end);
    else if (!(t.failed || t.finished || stopped)) keep.push(r);
  }
  t.queue = keep;
}

function serve(t, generation, frame, end) {
  const ch = t.channels;
  const channels = Array.from({ length: ch }, () => new Float32Array(end - frame));
  for (let i = Math.floor(frame / pieceFrames); i * pieceFrames < end; i++) {
    const at = i * pieceFrames;
    const a = Math.max(frame, at);
    const b = Math.min(end, at + pieceFrames);
    if (!store) {
      copyFrames(t.pieces[i], at, a, b, channels, a - frame, t.unit);
      continue;
    }
    const part = new Int16Array((b - a) * ch);
    try {
      if (store.read(part, { at: t.pieces[i] + (a - at) * ch * 2 }) !== part.byteLength) throw new Error('A read came up short.');
    } catch (err) {
      storageFailed(err);
      return;
    }
    copyFrames(part, a, a, b, channels, a - frame, t.unit);
  }
  t.port.postMessage({ type: 'chunk', generation, frame, channels }, channels.map((c) => c.buffer));
}

/** Copies frames [from, to) of interleaved int16 that starts at frame `start` into planar floats at `at`, times `unit`. */
function copyFrames(src, start, from, to, channels, at, unit) {
  const ch = channels.length;
  for (let c = 0; c < ch; c++) {
    const out = channels[c];
    for (let i = at, q = (from - start) * ch + c, end = at + to - from; i < end; i++, q += ch) out[i] = src[q] * unit;
  }
}
