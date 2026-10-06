// Mixer tab: loads a multitrack session into one channel strip per track and plays it with one shared transport.
// mixer-worker.js unpacks and serves the audio, and each track plays through a `track-player` node from
// mixer-worklet.js; every node starts on the same context frame, so the tracks stay sample-aligned.

import { EFFECTS, makeImpulseResponse, makeDistortionCurve } from './effects.js';

const FLOOR_DB = -60;
const GATE_OFF = -80;
const STREAM_FACTORS = [1, 2, 4];
// Large sessions starve Chrome's 'playback' output buffer of about 1024 frames on slow machines.
const LATENCY = 0.2;
const START_LEAD = 0.05;
const STOP_LEAD = 0.03;
const SMOOTHING = 0.01;
const PRIME_TIMEOUT_MS = 3000;
const SEEK_DEBOUNCE_MS = 150;
const METER_FALL_DB_PER_S = 24;
const METER_INTERVAL_MS = 30;
const METER_STEP_DB = 0.5;
// The drive curve spans ±4, so EQ boosts past full scale bend softly instead of clipping at the curve's ends.
const DRIVE_HEADROOM = 4;
// Private windows keep unpacked audio in memory, so the threshold is sized for RAM rather than disk.
const STORAGE_WARN_BYTES = 1.5e9;
const ACCEPT = '.zip,.wav,.wave,.aif,.aiff,.aifc,.flac,.mp3,.m4a,.ogg,.opus,audio/*';
const LEVEL_ATTRS = `class="level" min="${FLOOR_DB}" max="0" low="-18" high="-3" optimum="${FLOOR_DB}" value="${FLOOR_DB}"`;
const FADER_ATTRS = `class="fader" orientation="vertical" size="xs" label="Volume" min="${FLOOR_DB}" max="6" step="0.5" tooltip-placement="right"`;

const TIPS = {
  name: 'One recorded track. Its controls run top to bottom in the order the sound flows through them, except Delay and Reverb, which pick up the sound after Pan and Volume, so turning a track down also turns down its echo and reverb.',
  gate: `${EFFECTS.gate.description} Slide right to cut more. All the way left turns it off.`,
  comp: `${EFFECTS.compressor.description} Higher settings squeeze harder, so the track sounds steadier and closer.`,
  low: 'Turns the bass up or down: the deep thump and rumble below about 100 Hz.',
  mid: 'Turns the middle up or down, around 1,000 Hz, where voices and most instruments live. A small cut here can tame a honky or nasal track.',
  high: 'Turns the treble up or down: the sparkle and air above about 10,000 Hz.',
  drive: `${EFFECTS.distortion.description} A little adds warmth. A lot adds fuzz.`,
  pan: `${EFFECTS.panner.description} Spreading tracks apart gives each one room to be heard.`,
  delay: `${EFFECTS.delay.description} This sends some of the track to the echo on the Master card, where you set its timing.`,
  reverb: `${EFFECTS.reverb.description} This sends some of the track to the reverb on the Master card, where you set how long it rings.`,
  mute: 'Silences this track so you can hear the mix without it.',
  solo: 'Plays only the soloed tracks, so you can hear this one by itself. Solo several to hear them together.',
  fader: 'Sets how loud this track is in the mix. The bottom is silent, and 0 dB leaves it as it was recorded.',
  meter: 'How loud this track is right now. Green and yellow are healthy levels. Red means it is close to clipping.',
  masterName: 'Every track, plus the shared echo and reverb, adds up here into the finished song.',
  decay: 'How long the shared reverb keeps ringing after a sound stops, from a small room to a huge hall.',
  time: 'How long the shared echo waits before each repeat.',
  feedback: 'How many times the echo repeats. Higher settings keep it going longer.',
  master: 'Sets the volume of the whole mix. Many tracks add up, so it starts lower when there are more of them.',
  masterMeter: 'How loud the whole mix is on this side. If it reaches red, turn the master or the loudest tracks down so the song does not distort.',
  seek: 'Where you are in the song. Drag to jump to another part.',
  start: 'Plays every track together from the current position.',
  stop: 'Stops playback and keeps the position, like pausing a tape.',
  reload: 'Choose or drop a different .zip or set of audio files. The current session closes.',
};

const signedDb = (v) => `${v > 0 ? '+' : ''}${v} dB`;
const percent = (v) => `${v}%`;
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const FORMATS = {
  gate: (v) => (v <= GATE_OFF ? 'Off' : `${v} dB`),
  comp: percent,
  low: signedDb,
  mid: signedDb,
  high: signedDb,
  drive: percent,
  pan: (v) => (v < 0 ? `${-v}% L` : v > 0 ? `${v}% R` : 'Center'),
  delay: percent,
  reverb: percent,
  fader: (v) => (v <= FLOOR_DB ? '−∞ dB' : signedDb(v)),
  decay: (v) => `${v} s`,
  time: (v) => `${v} ms`,
  feedback: percent,
};

// Horizontal strip sliders, top to bottom in signal order, except the sends, which are taken after Volume.
const KNOBS = [
  { key: 'gate', label: 'Gate', min: GATE_OFF, max: 0 },
  { key: 'comp', label: 'Comp', min: 0, max: 100 },
  { key: 'low', label: 'Low', min: -12, max: 12 },
  { key: 'mid', label: 'Mid', min: -12, max: 12 },
  { key: 'high', label: 'High', min: -12, max: 12 },
  { key: 'drive', label: 'Drive', min: 0, max: 100 },
  { key: 'pan', label: 'Pan', min: -100, max: 100 },
  { key: 'delay', label: 'Delay', min: 0, max: 100 },
  { key: 'reverb', label: 'Reverb', min: 0, max: 100 },
];

