// Effect metadata and DSP helpers shared by the Signal Chain and Mixer tabs.

export const EFFECTS = {
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

/**
 * Builds a stereo reverb impulse response: noise under a (1 - t/decay)^decay envelope, silent at `decay` seconds.
 * @param {BaseAudioContext} ctx Context whose sample rate the buffer uses.
 * @param {number} decay Tail length in seconds, also the envelope exponent.
 * @returns {AudioBuffer}
 */
export function makeImpulseResponse(ctx, decay) {
  const rate = ctx.sampleRate;
  const length = Math.max(rate * decay, 1);
  const buffer = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return buffer;
}

/**
 * Builds a soft-clip WaveShaper curve. The shaper's input range -1..1 stands for signal levels -headroom..headroom,
 * so the node feeding the shaper must scale by 1 / headroom.
 * @param {number} drive 0..100; 0 is a straight line.
 * @param {number} [headroom] Signal level at the curve's ends.
 * @returns {Float32Array}
 */
export function makeDistortionCurve(drive, headroom = 1) {
  const k = drive * 2;
  // A straight line needs only its two ends. Otherwise an odd length puts a point at exactly x = 0, so silence
  // maps to 0 and the curve adds no DC offset.
  const n = drive ? 44101 : 2;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = headroom * ((2 * i) / (n - 1) - 1);
    curve[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}
