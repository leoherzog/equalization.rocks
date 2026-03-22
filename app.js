const EFFECTS = {
  equalization: {
    label: 'Equalization',
    icon: 'sliders',
    description: 'Changes the volume on specific lower or higher frequencies which changes how things sound.',
    defaults: { sub: 0, low: 0, lowMid: 0, mid: 0, highMid: 0, presence: 0, high: 0, brilliance: 0, air: 0 },
  },
  compressor: {
    label: 'Compressor',
    icon: 'compress',
    description: 'Makes the quiet parts louder and the loud parts quieter.',
    defaults: { threshold: -24, ratio: 4, attack: 10, release: 100 },
  },
  delay: {
    label: 'Delay',
    icon: 'clock',
    description: 'Adds an echo by repeating the sound after a short pause.',
    defaults: { time: 250, feedback: 30, mix: 50 },
  },
  reverb: {
    label: 'Reverb',
    icon: 'church',
    description: 'Simulates the sound of a room, from a small closet to a cathedral.',
    defaults: { decay: 2, mix: 50 },
  },
  distortion: {
    label: 'Distortion',
    icon: 'bolt',
    description: 'Adds grit and crunch by clipping the audio signal.',
    defaults: { drive: 50, mix: 50 },
  },
  gate: {
    label: 'Noise Gate',
    icon: 'door-closed',
    description: 'Silences the sound when it drops below a certain volume, cutting out background noise.',
    defaults: { threshold: -40, attack: 5, release: 50 },
  },
  panner: {
    label: 'Stereo Panner',
    icon: 'arrows-left-right',
    description: 'Moves the sound left or right in the stereo field.',
    defaults: { pan: 0 },
  },
};

const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 8000, 16000];
const EQ_BAND_KEYS = ['sub', 'low', 'lowMid', 'mid', 'highMid', 'presence', 'high', 'brilliance', 'air'];

let chain = [];
let outputVolume = 100;
let sourceCard;
let outputCard;

// Web Audio API state
let audioCtx = null;
let sourceNode = null;
let outputGainNode = null;
let activeNodes = [];

// --- Audio graph ---

function initAudio() {
  if (audioCtx) return;
  audioCtx = new AudioContext();
  const player = sourceCard.querySelector('.source-player');
  sourceNode = audioCtx.createMediaElementSource(player);
  outputGainNode = audioCtx.createGain();
  outputGainNode.gain.value = outputVolume / 100;
  outputGainNode.connect(audioCtx.destination);
  buildAudioGraph();
}

function buildAudioGraph() {
  if (!audioCtx) return;

  sourceNode.disconnect();
  for (const group of activeNodes) disconnectNodeGroup(group);

  activeNodes = chain.map(effect => createAudioNodes(effect));

  let prev = sourceNode;
  for (const group of activeNodes) {
    prev.connect(group.input);
    prev = group.output;
  }
  prev.connect(outputGainNode);
}

function createAudioNodes(effect) {
  if (effect.type === 'equalization') return createEqNodes(effect);
  if (effect.type === 'compressor') return createCompressorNodes(effect);
  if (effect.type === 'delay') return createDelayNodes(effect);
  if (effect.type === 'reverb') return createReverbNodes(effect);
  if (effect.type === 'distortion') return createDistortionNodes(effect);
  if (effect.type === 'gate') return createGateNodes(effect);
  if (effect.type === 'panner') return createPannerNodes(effect);
}

function createEqNodes(effect) {
  const filters = EQ_BAND_KEYS.map((key, i) => {
    const f = audioCtx.createBiquadFilter();
    f.type = 'peaking';
    f.frequency.value = EQ_FREQUENCIES[i];
    f.Q.value = 1.4;
    f.gain.value = effect.params[key];
    return f;
  });
  for (let i = 0; i < filters.length - 1; i++) {
    filters[i].connect(filters[i + 1]);
  }
  const filterMap = {};
  EQ_BAND_KEYS.forEach((key, i) => { filterMap[key] = filters[i]; });
  effect._audioNodes = { type: 'equalization', filterMap };
  return { input: filters[0], output: filters[filters.length - 1] };
}