const dbToGain = (db) => (db <= FLOOR_DB ? 0 : 10 ** (db / 20));
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
// Screen readers announce a control's hint, so it carries the teaching text; styles.css hides it on screen.
const hintAttr = (key) => `hint="${escapeHtml(TIPS[key])}"`;
const calloutHtml = (variant, size, message) =>
  `<wa-callout variant="${variant}" size="${size}"><wa-icon slot="icon" name="triangle-exclamation"></wa-icon>${escapeHtml(message)}</wa-callout>`;

/** Soft-clip curve over ±DRIVE_HEADROOM with the drive's makeup gain built in, so one curve swap changes both. */
function driveCurve(drive) {
  const curve = makeDistortionCurve(drive, DRIVE_HEADROOM);
  const makeup = Math.sqrt(Math.PI / (Math.PI + 2 * drive));
  for (let i = 0; i < curve.length; i++) curve[i] *= makeup;
  return curve;
}

// --- Panel ---

const root = document.getElementById('mixer');
root.innerHTML = `
  <div id="mx-empty">
    <div class="wa-stack wa-gap-s">
      <p class="wa-body-m">
        Songs are usually recorded one instrument at a time, each on its own track.
        Mixing balances those tracks into one finished song. Your files stay on this computer.
      </p>
      <wa-file-input id="mx-load" label="Load a session" hint="A .zip of WAV files, or several audio files." multiple accept="${ACCEPT}"></wa-file-input>
    </div>
  </div>
  <div id="mx-session" hidden>
    <div class="wa-stack wa-gap-s">
      <div class="wa-flank wa-gap-m wa-align-items-center">
        <div class="wa-cluster wa-gap-xs">
          <wa-button id="mx-start" variant="brand" size="s" disabled><wa-icon slot="start" name="play"></wa-icon>Start</wa-button>
          <wa-tooltip for="mx-start">${TIPS.start}</wa-tooltip>
          <wa-button id="mx-stop" size="s" appearance="outlined" disabled><wa-icon slot="start" name="stop"></wa-icon>Stop</wa-button>
          <wa-tooltip for="mx-stop">${TIPS.stop}</wa-tooltip>
        </div>
        <div class="wa-flank:end wa-gap-m wa-align-items-center">
          <div class="wa-flank:end wa-gap-s wa-align-items-center">
            <wa-slider id="mx-seek" label="Position" ${hintAttr('seek')} size="s" min="0" max="1" step="0.1" value="0" with-tooltip disabled></wa-slider>
            <wa-tooltip for="mx-seek">${TIPS.seek}</wa-tooltip>
            <span id="mx-clock" class="wa-caption-m">0:00 / 0:00</span>
          </div>
          <div class="wa-cluster wa-flex-nowrap wa-gap-m wa-align-items-center">
            <div id="mx-unpack" hidden><wa-progress-bar id="mx-progress" label="Unpacking"></wa-progress-bar></div>
            <wa-file-input id="mx-reload" size="xs" multiple accept="${ACCEPT}">
              <span slot="dropzone" class="wa-cluster wa-gap-xs wa-caption-m"><wa-icon name="folder-open"></wa-icon>Load another session</span>
            </wa-file-input>
            <wa-tooltip for="mx-reload">${TIPS.reload}</wa-tooltip>
          </div>
        </div>
      </div>
      <div id="mx-notices" class="wa-stack wa-gap-s" aria-live="polite"></div>
      <div id="mx-desk" class="wa-flank:end wa-gap-s wa-align-items-start">
        <wa-scroller>
          <div id="mx-strips" class="wa-cluster wa-flex-nowrap wa-gap-s wa-align-items-start"></div>
        </wa-scroller>
        <div id="mx-master"></div>
      </div>
    </div>
  </div>`;

const emptyEl = document.getElementById('mx-empty');
const sessionEl = document.getElementById('mx-session');
const startButton = document.getElementById('mx-start');
const stopButton = document.getElementById('mx-stop');
const seek = document.getElementById('mx-seek');
const clockEl = document.getElementById('mx-clock');
const unpackEl = document.getElementById('mx-unpack');
const progressBar = document.getElementById('mx-progress');
const noticesEl = document.getElementById('mx-notices');
const stripsEl = document.getElementById('mx-strips');
const masterSlot = document.getElementById('mx-master');

seek.valueFormatter = clock;

function notice(variant, message) {
  noticesEl.insertAdjacentHTML('beforeend', calloutHtml(variant, 's', message));
}

// --- Session ---

let loadId = 0;
let mix = null;

function load(files) {
  const session = ++loadId;
  teardown();
  const worker = new Worker('mixer-worker.js', { type: 'module' });
  const m = {
    id: session, worker, ctx: null, rate: 0, strips: [], state: 'opening',
    position: 0, duration: 0, frontier: 0, done: false,
    generation: 0, transport: null, primeWait: null, decay: 2, delaySeconds: 0.35, feedbackGain: 0.35,
    autoStopTimer: 0, suspendTimer: 0, seekTimer: 0, shownSecond: null,
  };
  mix = m;
  worker.onmessage = (e) => {
    if (session === loadId) onWorkerMessage(m, e.data);
  };
  worker.onerror = () => {
    if (session === loadId) notice('danger', 'The mixer stopped reading the files unexpectedly. Reload the page and try again.');
  };
  seek.value = 0;
  seek.max = 1;
  emptyEl.hidden = true;
  sessionEl.hidden = false;
  unpackEl.hidden = false;
  progressBar.indeterminate = true;
  progressBar.textContent = '';
  updateClock(m, true);
  updateTransport();
  worker.postMessage({ type: 'open', files });
}

