// AudioWorklet processor `track-player` for the Mixer tab. It plays one track from chunks that
// mixer-worker.js streams over a MessagePort, placing every sample at an absolute context frame so all
// tracks stay sample-aligned, and applies the strip's gate and compressor with no added latency.

const SECOND = Math.round(sampleRate);
const CHUNK = SECOND;
const LOW_WATER = 2 * SECOND;
const KEEP = 3 * SECOND;
const PRIMED = SECOND;
const FADE = 256;
const BLOCK = 32;
const GATE_OFF = -80;
const HYSTERESIS = 10 ** (-4 / 20);
const DB_TO_EXP = Math.LN10 / 20;

const smoothing = (seconds, frames = 1) => Math.exp(-frames / (seconds * sampleRate));
const DETECT_ATTACK = smoothing(0.001);
const DETECT_RELEASE = smoothing(0.1);
const GATE_ATTACK = smoothing(0.002);
const GATE_RELEASE = smoothing(0.08);
const COMP_ATTACK = 0.005;
const COMP_RELEASE = 0.15;
const COMP_ATTACK_BLOCK = smoothing(COMP_ATTACK, BLOCK);
const COMP_RELEASE_BLOCK = smoothing(COMP_RELEASE, BLOCK);
const SEED = Math.round(0.02 * sampleRate);

/** Static compressor gain reduction in dB for a peak envelope value. */
function compTarget(env, threshold, slope) {
  const level = 20 * Math.log10(env);
  return level > threshold ? (level - threshold) * slope : 0;
}