function createCompressorNodes(effect) {
  const comp = audioCtx.createDynamicsCompressor();
  comp.threshold.value = effect.params.threshold;
  comp.ratio.value = effect.params.ratio;
  comp.attack.value = effect.params.attack / 1000;
  comp.release.value = effect.params.release / 1000;
  effect._audioNodes = { type: 'compressor', comp };
  return { input: comp, output: comp };
}

function createDelayNodes(effect) {
  const input = audioCtx.createGain();
  const output = audioCtx.createGain();
  const delay = audioCtx.createDelay(5.0);
  const feedback = audioCtx.createGain();
  const dry = audioCtx.createGain();
  const wet = audioCtx.createGain();

  delay.delayTime.value = effect.params.time / 1000;
  feedback.gain.value = Math.min(effect.params.feedback / 100, 0.95);
  const mixVal = effect.params.mix / 100;
  dry.gain.value = 1 - mixVal;
  wet.gain.value = mixVal;

  input.connect(dry);
  dry.connect(output);
  input.connect(delay);
  delay.connect(wet);
  wet.connect(output);
  delay.connect(feedback);
  feedback.connect(delay);

  effect._audioNodes = { type: 'delay', delay, feedback, dry, wet };
  return { input, output };
}

function makeImpulseResponse(decay) {
  const rate = audioCtx.sampleRate;
  const length = Math.max(rate * decay, 1);
  const buffer = audioCtx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return buffer;
}

function createReverbNodes(effect) {
  const input = audioCtx.createGain();
  const output = audioCtx.createGain();
  const convolver = audioCtx.createConvolver();
  convolver.buffer = makeImpulseResponse(effect.params.decay);
  const dry = audioCtx.createGain();
  const wet = audioCtx.createGain();

  const mixVal = effect.params.mix / 100;
  dry.gain.value = 1 - mixVal;
  wet.gain.value = mixVal;

  input.connect(dry);
  dry.connect(output);
  input.connect(convolver);
  convolver.connect(wet);
  wet.connect(output);

  effect._audioNodes = { type: 'reverb', convolver, dry, wet };
  return { input, output };
}

function makeDistortionCurve(drive) {
  const k = drive * 2;
  const samples = 44100;
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

function createDistortionNodes(effect) {
  const input = audioCtx.createGain();
  const output = audioCtx.createGain();
  const shaper = audioCtx.createWaveShaper();
  shaper.curve = makeDistortionCurve(effect.params.drive);
  shaper.oversample = '4x';
  const dry = audioCtx.createGain();
  const wet = audioCtx.createGain();

  const mixVal = effect.params.mix / 100;
  dry.gain.value = 1 - mixVal;
  wet.gain.value = mixVal;

  input.connect(dry);
  dry.connect(output);
  input.connect(shaper);
  shaper.connect(wet);
  wet.connect(output);

  effect._audioNodes = { type: 'distortion', shaper, dry, wet };
  return { input, output };
}

function createGateNodes(effect) {
  const input = audioCtx.createGain();
  const output = audioCtx.createGain();
  const analyser = audioCtx.createAnalyser();
  const gateGain = audioCtx.createGain();

  analyser.fftSize = 2048;
  const dataArray = new Float32Array(analyser.fftSize);

  input.connect(analyser);
  analyser.connect(gateGain);
  gateGain.connect(output);

  let isOpen = true;
  const intervalId = setInterval(() => {
    analyser.getFloatTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
    const rms = Math.sqrt(sum / dataArray.length);
    const dB = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

    const now = audioCtx.currentTime;
    if (dB >= effect.params.threshold && !isOpen) {
      isOpen = true;
      gateGain.gain.cancelScheduledValues(now);
      gateGain.gain.setTargetAtTime(1, now, effect.params.attack / 1000 / 3);
    } else if (dB < effect.params.threshold && isOpen) {
      isOpen = false;
      gateGain.gain.cancelScheduledValues(now);
      gateGain.gain.setTargetAtTime(0, now, effect.params.release / 1000 / 3);
    }
  }, 20);

  effect._audioNodes = { type: 'gate', analyser, gateGain };

  const group = { input, output };
  group.cleanup = () => clearInterval(intervalId);
  return group;
}

function createPannerNodes(effect) {
  const panner = audioCtx.createStereoPanner();
  panner.pan.value = effect.params.pan;
  effect._audioNodes = { type: 'panner', panner };
  return { input: panner, output: panner };
}

function disconnectNodeGroup(group) {
  group.cleanup?.();
  group.input.disconnect();
  if (group.output !== group.input) group.output.disconnect();
}

// --- Chain mutations ---

function addEffect(type) {
  chain.push({ id: crypto.randomUUID(), type, params: { ...EFFECTS[type].defaults } });
  render();
}

function removeEffect(id) {
  chain = chain.filter(e => e.id !== id);
  render();
}

function moveEffect(id, dir) {
  const idx = chain.findIndex(e => e.id === id);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= chain.length) return;
  [chain[idx], chain[newIdx]] = [chain[newIdx], chain[idx]];
  render();
}