function teardown() {
  const m = mix;
  mix = null;
  stopMeters();
  if (!m) return;
  clearTimeout(m.autoStopTimer);
  clearTimeout(m.suspendTimer);
  clearTimeout(m.seekTimer);
  m.worker.terminate();
  m.ctx?.close().catch(() => {});
  stripObserver.disconnect();
  stripsEl.replaceChildren();
  masterSlot.replaceChildren();
  noticesEl.replaceChildren();
}

function onWorkerMessage(m, msg) {
  if (msg.type === 'tracks') onTracks(m, msg.tracks);
  else if (msg.type === 'format') onFormat(m, msg.id, msg.channels, msg.frames);
  else if (msg.type === 'progress') onProgress(m, msg.frontier, msg.done);
  else if (msg.type === 'decode') onDecode(m, msg.id, msg.blob);
  else if (msg.type === 'error') onError(m, msg);
}

/**
 * Picks the context rate so streaming tracks only need integer decimation.
 * @param {Array} tracks The worker's track list.
 * @returns {number} The rate in Hz, or 0 to use the device default.
 */
function sessionRate(tracks) {
  const counts = new Map();
  for (const t of tracks) if (t.kind === 'pcm') counts.set(t.rate, (counts.get(t.rate) ?? 0) + 1);
  let common = 0;
  for (const [rate, n] of counts) if (!common || n > counts.get(common)) common = rate;
  for (const k of [4, 2, 1]) {
    if (common / k >= 44100 && Number.isInteger(common / k)) return common / k;
  }
  return 0;
}

async function onTracks(m, tracks) {
  if (!tracks.length) {
    unpackEl.hidden = true;
    notice('warning', 'No audio files were found. Choose a .zip of WAV files, or several audio files.');
    return;
  }
  const rate = sessionRate(tracks);
  try {
    m.ctx = rate ? new AudioContext({ sampleRate: rate, latencyHint: LATENCY }) : new AudioContext({ latencyHint: LATENCY });
  } catch {
    unpackEl.hidden = true;
    notice('danger', `This browser cannot mix audio recorded at ${rate} Hz.`);
    return;
  }
  try {
    // Constructing an AudioWorkletNode before this resolves throws.
    await m.ctx.audioWorklet.addModule('mixer-worklet.js');
  } catch {
    if (m.id === loadId) notice('danger', 'The mixer could not start its audio engine. Reload the page and try again.');
    return;
  }
  if (m.id !== loadId) return;
  m.rate = m.ctx.sampleRate;
  const playable = tracks.filter((t) => t.kind !== 'error').length;
  buildMaster(m, playable);
  buildStrips(m, tracks);
  warnStorage(m, tracks);
  m.state = 'stopped';
  m.worker.postMessage({ type: 'extract', sampleRate: m.rate });
  scheduleSuspend(m);
  updateTransport();
}

function warnStorage(m, tracks) {
  let bytes = 0;
  for (const t of tracks) {
    const k = t.kind === 'pcm' ? t.rate / m.rate : 0;
    // The worker folds more than two channels into stereo.
    if (STREAM_FACTORS.includes(k)) bytes += Math.ceil(t.frames / k) * Math.min(t.channels, 2) * 2;
  }
  if (bytes <= STORAGE_WARN_BYTES) return;
  notice('warning', `This session unpacks to about ${(bytes / 1e9).toFixed(1)} GB. The browser keeps that in its own storage while you mix, and a private window keeps it in memory, so it may run out of room.`);
}

function onFormat(m, id, channels, frames) {
  const t = m.strips[id];
  if (t.failed) return;
  t.card.querySelector('wa-progress-bar')?.remove();
  if (frames > m.duration) {
    m.duration = frames;
    seek.max = Math.ceil((frames / m.rate) * 10) / 10;
    updateClock(m, true);
    if (m.state === 'playing') scheduleAutoStop(m);
  }
  createPlayer(m, t, channels, frames);
  updateTransport();
}

function onProgress(m, frontier, done) {
  m.frontier = frontier;
  m.done = done;
  // Decode-path strips show their own progress, so the bar hides once every streaming track is unpacked.
  if (done || (m.duration && frontier >= m.duration)) {
    unpackEl.hidden = true;
  } else if (m.duration) {
    const pct = Math.min(100, Math.floor((frontier / m.duration) * 100));
    progressBar.indeterminate = false;
    progressBar.value = pct;
    progressBar.textContent = `Unpacking ${pct}%`;
  }
  updateTransport();
}

function onError(m, msg) {
  if (msg.id !== null) {
    failStrip(m, m.strips[msg.id], msg.message);
    return;
  }
  if (msg.storage) unpackEl.hidden = true;
  notice('danger', msg.message);
}

// Decode path: the browser decodes and resamples files the worker cannot stream; one track at a time.
async function onDecode(m, id, blob) {
  try {
    const buffer = await m.ctx.decodeAudioData(await blob.arrayBuffer());
    if (m.id !== loadId) return;
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => {
      const data = new Float32Array(buffer.length);
      buffer.copyFromChannel(data, c);
      return data;
    });
    m.worker.postMessage({ type: 'pcm', id, channels }, channels.map((c) => c.buffer));
  } catch {
    if (m.id !== loadId) return;
    m.worker.postMessage({ type: 'pcm-error', id });
    failStrip(m, m.strips[id], 'This browser cannot play this file’s format.');
  }
}