class TrackPlayer extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gate', defaultValue: GATE_OFF, minValue: GATE_OFF, maxValue: 0, automationRate: 'k-rate' },
      { name: 'comp', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    this.frames = options.processorOptions.frames;
    this.worker = null;
    this.generation = -1;
    this.primeFrame = null;
    this.primed = false;
    this.requestedUntil = 0;
    // { frame, end, channels }, sorted by frame. Chunk data is file data, valid for any generation.
    this.chunks = [];
    // { from, startAt, stopAt, end, filled, resumeAt }: file frame `from` plays at context frame `startAt`;
    // output ends at context frame `end`. A seek can leave the old segment fading out while the next one is scheduled.
    this.segments = [];
    this.dynamicsOn = false;
    this.seed = null;
    this.seedPending = false;
    this.resetDynamics();
    this.port.onmessage = (e) => this.receive(e.data);
  }

  // --- Messages ---

  receive(m) {
    if (m.type === 'connect') {
      this.worker = m.port;
      this.worker.onmessage = (e) => this.receiveChunk(e.data);
      this.request();
    } else if (m.type === 'prime') {
      this.prime(m.generation, m.frame);
    } else if (m.type === 'play') {
      this.play(m.generation, m.when);
    } else if (m.type === 'stop') {
      this.scheduleStop(Math.max(Math.round(m.when * sampleRate), currentFrame));
      this.primeFrame = null;
    }
  }

  // Keep chunks that overlap [frame, frame + KEEP) or that a playing segment still needs, then request the gaps.
  prime(generation, frame) {
    this.generation = generation;
    this.primeFrame = frame;
    this.primed = false;
    const keep = [[frame, frame + KEEP]];
    for (const s of this.segments) {
      const at = s.from + Math.max(0, currentFrame - s.startAt);
      keep.push([at, s.end === Infinity ? at + KEEP : s.from + s.end - s.startAt]);
    }
    this.chunks = this.chunks.filter((c) => keep.some(([lo, hi]) => c.frame < hi && c.end > lo));
    this.requestedUntil = frame;
    this.request();
    this.checkPrimed();
  }

  play(generation, when) {
    if (generation !== this.generation || this.primeFrame === null) return;
    const startAt = Math.round(when * sampleRate);
    // An open gate and zero gain reduction would leak noise or overshoot at every Start, so dynamics starting
    // from silence take the level of the first 20 ms of data instead, once process() first copies any.
    if (!this.segments.length) {
      this.resetDynamics();
      this.seedPending = true;
    }
    this.scheduleStop(Math.max(currentFrame, startAt - FADE));
    for (const s of this.segments) s.end = Math.min(s.end, startAt);
    this.segments.push({ from: this.primeFrame, startAt, stopAt: Infinity, end: Infinity, filled: this.primeFrame, resumeAt: -Infinity });
    this.primeFrame = null;
    this.request();
  }

  // Fade every segment out over FADE frames from context frame `at`; a segment starting at or after `at` never plays.
  scheduleStop(at) {
    for (const s of this.segments) {
      if (at <= s.startAt) {
        s.end = Math.min(s.end, s.startAt);
      } else if (at < s.stopAt) {
        s.stopAt = at;
        s.end = Math.min(s.end, at + FADE);
      }
    }
  }

  receiveChunk(m) {
    if (m.type !== 'chunk' || m.generation !== this.generation) return;
    const chunk = { frame: m.frame, end: m.frame + m.channels[0].length, channels: m.channels };
    const at = this.position();
    if (at !== null && chunk.end <= at) return;
    const chunks = this.chunks;
    let i = chunks.length;
    while (i > 0 && chunks[i - 1].frame > chunk.frame) i--;
    if (i > 0 && chunks[i - 1].frame === chunk.frame) {
      if (chunks[i - 1].end >= chunk.end) return;
      chunks[i - 1] = chunk;
    } else {
      chunks.splice(i, 0, chunk);
    }
    this.checkPrimed();
  }

  checkPrimed() {
    if (this.primed || this.primeFrame === null) return;
    const target = Math.min(this.primeFrame + PRIMED, this.frames);
    let covered = this.primeFrame;
    for (const c of this.chunks) {
      if (c.frame > covered) break;
      if (c.end > covered) covered = c.end;
    }
    if (covered < target) return;
    this.primed = true;
    this.port.postMessage({ type: 'primed', generation: this.generation });
  }

  /** Peak of the buffered file frames [from, to) across channels. */
  peak(from, to) {
    let p = 0;
    for (const c of this.chunks) {
      const a = Math.max(from, c.frame) - c.frame;
      const b = Math.min(to, c.end) - c.frame;
      for (const ch of c.channels) for (let i = a; i < b; i++) p = Math.max(p, Math.abs(ch[i]));
    }
    return p;
  }

  // --- Requests ---

  // File frame that requests run ahead of: the pending prime, else the newest segment's play position.
  position() {
    if (this.primeFrame !== null) return this.primeFrame;
    const s = this.segments[this.segments.length - 1];
    return s ? s.from + Math.max(0, Math.min(currentFrame, s.end) - s.startAt) : null;
  }

  // Keep LOW_WATER requested ahead of the position, skipping buffered ranges, never at or past the end.
  request() {
    const at = this.position();
    if (!this.worker || at === null) return;
    if (this.requestedUntil < at) this.requestedUntil = at;
    const limit = Math.min(at + LOW_WATER, this.frames);
    while (this.requestedUntil < limit) {
      const from = this.requestedUntil;
      let next = Infinity;
      for (const c of this.chunks) {
        if (c.frame <= from && c.end > from) {
          next = -1;
          this.requestedUntil = c.end;
          break;
        }
        if (c.frame > from && c.frame < next) next = c.frame;
      }
      if (next < 0) continue;
      const frames = Math.min(CHUNK, this.frames - from, next - from);
      this.worker.postMessage({ type: 'need', generation: this.generation, frame: from, frames });
      this.requestedUntil = from + frames;
    }
  }

  // --- Rendering ---

  process(inputs, outputs, parameters) {
    const out = outputs[0];
    const n = out[0].length;
    for (let ch = 0; ch < out.length; ch++) out[ch].fill(0);
    if (!this.segments.length) return true;
    const t0 = currentFrame;
    const t1 = t0 + n;
    // While a prime is pending, its chunks may lie before an old segment's position.
    if (this.primeFrame === null) this.dropBefore(t0);
    let wrote = false;
    for (const s of this.segments) {
      const a = Math.max(t0, s.startAt);
      const b = Math.min(t1, s.end);
      if (a < b && this.copy(out, s, s.from + a - s.startAt, a - t0, b - a)) wrote = true;
    }
    if (wrote) {
      // A join or a timed-out prime first gets data after the play position, where copy() set resumeAt.
      if (this.seedPending) {
        const s = this.segments[this.segments.length - 1];
        const at = s.from + Math.max(t0, s.startAt, s.resumeAt) - s.startAt;
        this.seed = this.peak(at, at + SEED);
        this.seedPending = false;
      }
      this.dynamics(out, n, parameters.gate[0], parameters.comp[0]);
      for (const s of this.segments) this.fade(out, s, t0, t1);
    }
    if (this.segments[0].end <= t1) this.segments = this.segments.filter((s) => s.end > t1);
    this.request();
    return true;
  }

  // Drop chunks wholly before every segment's position at context frame t.
  dropBefore(t) {
    let low = Infinity;
    for (const s of this.segments) low = Math.min(low, s.from + Math.max(0, t - s.startAt));
    const chunks = this.chunks;
    let j = 0;
    for (let i = 0; i < chunks.length; i++) if (chunks[i].end > low) chunks[j++] = chunks[i];
    chunks.length = j;
  }

  // Copy segment s's file frames [frame, frame + length) to output offset `offset`; frames with no chunk stay zero.
  // Data that starts after a gap (a late play or join, a slow chunk) fades in like a play start.
  // Returns whether any frame was copied.
  copy(out, s, frame, offset, length) {
    const end = frame + length;
    const chunks = this.chunks;
    let copied = false;
    for (let k = 0; k < chunks.length; k++) {
      const c = chunks[k];
      if (c.frame >= end) break;
      const a = Math.max(frame, c.frame);
      const b = Math.min(end, c.end);
      if (a >= b) continue;
      if (a > s.filled) s.resumeAt = s.startAt + a - s.from;
      if (b > s.filled) s.filled = b;
      for (let ch = 0; ch < out.length; ch++) {
        const src = c.channels[ch];
        const dst = out[ch];
        for (let i = a - c.frame, j = offset + a - frame, stop = b - c.frame; i < stop; i++, j++) dst[j] = src[i];
      }
      copied = true;
    }
    return copied;
  }

  fade(out, s, t0, t1) {
    this.ramp(out, t0, Math.max(t0, s.startAt), Math.min(t1, s.startAt + FADE, s.end), s.startAt, 1);
    if (s.resumeAt + FADE > t0) this.ramp(out, t0, Math.max(t0, s.resumeAt), Math.min(t1, s.resumeAt + FADE, s.end), s.resumeAt, 1);
    if (s.stopAt !== Infinity) this.ramp(out, t0, Math.max(t0, s.stopAt), Math.min(t1, s.end), s.stopAt + FADE - 1, -1);
  }

  // Scale context frames [a, b) by |t - origin| / FADE: 0 at the origin, rising by 1/FADE per frame away from it.
  ramp(out, t0, a, b, origin, direction) {
    for (let t = a; t < b; t++) {
      const g = (direction * (t - origin)) / FADE;
      for (let ch = 0; ch < out.length; ch++) out[ch][t - t0] *= g;
    }
  }

  // --- Dynamics ---

  resetDynamics() {
    this.env = 0;
    this.gateOpen = true;
    this.gateGain = 1;
    this.reduction = 0;
    this.compGain = 1;
  }

  // Gate then compressor on one shared peak detector. Both only scale samples, so nothing is delayed.
  dynamics(out, n, gateDb, amount) {
    const seed = this.seed;
    this.seed = null;
    const gateOn = gateDb > GATE_OFF;
    const compOn = amount > 0;
    if (!gateOn && !compOn) {
      this.dynamicsOn = false;
      return;
    }
    if (!this.dynamicsOn) {
      this.resetDynamics();
      this.dynamicsOn = true;
    }
    if (!gateOn) {
      this.gateOpen = true;
      this.gateGain = 1;
    }
    if (!compOn) {
      this.reduction = 0;
      this.compGain = 1;
    }
    const open = 10 ** (gateDb / 20);
    const close = open * HYSTERESIS;
    const threshold = -30 * amount;
    const slope = 1 - 1 / (1 + 3 * amount);
    const makeup = 0.3 * -threshold * slope;
    if (seed !== null) {
      this.env = seed;
      if (gateOn) {
        this.gateOpen = seed >= open;
        this.gateGain = this.gateOpen ? 1 : 0;
      }
      if (compOn) {
        this.reduction = compTarget(seed, threshold, slope);
        this.compGain = Math.exp((makeup - this.reduction) * DB_TO_EXP);
      }
    }
    const x0 = out[0];
    const stereo = out.length > 1;
    const x1 = stereo ? out[1] : x0;
    let env = this.env;
    let isOpen = this.gateOpen;
    let gate = this.gateGain;
    let reduction = this.reduction;
    let g = this.compGain;
    for (let b = 0; b < n; b += BLOCK) {
      const e = Math.min(b + BLOCK, n);
      // log and exp run once per block, from the envelope so far; the gain is interpolated across the block.
      let step = 0;
      if (compOn) {
        const target = compTarget(env, threshold, slope);
        const len = e - b;
        const k = target > reduction
          ? (len === BLOCK ? COMP_ATTACK_BLOCK : smoothing(COMP_ATTACK, len))
          : (len === BLOCK ? COMP_RELEASE_BLOCK : smoothing(COMP_RELEASE, len));
        reduction = target + (reduction - target) * k;
        step = (Math.exp((makeup - reduction) * DB_TO_EXP) - g) / len;
      }
      for (let i = b; i < e; i++) {
        let x = Math.abs(x0[i]);
        const y = Math.abs(x1[i]);
        if (y > x) x = y;
        env = x + (env - x) * (x > env ? DETECT_ATTACK : DETECT_RELEASE);
        g += step;
        let gi = g;
        if (gateOn) {
          if (isOpen) {
            if (env < close) isOpen = false;
          } else if (env >= open) {
            isOpen = true;
          }
          gate = isOpen ? 1 + (gate - 1) * GATE_ATTACK : gate * GATE_RELEASE;
          gi *= gate;
        }
        x0[i] *= gi;
        if (stereo) x1[i] *= gi;
      }
    }
    // Decays toward zero would reach denormals, which are slow on x86.
    this.env = env < 1e-15 ? 0 : env;
    this.gateGain = gate < 1e-15 ? 0 : gate;
    this.reduction = reduction < 1e-12 ? 0 : reduction;
    this.gateOpen = isOpen;
    this.compGain = g;
  }
}

registerProcessor('track-player', TrackPlayer);