// --- UI builders ---

function createConnector() {
  const div = document.createElement('div');
  div.className = 'connector';
  div.innerHTML = '<wa-icon name="arrow-down"></wa-icon>';
  return div;
}

function createSourceCard() {
  const card = document.createElement('wa-card');
  card.innerHTML = `
    <div slot="header" class="wa-cluster wa-gap-xs">
      <wa-icon name="music"></wa-icon>
      <span>Source</span>
    </div>
    <wa-file-input class="source-file-input" accept="audio/*"></wa-file-input>
    <audio class="source-player" controls style="display:none;width:100%"></audio>
  `;
  const fileInput = card.querySelector('.source-file-input');
  const player = card.querySelector('.source-player');

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) {
      player.pause();
      if (player.src.startsWith('blob:')) URL.revokeObjectURL(player.src);
      player.removeAttribute('src');
      player.style.display = 'none';
      fileInput.style.display = '';
      return;
    }
    initAudio();
    if (player.src.startsWith('blob:')) URL.revokeObjectURL(player.src);
    player.src = URL.createObjectURL(file);
    player.volume = 1;
    player.style.display = '';
    fileInput.style.display = 'none';
  });

  player.addEventListener('play', () => {
    if (audioCtx?.state === 'suspended') audioCtx.resume();
  });

  player.addEventListener('volumechange', () => {
    if (audioCtx) player.volume = 1;
  });

  return card;
}

function createOutputCard() {
  const card = document.createElement('wa-card');

  const header = document.createElement('div');
  header.slot = 'header';
  header.className = 'wa-cluster wa-gap-xs';
  header.innerHTML = '<wa-icon name="volume-high"></wa-icon><span>Output</span>';

  const slider = makeSlider({
    label: 'Volume',
    min: 0, max: 100, value: outputVolume, step: 1,
    formatter: v => `${v}%`,
    onInput: v => {
      outputVolume = v;
      if (outputGainNode) {
        outputGainNode.gain.value = v / 100;
      } else {
        const player = sourceCard.querySelector('.source-player');
        if (player) player.volume = v / 100;
      }
    },
  });

  card.appendChild(header);
  card.appendChild(slider);
  return card;
}

function makeSlider(opts) {
  const slider = document.createElement('wa-slider');
  slider.setAttribute('label', opts.label);
  slider.setAttribute('min', opts.min);
  slider.setAttribute('max', opts.max);
  slider.setAttribute('value', opts.value);
  slider.setAttribute('step', opts.step);
  slider.setAttribute('size', 'small');
  slider.setAttribute('with-tooltip', '');
  if (opts.hint) slider.setAttribute('hint', opts.hint);
  if (opts.orientation) slider.setAttribute('orientation', opts.orientation);
  if (opts.indicatorOffset != null) slider.setAttribute('indicator-offset', opts.indicatorOffset);
  customElements.whenDefined('wa-slider').then(() => {
    if (opts.formatter) slider.valueFormatter = opts.formatter;
  });
  slider.addEventListener('input', () => { opts.onInput(slider.value); });
  return slider;
}