for (const input of [document.getElementById('mx-load'), document.getElementById('mx-reload')]) {
  input.addEventListener('change', () => {
    const files = input.files;
    if (!files.length) return;
    // Clearing fires no event and keeps the multiple-file list from growing with every pick.
    input.files = [];
    load(files);
  });
}

// --- Audio graph ---

/**
 * One analyser per channel: an AnalyserNode mixes its input to mono, which hides one-sided and out-of-phase sound.
 * Each holds one output buffer plus one meter interval, since the audio thread renders a whole buffer between reads.
 */
function meterTap(ctx, source, channels) {
  const fftSize = Math.min(32768, 2 ** Math.ceil(Math.log2((ctx.baseLatency + METER_INTERVAL_MS / 1000) * ctx.sampleRate)));
  const split = new ChannelSplitterNode(ctx, { numberOfOutputs: channels });
  source.connect(split);
  return Array.from({ length: channels }, (_, ch) => {
    const analyser = new AnalyserNode(ctx, { fftSize });
    split.connect(analyser, ch);
    return analyser;
  });
}

function buildMaster(m, trackCount) {
  const ctx = m.ctx;
  const masterDb = Math.min(0, Math.max(-24, Math.round(-10 * Math.log10(Math.max(1, trackCount)))));
  m.bus = new GainNode(ctx);
  m.masterFader = new GainNode(ctx, { gain: dbToGain(masterDb) });
  m.bus.connect(m.masterFader).connect(ctx.destination);
  m.masterMeters = meterTap(ctx, m.masterFader, 2).map((analyser) => ({ analysers: [analyser], el: null, shown: FLOOR_DB }));

  // A mono reverb input gives every source the IR's full stereo width, whatever its pan.
  m.reverbIn = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit' });
  m.convolver = new ConvolverNode(ctx, { buffer: makeImpulseResponse(ctx, m.decay) });
  m.reverbIn.connect(m.convolver).connect(m.bus);

  m.delayIn = new GainNode(ctx);
  m.delay = new DelayNode(ctx, { maxDelayTime: 2, delayTime: m.delaySeconds });
  m.feedback = new GainNode(ctx, { gain: m.feedbackGain });
  m.delayIn.connect(m.delay).connect(m.bus);
  m.delay.connect(m.feedback).connect(m.delay);

  masterSlot.innerHTML = `
    <wa-card class="strip" role="group" aria-labelledby="mx-master-name">
      <div slot="header" class="wa-text-truncate"><strong id="mx-master-name">Master</strong></div>
      <wa-tooltip for="mx-master-name">${TIPS.masterName}</wa-tooltip>
      <div class="wa-stack wa-gap-s">
        <wa-slider id="mx-master-decay" label="Reverb decay" ${hintAttr('decay')} size="xs" min="0.1" max="5" step="0.1" value="${m.decay}" with-tooltip></wa-slider>
        <wa-tooltip for="mx-master-decay">${TIPS.decay}</wa-tooltip>
        <wa-slider id="mx-master-time" label="Delay time" ${hintAttr('time')} size="xs" min="10" max="1000" step="10" value="350" with-tooltip></wa-slider>
        <wa-tooltip for="mx-master-time">${TIPS.time}</wa-tooltip>
        <wa-slider id="mx-master-feedback" label="Delay feedback" ${hintAttr('feedback')} size="xs" min="0" max="90" value="35" with-tooltip></wa-slider>
        <wa-tooltip for="mx-master-feedback">${TIPS.feedback}</wa-tooltip>
        <wa-divider></wa-divider>
        <div class="wa-cluster wa-flex-nowrap wa-gap-xs wa-align-items-start wa-justify-content-center">
          <wa-slider id="mx-master-fader" ${FADER_ATTRS} ${hintAttr('master')} value="${masterDb}" with-tooltip></wa-slider>
          <wa-tooltip for="mx-master-fader" placement="left">${TIPS.master}</wa-tooltip>
          <div class="wa-stack wa-gap-xs wa-align-items-center">
            <meter id="mx-master-left" ${LEVEL_ATTRS} aria-label="Left level"></meter>
            <span class="wa-form-control-label wa-font-size-xs" aria-hidden="true">L</span>
          </div>
          <wa-tooltip for="mx-master-left">${TIPS.masterMeter}</wa-tooltip>
          <div class="wa-stack wa-gap-xs wa-align-items-center">
            <meter id="mx-master-right" ${LEVEL_ATTRS} aria-label="Right level"></meter>
            <span class="wa-form-control-label wa-font-size-xs" aria-hidden="true">R</span>
          </div>
          <wa-tooltip for="mx-master-right">${TIPS.masterMeter}</wa-tooltip>
        </div>
      </div>
    </wa-card>`;
  for (const slider of masterSlot.querySelectorAll('wa-slider')) slider.valueFormatter = FORMATS[slider.id.slice(10)];
  m.masterMeters[0].el = document.getElementById('mx-master-left');
  m.masterMeters[1].el = document.getElementById('mx-master-right');
}

function buildStrips(m, tracks) {
  const fragment = document.createDocumentFragment();
  m.strips = tracks.map((info) => {
    const t = createStrip(m, info);
    fragment.append(t.card);
    stripObserver.observe(t.card);
    return t;
  });
  stripsEl.replaceChildren(fragment);
  requestAnimationFrame(() => setTimeout(() => enableValueBubbles(m, 0)));
}

