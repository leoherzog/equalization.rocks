# equalization.rocks

A client-side audio effects chain builder with real-time Web Audio API processing. Users compose a signal chain by adding effect cards (equalization, compressor, delay) between a fixed Source input and Output speaker, then reorder or remove them.

## Tech Stack

- **Web Awesome Pro** (v3.5.0) loaded via CDN kit script -- provides all UI components (`wa-page`, `wa-card`, `wa-dropdown`, `wa-button`, `wa-icon`, `wa-slider`, `wa-file-input`, `wa-scroller`) and Font Awesome icons
- **Web Audio API** -- real-time audio processing (BiquadFilterNode, DynamicsCompressorNode, DelayNode, GainNode)
- **Vanilla JS** -- no framework, no bundler, no build step
- Static HTML/CSS/JS served directly

## File Structure

| File | Purpose |
|---|---|
| `index.html` | Page shell using `<wa-page>` with header and chain container |
| `app.js` | Chain state, render loop, add/delete/move/reset logic, Web Audio graph |
| `styles.css` | Chain layout, connector lines, EQ slider sizing, audio control styling |

## Architecture

- **State**: `chain` array of `{ id, type, params }` objects in `app.js`; `outputVolume` scalar; Web Audio refs (`audioCtx`, `sourceNode`, `outputGainNode`, `activeNodes`)
- **Rendering**: Source card and output card are created once at init and persist across renders. An `#effects-container` div between them is rebuilt on every state change. Slider `input` events update `params` and `AudioParam` values in-place without re-render.
- **Audio graph**: `initAudio()` creates AudioContext and MediaElementSourceNode lazily on first file selection. `buildAudioGraph()` reconnects the full chain (source → effects → outputGain → destination) at the end of every `render()` call. Each effect stores its audio nodes on `effect._audioNodes` for real-time parameter updates from sliders.
- **Events**: `wa-select` on the Add dropdown (a floating action button in the bottom-right corner, outside `<wa-page>`, using `placement="top-end"` so the menu opens upward); click delegation on `#chain` for action buttons (`data-action` / `data-id` attributes)
- **Effect types** defined in `EFFECTS` map with label, icon, description, and `defaults` for initial parameter values
  - **Equalization**: 9-band graphic EQ (32 Hz–16 kHz) using peaking BiquadFilterNodes. Vertical sliders inside a `<wa-scroller>` for mobile support. Has a reset button.
  - **Compressor**: DynamicsCompressorNode with threshold, ratio, attack, release
  - **Delay**: DelayNode with feedback loop (capped at 0.95) and dry/wet mix
  - **Reverb**: ConvolverNode with procedurally generated impulse response (exponentially decaying stereo noise). Decay (0.1–5s) and dry/wet mix. IR buffer regenerated on slider input.
  - **Distortion**: WaveShaperNode with soft-clip transfer curve and 4x oversampling. Drive (0–100) and dry/wet mix.
  - **Noise Gate**: AnalyserNode + GainNode with 20ms polling loop computing RMS→dB. Gate opens/closes via `setTargetAtTime` ramps. Threshold, attack, release. Polling interval cleaned up via `group.cleanup()` in `disconnectNodeGroup`.
  - **Stereo Panner**: StereoPannerNode with single pan parameter (-1 to 1). Slider uses -100 to 100 integer range.
- **Controls**: EQ uses vertical `<wa-slider>` elements (9-band) in a `<wa-scroller>`; compressor and delay use horizontal `<wa-slider>` stacks. Output card has a volume slider controlling a GainNode.
- **Source card**: Uses `<wa-file-input>` for audio file selection with drag-and-drop support. Native `<audio>` element for playback with volume slider hidden via CSS (volume controlled by output GainNode).
- **Shared helper**: `makeSlider(opts)` builds configured `<wa-slider>` elements with formatter, input binding, and optional `hint` text (used on horizontal sliders)
- **Tooltips**: Effect card headers have `<wa-tooltip>` on the icon+label describing what the effect does. EQ band sliders use `<wa-tooltip for="...">` as siblings in the light DOM (since slotted content inside `wa-slider` shadow DOM isn't reachable by tooltip `for`). Compressor/delay sliders use the built-in `hint` attribute instead. `wa-tooltip` requires a `for` attribute pointing to a target element's `id` — it does NOT wrap its target or use a `content` attribute.

## Web Awesome Utilities Used

- `wa-stack`, `wa-cluster`, `wa-split` -- layout
- `wa-gap-*` -- spacing between items
- `wa-align-items-center`, `wa-align-self-stretch` -- alignment
- `wa-heading-xl` -- page title typography
- `wa-tooltip` -- hover descriptions on effect card headers and EQ band sliders
- `wa-slider[hint]` -- inline descriptions on compressor/delay sliders

## Running Locally

```sh
uv run python -m http.server
```

Open `http://localhost:8000`.

## NPM with `.dev.vars`

`.dev.vars` holds `WEBAWESOME_NPM_TOKEN` (gitignored). To run any `npm` command with that token exported as an env var, pipe the file through `xargs` into `env`:

```sh
env $(cat .dev.vars | xargs) npm <command>
```

`cat` emits `KEY=value` lines, `xargs` collapses them into a space-separated arg list, and `env` applies them to the `npm` invocation without leaking them into the parent shell. Do **not** `source .dev.vars` — the values are unquoted and would persist in the current shell.

## Web Awesome Reference

Use the `webawesome` skill for component API docs. Components auto-load via the kit script -- no cherry-pick imports needed. The kit also loads a custom "Awesome" theme variant.