function createEqControls(effect) {
  const bands = [
    { key: 'sub', label: '32 Hz', tooltip: 'Sub-bass — the deep rumble you feel more than hear.' },
    { key: 'low', label: '64 Hz', tooltip: 'Bass — the thump of kick drums and bass guitars.' },
    { key: 'lowMid', label: '125 Hz', tooltip: 'Low mids — adds warmth and body to sounds.' },
    { key: 'mid', label: '250 Hz', tooltip: 'Mids — where most vocals and instruments live.' },
    { key: 'highMid', label: '500 Hz', tooltip: 'Upper mids — controls clarity and punch.' },
    { key: 'presence', label: '1 kHz', tooltip: 'Presence — makes sounds feel closer and more detailed.' },
    { key: 'high', label: '2 kHz', tooltip: 'Highs — adds brightness and edge to sounds.' },
    { key: 'brilliance', label: '8 kHz', tooltip: 'Brilliance — the sparkle and shimmer of cymbals and strings.' },
    { key: 'air', label: '16 kHz', tooltip: 'Air — the very top, adds openness and space.' },
  ];
  let eqUid = 0;
  const scroller = document.createElement('wa-scroller');
  const container = document.createElement('div');
  container.className = 'eq-sliders wa-split';
  const dbFormatter = v => `${v > 0 ? '+' : ''}${v} dB`;
  for (const band of bands) {
    const slider = makeSlider({
      label: band.label,
      min: -12, max: 12, value: effect.params[band.key], step: 1,
      orientation: 'vertical',
      indicatorOffset: 0,
      formatter: dbFormatter,
      onInput: v => {
        effect.params[band.key] = v;
        if (effect._audioNodes?.filterMap?.[band.key]) {
          effect._audioNodes.filterMap[band.key].gain.value = v;
        }
      },
    });
    const id = `eq-band-${effect.id}-${eqUid++}`;
    slider.id = id;
    const tip = document.createElement('wa-tooltip');
    tip.setAttribute('for', id);
    tip.textContent = band.tooltip;
    container.appendChild(slider);
    container.appendChild(tip);
  }
  scroller.appendChild(container);
  return scroller;
}

function createCompressorControls(effect) {
  const container = document.createElement('div');
  container.className = 'wa-stack wa-gap-s';
  const params = [
    { key: 'threshold', label: 'Threshold', min: -60, max: 0, step: 1, formatter: v => `${v} dB`, hint: 'How loud a sound has to be before it gets turned down.' },
    { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.5, formatter: v => `${v}:1`, hint: 'How much the loud parts get squished down.' },
    { key: 'attack', label: 'Attack', min: 0, max: 200, step: 1, formatter: v => `${v} ms`, hint: 'How quickly the compressor kicks in after a loud sound.' },
    { key: 'release', label: 'Release', min: 10, max: 1000, step: 10, formatter: v => `${v} ms`, hint: 'How quickly the compressor lets go after the sound gets quiet.' },
  ];
  for (const p of params) {
    container.appendChild(makeSlider({
      label: p.label, hint: p.hint,
      min: p.min, max: p.max, value: effect.params[p.key], step: p.step,
      formatter: p.formatter,
      onInput: v => {
        effect.params[p.key] = v;
        const nodes = effect._audioNodes;
        if (!nodes) return;
        if (p.key === 'threshold') nodes.comp.threshold.value = v;
        else if (p.key === 'ratio') nodes.comp.ratio.value = v;
        else if (p.key === 'attack') nodes.comp.attack.value = v / 1000;
        else if (p.key === 'release') nodes.comp.release.value = v / 1000;
      },
    }));
  }
  return container;
}

function createDelayControls(effect) {
  const container = document.createElement('div');
  container.className = 'wa-stack wa-gap-s';
  const params = [
    { key: 'time', label: 'Time', min: 1, max: 2000, step: 1, formatter: v => `${v} ms`, hint: 'How long before each echo repeats.' },
    { key: 'feedback', label: 'Feedback', min: 0, max: 100, step: 1, formatter: v => `${v}%`, hint: 'How many times the echo repeats — higher means more echoes.' },
    { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, formatter: v => `${v}%`, hint: 'How much echo you hear compared to the original sound.' },
  ];
  for (const p of params) {
    container.appendChild(makeSlider({
      label: p.label, hint: p.hint,
      min: p.min, max: p.max, value: effect.params[p.key], step: p.step,
      formatter: p.formatter,
      onInput: v => {
        effect.params[p.key] = v;
        const nodes = effect._audioNodes;
        if (!nodes) return;
        if (p.key === 'time') nodes.delay.delayTime.value = v / 1000;
        else if (p.key === 'feedback') nodes.feedback.gain.value = Math.min(v / 100, 0.95);
        else if (p.key === 'mix') {
          nodes.dry.gain.value = 1 - (v / 100);
          nodes.wet.gain.value = v / 100;
        }
      },
    }));
  }
  return container;
}