// A value bubble renders a tooltip inside its slider, and one per slider up front makes first paint much slower.
function enableValueBubbles(m, from) {
  if (m.id !== loadId) return;
  const end = Math.min(from + 4, m.strips.length);
  for (let i = from; i < end; i++) showValueBubbles(m.strips[i]);
  if (end < m.strips.length) setTimeout(() => enableValueBubbles(m, end));
}

function showValueBubbles(t) {
  if (t.bubbles) return;
  t.bubbles = true;
  for (const slider of t.card.querySelectorAll('wa-slider')) slider.withTooltip = true;
}

function createStrip(m, info) {
  const side = /\.([LR])\.[^.]+$/i.exec(info.path)?.[1].toUpperCase();
  const mute = /click/i.test(info.name);
  const t = {
    id: info.id, name: info.name, path: info.path,
    streaming: info.kind === 'pcm' && STREAM_FACTORS.includes(info.rate / m.rate),
    values: { gate: GATE_OFF, comp: 0, low: 0, mid: 0, high: 0, drive: 0, pan: side === 'L' ? -100 : side === 'R' ? 100 : 0, delay: 0, reverb: 0, fader: 0 },
    mute, solo: false, audible: !mute, failed: false, player: null, bubbles: false,
  };
  t.card = document.createElement('wa-card');
  t.card.className = 'strip';
  t.card.setAttribute('role', 'group');
  t.card.setAttribute('aria-labelledby', `mx-${t.id}-name`);
  t.card.innerHTML = stripHtml(t);
  for (const slider of t.card.querySelectorAll('wa-slider')) slider.valueFormatter = FORMATS[slider.dataset.tip];
  for (const button of t.card.querySelectorAll('wa-button')) setToggle(button, t[button.dataset.tip]);
  t.stack = t.card.querySelector('.wa-stack');
  t.level = { analysers: [], el: t.card.querySelector('meter'), shown: FLOOR_DB };
  buildStripAudio(m, t);
  if (info.kind === 'error') failStrip(m, t, info.error || 'This track could not be read.');
  else if (!t.streaming) t.stack.insertAdjacentHTML('afterbegin', '<wa-progress-bar indeterminate label="Decoding"></wa-progress-bar>');
  return t;
}

function stripHtml(t) {
  const i = t.id;
  const knobs = KNOBS.map(({ key, label, min, max }) => `
    <wa-slider id="mx-${i}-${key}" data-tip="${key}" label="${label}" ${hintAttr(key)} size="xs" min="${min}" max="${max}" value="${t.values[key]}"${min < 0 && max > 0 ? ' indicator-offset="0"' : ''}></wa-slider>`).join('');
  return `
    <div slot="header" class="wa-text-truncate"><strong id="mx-${i}-name" data-tip="name">${escapeHtml(t.name)}</strong></div>
    <div class="wa-stack wa-gap-s">${knobs}
      <div class="wa-cluster wa-flex-nowrap wa-gap-xs">
        <wa-button id="mx-${i}-mute" data-tip="mute" size="xs">Mute</wa-button>
        <wa-button id="mx-${i}-solo" data-tip="solo" size="xs">Solo</wa-button>
      </div>
      <div class="wa-cluster wa-flex-nowrap wa-gap-xs wa-align-items-start wa-justify-content-center">
        <wa-slider id="mx-${i}-fader" data-tip="fader" ${FADER_ATTRS} ${hintAttr('fader')} value="0"></wa-slider>
        <meter id="mx-${i}-meter" data-tip="meter" ${LEVEL_ATTRS} aria-hidden="true"></meter>
      </div>
    </div>`;
}

// The player applies gate and comp before the EQ. Routing never changes.
function buildStripAudio(m, t) {
  const ctx = m.ctx;
  t.low = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 100 });
  t.mid = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1000, Q: 0.7 });
  t.high = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 10000 });
  for (const filter of [t.low, t.mid, t.high]) {
    for (const param of [filter.frequency, filter.Q, filter.gain, filter.detune]) param.automationRate = 'k-rate';
  }
  t.headroom = new GainNode(ctx, { gain: 1 / DRIVE_HEADROOM });
  // Oversampling adds latency in Chrome, which would shift this track against the others.
  t.shaper = new WaveShaperNode(ctx, { oversample: 'none', curve: driveCurve(0) });
  t.fader = new GainNode(ctx, { gain: t.audible ? dbToGain(t.values.fader) : 0 });
  t.panner = new StereoPannerNode(ctx, { pan: t.values.pan / 100 });
  t.delaySend = new GainNode(ctx, { gain: 0 });
  t.reverbSend = new GainNode(ctx, { gain: 0 });
  t.low.connect(t.mid).connect(t.high).connect(t.headroom).connect(t.shaper).connect(t.fader).connect(t.panner).connect(m.bus);
  t.panner.connect(t.delaySend).connect(m.delayIn);
  t.panner.connect(t.reverbSend).connect(m.reverbIn);
}

function createPlayer(m, t, channels, frames) {
  t.player = new AudioWorkletNode(m.ctx, 'track-player', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [channels],
    processorOptions: { frames },
    parameterData: { gate: t.values.gate, comp: t.values.comp / 100 },
  });
  t.player.connect(t.low);
  // Tapped before the panner, so the meter reads the track's own channels whatever its pan.
  t.level.analysers = meterTap(m.ctx, t.fader, channels);
  t.player.port.onmessage = (e) => {
    if (m.id === loadId && e.data.type === 'primed' && e.data.generation === m.generation) settlePrime(m, t);
  };
  t.player.onprocessorerror = () => {
    if (m.id === loadId) failStrip(m, t, 'This track stopped playing because of an error.');
  };
  const { port1, port2 } = new MessageChannel();
  t.player.port.postMessage({ type: 'connect', port: port1 }, [port1]);
  m.worker.postMessage({ type: 'connect', id: t.id, port: port2 }, [port2]);
  // A track that arrives mid-play joins on the stored transport, so it lands in sync with the rest.
  if (m.state === 'playing') {
    const { generation, frame, when } = m.transport;
    t.player.port.postMessage({ type: 'prime', generation, frame });
    t.player.port.postMessage({ type: 'play', generation, when });
  } else if (m.state === 'priming') {
    // Position and generation are fixed while priming; every change goes through stop() first.
    t.player.port.postMessage({ type: 'prime', generation: m.generation, frame: m.position });
  }
}