function createReverbControls(effect) {
  const container = document.createElement('div');
  container.className = 'wa-stack wa-gap-s';
  const params = [
    { key: 'decay', label: 'Decay', min: 0.1, max: 5, step: 0.1, formatter: v => `${v} s`, hint: 'How long the reverb tail lasts — longer feels like a bigger room.' },
    { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, formatter: v => `${v}%`, hint: 'How much reverb you hear compared to the original sound.' },
  ];
  for (const p of params) {
    container.appendChild(makeSlider({
      label: p.label, hint: p.hint,
      min: p.min, max: p.max, value: effect.params[p.key], step: p.step,
      formatter: p.formatter,
      onInput: v => {
        effect.params[p.key] = v;
        const nodes = effect._audioNodes;
        if (!nodes) return;
        if (p.key === 'decay') nodes.convolver.buffer = makeImpulseResponse(v);
        else if (p.key === 'mix') {
          nodes.dry.gain.value = 1 - (v / 100);
          nodes.wet.gain.value = v / 100;
        }
      },
    }));
  }
  return container;
}

function createDistortionControls(effect) {
  const container = document.createElement('div');
  container.className = 'wa-stack wa-gap-s';
  const params = [
    { key: 'drive', label: 'Drive', min: 0, max: 100, step: 1, formatter: v => `${v}%`, hint: 'How much the sound gets crunched and distorted.' },
    { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, formatter: v => `${v}%`, hint: 'How much distortion you hear compared to the original sound.' },
  ];
  for (const p of params) {
    container.appendChild(makeSlider({
      label: p.label, hint: p.hint,
      min: p.min, max: p.max, value: effect.params[p.key], step: p.step,
      formatter: p.formatter,
      onInput: v => {
        effect.params[p.key] = v;
        const nodes = effect._audioNodes;
        if (!nodes) return;
        if (p.key === 'drive') nodes.shaper.curve = makeDistortionCurve(v);
        else if (p.key === 'mix') {
          nodes.dry.gain.value = 1 - (v / 100);
          nodes.wet.gain.value = v / 100;
        }
      },
    }));
  }
  return container;
}

function createGateControls(effect) {
  const container = document.createElement('div');
  container.className = 'wa-stack wa-gap-s';
  const params = [
    { key: 'threshold', label: 'Threshold', min: -80, max: 0, step: 1, formatter: v => `${v} dB`, hint: 'Sounds quieter than this get silenced.' },
    { key: 'attack', label: 'Attack', min: 0, max: 100, step: 1, formatter: v => `${v} ms`, hint: 'How quickly the gate opens when sound is detected.' },
    { key: 'release', label: 'Release', min: 5, max: 500, step: 5, formatter: v => `${v} ms`, hint: 'How quickly the gate closes after the sound stops.' },
  ];
  for (const p of params) {
    container.appendChild(makeSlider({
      label: p.label, hint: p.hint,
      min: p.min, max: p.max, value: effect.params[p.key], step: p.step,
      formatter: p.formatter,
      onInput: v => { effect.params[p.key] = v; },
    }));
  }
  return container;
}

function createPannerControls(effect) {
  const container = document.createElement('div');
  container.className = 'wa-stack wa-gap-s';
  container.appendChild(makeSlider({
    label: 'Pan', hint: 'Move the sound between the left and right speakers.',
    min: -100, max: 100, value: effect.params.pan * 100, step: 1,
    formatter: v => {
      const val = v / 100;
      if (val < -0.01) return `${Math.round(Math.abs(val) * 100)}% L`;
      if (val > 0.01) return `${Math.round(val * 100)}% R`;
      return 'Center';
    },
    onInput: v => {
      effect.params.pan = v / 100;
      if (effect._audioNodes?.panner) {
        effect._audioNodes.panner.pan.value = v / 100;
      }
    },
  }));
  return container;
}

const CONTROLS_BUILDER = {
  equalization: createEqControls,
  compressor: createCompressorControls,
  delay: createDelayControls,
  reverb: createReverbControls,
  distortion: createDistortionControls,
  gate: createGateControls,
  panner: createPannerControls,
};

function createEffectCard(effect, index, total) {
  const meta = EFFECTS[effect.type];
  const card = document.createElement('wa-card');
  card.setAttribute('appearance', 'filled-outlined');

  const header = document.createElement('div');
  header.slot = 'header';
  header.className = 'wa-cluster wa-gap-xs';
  const headerId = `effect-header-${effect.id}`;
  header.innerHTML = `<span id="${headerId}" class="wa-cluster wa-gap-xs"><wa-icon name="${meta.icon}"></wa-icon><span>${meta.label}</span></span><wa-tooltip for="${headerId}">${meta.description}</wa-tooltip>`;

  const actions = document.createElement('div');
  actions.slot = 'header-actions';
  actions.className = 'wa-cluster wa-gap-2xs';
  actions.innerHTML = `
    ${effect.type === 'equalization' ? `<wa-button size="small" appearance="plain" data-action="reset" data-id="${effect.id}"><wa-icon name="arrow-rotate-left"></wa-icon></wa-button>` : ''}
    <wa-button size="small" appearance="plain" data-action="move-up" data-id="${effect.id}" ${index === 0 ? 'disabled' : ''}>
      <wa-icon name="arrow-up"></wa-icon>
    </wa-button>
    <wa-button size="small" appearance="plain" data-action="move-down" data-id="${effect.id}" ${index === total - 1 ? 'disabled' : ''}>
      <wa-icon name="arrow-down"></wa-icon>
    </wa-button>
    <wa-button size="small" appearance="plain" variant="danger" data-action="delete" data-id="${effect.id}">
      <wa-icon name="xmark"></wa-icon>
    </wa-button>
  `;

  const controls = CONTROLS_BUILDER[effect.type](effect);

  card.appendChild(header);
  card.appendChild(actions);
  card.appendChild(controls);
  return card;
}

// --- Render (effects only) ---

function render() {
  const ec = document.getElementById('effects-container');
  ec.innerHTML = '';

  for (let i = 0; i < chain.length; i++) {
    ec.appendChild(createConnector());
    ec.appendChild(createEffectCard(chain[i], i, chain.length));
  }

  buildAudioGraph();
}

// --- Init ---

const container = document.getElementById('chain');

sourceCard = createSourceCard();
container.appendChild(sourceCard);

const effectsContainer = document.createElement('div');
effectsContainer.id = 'effects-container';
effectsContainer.className = 'wa-stack wa-align-items-center wa-gap-0 wa-align-self-stretch';
container.appendChild(effectsContainer);

container.appendChild(createConnector());

outputCard = createOutputCard();
container.appendChild(outputCard);

// --- Theme ---

const THEME_ICONS = { auto: 'circle-half-stroke', light: 'sun-bright', dark: 'moon' };
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function applyTheme(mode) {
  const isDark = mode === 'dark' || (mode === 'auto' && darkQuery.matches);
  document.documentElement.classList.toggle('wa-dark', isDark);
  document.getElementById('theme-icon').name = THEME_ICONS[mode];
}

function setTheme(mode) {
  localStorage.setItem('colorScheme', mode);
  applyTheme(mode);
}

applyTheme(localStorage.getItem('colorScheme') || 'auto');
darkQuery.addEventListener('change', () => {
  applyTheme(localStorage.getItem('colorScheme') || 'auto');
});

document.getElementById('theme-dropdown').addEventListener('wa-select', (e) => {
  setTheme(e.detail.item.value);
});

document.getElementById('add-dropdown').addEventListener('wa-select', (e) => {
  addEffect(e.detail.item.value);
});

document.getElementById('chain').addEventListener('click', (e) => {
  const button = e.target.closest('wa-button[data-action]');
  if (!button) return;

  const { action, id } = button.dataset;
  if (action === 'delete') removeEffect(id);
  else if (action === 'move-up') moveEffect(id, -1);
  else if (action === 'move-down') moveEffect(id, 1);
  else if (action === 'reset') {
    const effect = chain.find(e => e.id === id);
    if (effect) { Object.assign(effect.params, EFFECTS[effect.type].defaults); render(); }
  }
});