function failStrip(m, t, message) {
  if (t.failed) return;
  t.failed = true;
  t.card.querySelector('wa-progress-bar')?.remove();
  t.stack.insertAdjacentHTML('afterbegin', calloutHtml('danger', 'xs', message));
  for (const el of t.card.querySelectorAll('wa-slider, wa-button')) el.disabled = true;
  settlePrime(m, t);
  // A strip can fail while it is being built, before it is in m.strips.
  t.audible = false;
  applyFader(m, t);
  updateAudible(m);
  updateTransport();
}

// --- Controls ---

function setStripControl(m, t, key, value) {
  const now = m.ctx.currentTime;
  t.values[key] = value;
  if (key === 'gate') t.player?.parameters.get('gate').setValueAtTime(value, now);
  else if (key === 'comp') t.player?.parameters.get('comp').setValueAtTime(value / 100, now);
  else if (key === 'low' || key === 'mid' || key === 'high') t[key].gain.setTargetAtTime(value, now, SMOOTHING);
  else if (key === 'drive') t.shaper.curve = driveCurve(value);
  else if (key === 'pan') t.panner.pan.setTargetAtTime(value / 100, now, SMOOTHING);
  else if (key === 'delay') t.delaySend.gain.setTargetAtTime(value / 100, now, SMOOTHING);
  else if (key === 'reverb') t.reverbSend.gain.setTargetAtTime(value / 100, now, SMOOTHING);
  else if (key === 'fader') applyFader(m, t);
}

function setMasterControl(m, key, value, committed) {
  const now = m.ctx.currentTime;
  if (key === 'fader') {
    m.masterFader.gain.setTargetAtTime(dbToGain(value), now, SMOOTHING);
    return;
  }
  if (key === 'time') {
    m.delaySeconds = value / 1000;
    m.delay.delayTime.setTargetAtTime(m.delaySeconds, now, SMOOTHING);
  } else if (key === 'feedback') {
    m.feedbackGain = Math.min(value / 100, 0.95);
    m.feedback.gain.setTargetAtTime(m.feedbackGain, now, SMOOTHING);
  } else if (key === 'decay' && committed) {
    // Rebuilding a long IR on every input event would stall the page and drop the reverb out.
    m.decay = value;
    m.convolver.buffer = makeImpulseResponse(m.ctx, value);
  }
  // A longer tail must keep an idle context running until it has died away.
  if (m.state === 'stopped' && m.ctx.state === 'running') scheduleSuspend(m);
}

function applyFader(m, t) {
  t.fader.gain.setTargetAtTime(t.audible ? dbToGain(t.values.fader) : 0, m.ctx.currentTime, SMOOTHING);
}

// Audible = not muted, and soloed whenever any strip is soloed. The shared delay and reverb returns stay open.
function updateAudible(m) {
  const soloing = m.strips.some((t) => t.solo && !t.failed);
  for (const t of m.strips) {
    const audible = !t.failed && !t.mute && (!soloing || t.solo);
    if (audible === t.audible) continue;
    t.audible = audible;
    applyFader(m, t);
  }
}

function onControl(e, committed) {
  const m = mix;
  const match = /^mx-(\d+|master)-(\w+)$/.exec(e.target.id);
  if (!m?.ctx || !match) return;
  const [, owner, key] = match;
  const el = e.target;
  if (owner === 'master') {
    setMasterControl(m, key, el.value, committed);
    return;
  }
  if (!committed) setStripControl(m, m.strips[Number(owner)], key, el.value);
}

root.addEventListener('input', (e) => onControl(e, false));
root.addEventListener('change', (e) => onControl(e, true));

/** Shows a Mute or Solo button as solid red when on and neutral when off. */
function setToggle(button, on) {
  button.variant = on ? 'danger' : 'neutral';
  button.appearance = on ? 'accent' : 'outlined';
  // wa-button has no pressed state and does not forward ARIA from its host, so both go on its inner button.
  customElements.whenDefined('wa-button').then(() => button.updateComplete).then(() => {
    const inner = button.shadowRoot.querySelector('button');
    inner.setAttribute('aria-pressed', on);
    inner.setAttribute('aria-description', TIPS[button.dataset.tip]);
  });
}

stripsEl.addEventListener('click', (e) => {
  const button = e.target.closest('wa-button');
  const m = mix;
  if (!button || button.disabled || !m) return;
  const t = m.strips[Number(button.id.split('-')[1])];
  const key = button.dataset.tip;
  t[key] = !t[key];
  setToggle(button, t[key]);
  updateAudible(m);
});

// Teaching tooltips are created on first contact: one per control up front would double first paint.
const tipped = new WeakSet();

function onTipContact(e) {
  // Strips that render under a resting pointer get pointerover, and some browsers send a motionless pointermove.
  if (e.type === 'pointermove' && !e.movementX && !e.movementY) return;
  const el = e.target.closest('[data-tip]');
  if (!el || tipped.has(el)) return;
  tipped.add(el);
  const key = el.dataset.tip;
  const t = mix.strips[Number(el.id.split('-')[1])];
  showValueBubbles(t);
  const tip = document.createElement('wa-tooltip');
  tip.setAttribute('for', el.id);
  if (key === 'fader') tip.placement = 'left';
  tip.innerHTML = key === 'name' ? `${escapeHtml(t.path)}<br>${TIPS.name}` : TIPS[key];
  el.after(tip);
  tip.open = true;
}

stripsEl.addEventListener('pointermove', onTipContact);
stripsEl.addEventListener('focusin', onTipContact);

// --- Transport ---

function canStart(m) {
  return m.strips.every((t) => !t.streaming || t.player || t.failed) && m.frontier > 0;
}

function livePlayers(m) {
  return m.strips.filter((t) => t.player && !t.failed);
}

function updateTransport() {
  const m = mix;
  const focused = document.activeElement;
  startButton.disabled = !(m?.state === 'stopped' && canStart(m));
  startButton.loading = m?.state === 'priming';
  stopButton.disabled = !(m?.state === 'playing' || m?.state === 'priming');
  seek.disabled = !(m?.ctx && m.duration && m.frontier > 0);
  // Disabling the focused button drops focus to <body>, so it moves to the control that takes over.
  let next = null;
  if (focused === startButton && startButton.disabled) next = stopButton.disabled ? seek : stopButton;
  else if (focused === stopButton && stopButton.disabled) next = startButton.disabled ? seek : startButton;
  // A wa-button focuses its inner <button>, which stays disabled until the component's update lands.
  if (next && !next.disabled) next.updateComplete.then(() => next.focus());
}

function positionFrames(m, now) {
  if (m.state !== 'playing') return m.position;
  return Math.min(m.duration, m.transport.frame + Math.max(0, now - m.transport.when) * m.rate);
}

/** Seconds into the song of the audio now reaching the speakers. */
function heardSeconds(m) {
  return m.rate ? positionFrames(m, m.ctx.getOutputTimestamp().contextTime) / m.rate : 0;
}

function isDragging(slider) {
  try {
    return slider.matches(':state(dragging)');
  } catch {
    return false;
  }
}

// Redraws the timecode, and the seek bar when the user is not holding it, once per displayed second.
function updateClock(m, force = false) {
  const rate = m.rate || 1;
  const seconds = heardSeconds(m);
  // Rounded so a resampled track a few frames short of 30 s still reads 0:30, and the end matches it.
  const total = Math.round(m.duration / rate);
  const second = seconds >= m.duration / rate ? total : Math.floor(seconds);
  if (!force && second === m.shownSecond) return;
  m.shownSecond = second;
  clockEl.textContent = `${clock(second)} / ${clock(total)}`;
  if (m.seekTimer || isDragging(seek)) return;
  seek.value = Math.min(seek.max, Math.round(seconds * 10) / 10);
}

function waitPrimed(m, players) {
  return new Promise((resolve) => {
    if (!players.length) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, PRIME_TIMEOUT_MS);
    m.primeWait = {
      pending: new Set(players),
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
    };
  });
}

function settlePrime(m, t) {
  if (m.primeWait?.pending.delete(t) && !m.primeWait.pending.size) m.primeWait.resolve();
}

// Chrome renders a whole output buffer per callback, so a message must arrive about one buffer before its `when`.
function lead(m, min) {
  return Math.max(min, m.ctx.baseLatency);
}

// Primes every player at the current position, then starts them all on one context time.
async function play(m) {
  const resumed = m.ctx.resume().catch(() => {});
  clearTimeout(m.suspendTimer);
  if (m.position >= m.duration) m.position = 0;
  const generation = ++m.generation;
  const frame = m.position;
  m.state = 'priming';
  updateTransport();
  const players = livePlayers(m);
  const primed = waitPrimed(m, players);
  for (const t of players) t.player.port.postMessage({ type: 'prime', generation, frame });
  await Promise.all([primed, resumed]);
  if (m.id !== loadId || m.generation !== generation) return;
  m.primeWait = null;
  const when = m.ctx.currentTime + lead(m, START_LEAD);
  for (const t of livePlayers(m)) t.player.port.postMessage({ type: 'play', generation, when });
  m.transport = { generation, frame, when };
  m.state = 'playing';
  scheduleAutoStop(m);
  startMeters();
  updateTransport();
}

function stop(m) {
  if (m.state === 'playing') {
    const at = m.ctx.currentTime + lead(m, STOP_LEAD);
    for (const t of livePlayers(m)) t.player.port.postMessage({ type: 'stop', when: at });
    m.position = Math.round(positionFrames(m, at));
    m.transport = null;
  } else if (m.state === 'priming') {
    // Bumping the generation cancels the play that is waiting on this prime.
    m.generation++;
    m.primeWait = null;
    for (const t of livePlayers(m)) t.player.port.postMessage({ type: 'stop', when: m.ctx.currentTime });
  } else {
    return;
  }
  m.state = 'stopped';
  clearTimeout(m.autoStopTimer);
  scheduleSuspend(m);
  updateClock(m, true);
  updateTransport();
}

// rAF pauses in hidden tabs, so the end of the song is caught by a timer.
function scheduleAutoStop(m) {
  clearTimeout(m.autoStopTimer);
  if (m.state !== 'playing') return;
  const seconds = (m.duration - positionFrames(m, m.ctx.currentTime)) / m.rate + Math.max(0, m.transport.when - m.ctx.currentTime);
  m.autoStopTimer = setTimeout(() => {
    if (m.id !== loadId || m.state !== 'playing') return;
    // An overloaded audio thread lets the context clock fall behind the wall clock, so check before stopping.
    if (m.duration - positionFrames(m, m.ctx.currentTime) > 0.01 * m.rate) {
      scheduleAutoStop(m);
      return;
    }
    stop(m);
    m.position = m.duration;
    updateClock(m, true);
  }, Math.max(0, seconds * 1000));
}

// An idle context still renders every strip, so it is suspended once the reverb and echo tails have died away.
function scheduleSuspend(m) {
  clearTimeout(m.suspendTimer);
  // Echoes fall 60 dB after ln(1e-3) / ln(feedback) repeats.
  const echo = m.delaySeconds * (1 + Math.log(1e-3) / Math.log(m.feedbackGain));
  m.suspendTimer = setTimeout(() => {
    if (m.id !== loadId || m.state !== 'stopped') return;
    m.ctx.suspend();
    dropMeters(m);
    stopMeters();
  }, (Math.max(m.decay, echo) + 2) * 1000);
}

function seekTo(m, seconds) {
  let frame = Math.max(0, Math.min(Math.round(seconds * m.rate), m.duration));
  if (!m.done && frame > m.frontier) {
    frame = m.frontier;
    seek.value = Math.floor((frame / m.rate) * 10) / 10;
  }
  if (m.state !== 'playing' && m.state !== 'priming') {
    m.position = frame;
    updateClock(m, true);
    return;
  }
  stop(m);
  m.position = frame;
  if (frame < m.duration) play(m);
  else updateClock(m, true);
}

startButton.addEventListener('click', () => {
  const m = mix;
  if (m?.state === 'stopped' && canStart(m)) play(m);
});

stopButton.addEventListener('click', () => {
  if (mix) stop(mix);
});

// Arrow keys step from the thumb, which moves only once a second while playing, so it catches up first.
seek.addEventListener('keydown', () => {
  const m = mix;
  if (m?.state === 'playing' && !m.seekTimer) seek.value = Math.min(seek.max, Math.round(heardSeconds(m) * 10) / 10);
}, true);

// Arrow keys fire change on every press, so seeks are debounced.
seek.addEventListener('change', () => {
  const m = mix;
  if (!m?.ctx) return;
  const seconds = seek.value;
  clearTimeout(m.seekTimer);
  m.seekTimer = setTimeout(() => {
    m.seekTimer = 0;
    if (m.id === loadId) seekTo(m, seconds);
  }, SEEK_DEBOUNCE_MS);
});

// --- Meters ---

let meterBuffer = new Float32Array(0);
let meterFrame = 0;
let meterTime = 0;

// Strips scrolled out of view are not metered.
const onScreen = new WeakSet();
const stripObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) onScreen.add(entry.target);
    else onScreen.delete(entry.target);
  }
});

function startMeters() {
  if (meterFrame) return;
  meterTime = performance.now();
  meterFrame = requestAnimationFrame(tickMeters);
}

function stopMeters() {
  cancelAnimationFrame(meterFrame);
  meterFrame = 0;
}

/**
 * Shows the peak dBFS across the level's channels, falling at a fixed rate so short peaks stay readable.
 * @param {{analysers: AnalyserNode[], el: HTMLMeterElement, shown: number}} level
 * @param {number} dt Seconds since the last update.
 * @returns {boolean} Whether the meter is above the floor.
 */
function updateMeter(level, dt) {
  let peak = 0;
  for (const analyser of level.analysers) {
    if (meterBuffer.length !== analyser.fftSize) meterBuffer = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(meterBuffer);
    for (let i = 0; i < meterBuffer.length; i++) {
      const v = Math.abs(meterBuffer[i]);
      if (v > peak) peak = v;
    }
  }
  const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  const shown = Math.max(FLOOR_DB, db, level.shown - METER_FALL_DB_PER_S * dt);
  // Every meter write costs a style and layout pass, so small moves are skipped.
  if (shown === FLOOR_DB ? level.shown !== FLOOR_DB : Math.abs(shown - level.shown) >= METER_STEP_DB) {
    level.shown = shown;
    level.el.value = shown;
  }
  return level.shown > FLOOR_DB;
}

function dropMeter(level) {
  if (level.shown === FLOOR_DB) return;
  level.shown = FLOOR_DB;
  level.el.value = FLOOR_DB;
}

function tickMeters(time) {
  const m = mix;
  if (time - meterTime < METER_INTERVAL_MS) {
    meterFrame = requestAnimationFrame(tickMeters);
    return;
  }
  meterFrame = 0;
  const dt = Math.min(0.25, (time - meterTime) / 1000);
  meterTime = time;
  let active = false;
  for (const t of m.strips) {
    if (!t.player) continue;
    if (onScreen.has(t.card)) active = updateMeter(t.level, dt) || active;
    else dropMeter(t.level);
  }
  for (const level of m.masterMeters) active = updateMeter(level, dt) || active;
  updateClock(m);
  if (active || m.state === 'playing' || m.state === 'priming') meterFrame = requestAnimationFrame(tickMeters);
}

function dropMeters(m) {
  for (const t of m.strips) dropMeter(t.level);
  for (const level of m.masterMeters ?? []) dropMeter(level);
}

// --- Tabs ---

const tabs = document.getElementById('tabs');

// Stopping here also keeps the meter loop off while the Mixer panel is hidden.
tabs.addEventListener('wa-tab-hide', (e) => {
  if (e.target !== tabs || e.detail.name !== 'mixer') return;
  stopMeters();
  if (!mix) return;
  stop(mix);
  dropMeters(mix);
});
