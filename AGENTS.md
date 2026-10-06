# equalization.rocks

A client-side audio workbench with two tabs, built on the Web Audio API. **Signal Chain** plays one audio file through effect cards that the user adds, reorders, and removes between a fixed Source and Output. **Mixer** loads a multitrack session, a .zip or several loose audio files, into one channel strip per track and plays every track in sample-accurate sync. Nothing is uploaded; all decoding and processing happen in the browser.

## Tech Stack

- **Web Awesome Pro** loaded via CDN kit script -- all UI components (`wa-page`, `wa-tab-group`, `wa-card`, `wa-dropdown`, `wa-button`, `wa-icon`, `wa-slider`, `wa-file-input`, `wa-scroller`, `wa-tooltip`, `wa-progress-bar`, `wa-callout`, `wa-divider`) and Font Awesome icons
- **Web Audio API** -- native nodes for both tabs, plus an AudioWorklet processor that streams Mixer tracks
- **Web Worker, DecompressionStream, OPFS** -- the Mixer reads zips, unpacks audio, and stores it off the main thread
- **Vanilla JS modules** -- no framework, no bundler, no build step
- Static HTML/CSS/JS served directly

## File Structure

| File | Purpose |
|---|---|
| `index.html` | Page shell: `<wa-page>` header with the theme picker, a `wa-tab-group` with the Signal Chain and Mixer panels, and the Signal Chain's floating Add button. Loads only `app.js` |
| `app.js` | Entry module: imports `signalchain.js` and `mixer.js`, then applies the color theme from the header picker |
| `signalchain.js` | Signal Chain tab: chain state, render loop, add/delete/move/reset logic, Web Audio graph, and the Add button's visibility |
| `effects.js` | `EFFECTS` metadata and the `makeImpulseResponse` and `makeDistortionCurve` DSP helpers, shared by both tabs |
| `mixer.js` | Mixer tab: panel UI, AudioContext, strip and bus graph, transport, meters, and teaching tooltips |
| `mixer-worker.js` | Module Worker, one per session: zip, WAV, and AIFF reading, unpacking, 16-bit storage, and chunk serving |
| `mixer-worklet.js` | AudioWorklet processor `track-player`: plays one track from streamed chunks at absolute context frames, with a built-in gate and compressor |
| `styles.css` | Chain layout, connector lines, EQ slider sizing, the Add button, and the Mixer's layout, strips, faders, and meters |
| `assets/` | Favicons, app icons, web app manifest, Open Graph card, and `generate.py`, which renders the raster images |
| `robots.txt`, `sitemap.xml` | Crawler directives; must stay at the site root |
| `README.md` | Public project description and license |

## SEO and Icons

`index.html` carries the description, canonical link, Open Graph and Twitter card tags, and `WebApplication` JSON-LD. The canonical, `og:url`, `og:image`, and JSON-LD URLs are absolute to `https://equalization.rocks/`, since social crawlers reject relative image URLs. Keep the description identical across the meta tag, `og:description`, the JSON-LD, and `assets/site.webmanifest`.

`assets/favicon.svg` is the hand-placed Font Awesome Pro `message-music` duotone glyph and the single source for every other icon. `uv run assets/generate.py` reads its two paths and renders `og-image.png`, the app icons, and `favicon.ico`, using Inter fetched from Fontsource and colors from the kit's elegant palette. Commit the rendered images; nothing renders them at deploy time.

## Signal Chain

- **State**: `chain` array of `{ id, type, params }` objects in `signalchain.js`; `outputVolume` scalar; Web Audio refs (`audioCtx`, `sourceNode`, `outputGainNode`, `activeNodes`)
- **Rendering**: Source card and output card are created once at init and persist across renders. An `#effects-container` div between them is rebuilt on every state change. Slider `input` events update `params` and `AudioParam` values in-place without re-render.
- **Audio graph**: `initAudio()` creates AudioContext and MediaElementSourceNode lazily on first file selection. `buildAudioGraph()` reconnects the full chain (source → effects → outputGain → destination) at the end of every `render()` call. Each effect stores its audio nodes on `effect._audioNodes` for real-time parameter updates from sliders.
- **Events**: `wa-select` on the Add dropdown (a floating action button in the bottom-right corner, outside `<wa-page>`, using `placement="top-end"` so the menu opens upward); click delegation on `#chain` for action buttons (`data-action` / `data-id` attributes)
- **Tabs**: `wa-tab-show` and `wa-tab-hide` on `#tabs` hide the Add button outside this tab and pause the player when the tab is left. The first selection fires no event and `tabs.active` is `''` until then, so an empty value means Signal Chain.
- **Effect types** defined in the `EFFECTS` map in `effects.js` with label, icon, description, and `defaults` for initial parameter values. The Mixer reuses the descriptions in its tooltips.
  - **Equalization**: 9-band graphic EQ (32 Hz–16 kHz) using peaking BiquadFilterNodes. Vertical sliders inside a `<wa-scroller>` for mobile support. Has a reset button.
  - **Compressor**: DynamicsCompressorNode with threshold, ratio, attack, release
  - **Delay**: DelayNode with feedback loop (capped at 0.95) and dry/wet mix
  - **Reverb**: ConvolverNode with an impulse response from `makeImpulseResponse` (stereo noise under a `(1 − t/decay)^decay` envelope that reaches silence at `decay` seconds). Decay (0.1–5s) and dry/wet mix. IR buffer regenerated on slider input.
  - **Distortion**: WaveShaperNode with the soft-clip curve from `makeDistortionCurve` and 4x oversampling. Drive (0–100) and dry/wet mix.
  - **Noise Gate**: AnalyserNode + GainNode with 20ms polling loop computing RMS→dB. Gate opens/closes via `setTargetAtTime` ramps. Threshold, attack, release. Polling interval cleaned up via `group.cleanup()` in `disconnectNodeGroup`.
  - **Stereo Panner**: StereoPannerNode with single pan parameter (-1 to 1). Slider uses -100 to 100 integer range.
- **Controls**: EQ uses vertical `<wa-slider>` elements (9-band) in a `<wa-scroller>`; every other effect uses a horizontal `<wa-slider>` stack. Output card has a volume slider controlling a GainNode.
- **Source card**: Uses `<wa-file-input>` for audio file selection with drag-and-drop support. Native `<audio>` element for playback with volume slider hidden via CSS (volume controlled by output GainNode).
- **Shared helper**: `makeSlider(opts)` builds configured `<wa-slider>` elements with formatter, input binding, and optional `hint` text (used on horizontal sliders)
- **Tooltips**: Effect card headers have `<wa-tooltip>` on the icon+label describing what the effect does. EQ band sliders use `<wa-tooltip for="...">` as siblings in the light DOM, since slotted content inside the `wa-slider` shadow DOM isn't reachable by tooltip `for`. Sliders on the other effects use the built-in `hint` attribute instead. `wa-tooltip` requires a `for` attribute pointing to the target element's `id`; it does not wrap its target or take a `content` attribute.

## Mixer

`mixer.js` builds the panel once at import. Each file pick calls `load(files)`, which bumps `loadId`, tears down the previous session's worker and AudioContext, and starts a new session. Every await continuation and message handler compares its session with `loadId` and returns early once a newer load has started.

### Threads

The work is split across three threads, so unpacking gigabytes of audio never blocks the UI and every track plays on one sample clock. The Mixer needs Chrome 103, Firefox 114, or Safari 16.4 for `DecompressionStream('deflate-raw')`, module Workers, and AudioWorklet.

- **Main** (`mixer.js`): UI, the AudioContext and native nodes, the transport, and meters
- **Worker** (`mixer-worker.js`, one per session): all file I/O, unzipping, WAV and AIFF parsing, PCM conversion, decimation, storage, and chunk serving. A Worker cannot create AudioNodes.
- **Audio thread**: one `track-player` AudioWorkletNode per track, plus the native nodes

Each track gets its own `MessageChannel`. `port1` goes to the track's node and `port2` to the worker, so chunks flow from worker to worklet without touching the main thread. A port queues messages until the other side listens, so the order of the two `connect` messages does not matter.

### Sample Rate and Formats

`sessionRate()` picks the context rate so the worker only ever decimates by an integer factor k of 1, 2, or 4. It takes the most common rate among the WAV and AIFF tracks the worker parsed and divides it by the largest k that keeps it at or above 44.1 kHz, so 88.2 kHz becomes 44.1 kHz. Large sessions at 88.2 kHz can render slower than real time, and the browser resamples the context rate to the device natively. When no rate fits, the context uses the device default.

Decimation is a Kaiser-windowed sinc FIR whose output frame j is centered on input frame j × k. That compensates the filter's group delay, so tracks with different k stay frame-aligned. At k = 1 samples pass straight through.

A parsed WAV or AIFF streams when its rate divided by the context rate is 1, 2, or 4. Every other file, including other rates, MP3, FLAC, and formats the parser rejects, takes the decode path: the worker posts the file's bytes, the main thread runs `decodeAudioData` and posts the channels back, and the worker stores them like a streamed track. A parsed AIFF goes over as a 32-bit float WAV, because `decodeAudioData` in Chrome and Firefox cannot read AIFF. Only one file decodes at a time, which bounds memory, and a decoded track gets its `format` message and player only once every piece is stored.

### Unpacking and Storage

The worker unpacks round-robin: each pass gives every unfinished track one 5-second piece. The whole song becomes playable within seconds, where unpacking track by track would leave the last tracks minutes behind. Deflated entries inflate in small steps, each drained before the next, because Chrome inflates a whole input chunk at once and digital silence expands about 1000:1. The loop yields through a `MessageChannel` task after every 8 ms of work, so chunk requests stay responsive.

Each piece is interleaved Int16 at the context rate, with at most two channels. A source with more channels folds into stereo, channel c adding into channel c mod 2, scaled by 1 / √⌈channels / 2⌉. Float sources and folded tracks can exceed full scale, so they are stored at 1/8 scale, and a decoded track uses the smallest power-of-two scale that fits its largest finite sample. Each track keeps its scale as `unit`, and `serve()` multiplies by it, so the worklet receives the true level.

Progress reports the frontier, the smallest unpacked frame count over unfinished streaming tracks, at most four times a second. Start waits for every streaming track's `format` message and a nonzero frontier, and seeking clamps to the frontier until unpacking is done.

Pieces append, in the order they are made, to one file per session in the origin private file system, written and read synchronously through a `FileSystemSyncAccessHandle`. Each track records its pieces' byte offsets. Unpacked audio therefore sits on disk in every browser; Blobs would not do, because Firefox keeps constructed Blobs in memory.

The file is named `mixer-<uuid>.pcm`, after a Web Lock that its worker holds until it ends. `openStore()` first removes every `mixer-` file whose lock is free, so the audio of a replaced session or a closed tab goes when the Mixer next loads a session. It then opens the session's file before unpacking starts, because in Chromium, opens that overlapped unpacking sometimes never settled.

Where OPFS is unavailable, as in a Firefox private window, pieces stay in worker memory. `mixer.js` warns when the streaming tracks will unpack to more than 1.5 GB. A write or read that throws or comes up short stops unpacking and posts a storage error, and what is already unpacked stays playable.

### Transport and Sync

Start bumps the session's `generation`, resumes the context, posts `prime { generation, frame }` to every node, and waits for every `primed` reply or 3 seconds. A node is primed once it holds one second from `frame`, or up to the track's end. Start then posts `play { generation, when }`, and the processor outputs file frame `frame + currentFrame + i - round(when × sampleRate)` at output sample i, so every track starts on the same context frame. Missing data plays as silence while the position keeps advancing, so a late chunk never moves a track out of sync, and data after a gap fades in over 256 frames.

The context uses `latencyHint: 0.2`, because large sessions on slow machines underrun Chrome's `'playback'` buffer of about 1024 frames. Chrome renders a whole output buffer per callback, so a message must arrive about one buffer before its `when`. `lead()` therefore puts `when` max(50 ms, `ctx.baseLatency`) ahead for play and max(30 ms, `ctx.baseLatency`) ahead for stop.

Stop posts `stop { when }`, and each node fades out over 256 frames from that context frame. Stopping while priming also bumps the generation, which cancels the waiting play. Nodes keep their buffered chunks, so Start at the same position primes at once. A node created mid-play, as a decoded track can be, gets prime and play with the stored transport values and joins in sync. The processor requests 1-second chunks to stay 2 seconds ahead; the worker drops requests from stale generations and never answers past a track's end.

The end of the song is caught by a `setTimeout`, because rAF pauses in hidden tabs, and it reschedules itself while the context clock lags the wall clock. A stopped context still renders every strip, so `scheduleSuspend()` suspends it 2 seconds after the longer of the reverb decay and the echo tail, which falls 60 dB after ln(10⁻³) / ln(feedback) repeats. Changing a Master reverb or delay setting while the stopped context still runs restarts that timer. Leaving the Mixer tab stops the transport.

### Dynamics in track-player

The strip's gate and compressor run inside `track-player` on one shared peak detector that follows the loudest channel. They only scale samples, so they add no latency. A separate gate node per track costs about 75% more CPU, and switching a DynamicsCompressorNode in and out shifts a track by about 6 ms, which comb-filters multi-mic sources. At their off values, gate −80 dB and comp 0, the processor skips the math.

A play that starts from silence resets the dynamics and seeds them with the peak of the first 20 ms of data, taken on the first render quantum that copies any. A node that joins mid-play, or whose prime timed out, gets its first data after the play position, so the seed starts there. Otherwise the gate would start open and leak noise, and the compressor would start with no gain reduction and overshoot. While an older segment is still fading out, as in a quick seek, the state carries over.

### Strip Graph and Buses

Each strip runs player → low shelf 100 Hz → peaking 1 kHz → high shelf 10 kHz → headroom gain → WaveShaper → fader gain → StereoPanner → master bus. Post-pan send gains feed the delay and reverb buses. Routing never changes: mute and solo set the fader gain, and continuous parameters move with `setTargetAtTime` to avoid clicks.

Every node in a strip must add zero latency, or the track shifts against the others, so the WaveShaper uses `oversample: 'none'`; Chrome's 2x and 4x add latency. The headroom gain scales by 1/4 and `driveCurve()` spans ±4, so EQ boosts past full scale bend softly instead of clipping at the curve's ends. The curve has the drive's makeup gain baked in, so one curve swap changes both. Drive 0 is a two-point straight line that undoes the headroom gain; a `null` curve would leave the track 12 dB down.

The master bus feeds the master fader, which feeds the destination. The reverb bus sums its input to mono, so the stereo impulse response stays wide for any pan, and it rebuilds the impulse response on the decay slider's `change`, not `input`. The delay bus feeds back through a gain capped at 0.95. The master fader starts at −10 × log10(track count) dB, rounded and clamped to −24..0, so many summed tracks do not clip.

Track names set defaults. Names containing "click" start muted, and `.L` or `.R` right before the extension pans hard left or right. A space-separated ` R` marks a rack tom, so only the dot form counts.

### Meters

`meterTap()` splits a signal with a ChannelSplitterNode into one AnalyserNode per channel, and the meter shows the peak across them, because an AnalyserNode mixes its input to mono and would hide one-sided or out-of-phase sound. Each `fftSize` is the smallest power of two that holds `ctx.baseLatency` plus one 30 ms meter interval of audio, capped at 32768, since the audio thread renders a whole output buffer between reads. Strip meters tap the fader gain before the panner, so they read the track's own channels whatever its pan. The master meters tap the master fader.

One rAF loop reads the meters at most every 30 ms and redraws the clock once per displayed second. A meter falls at 24 dB per second, and moves under 0.5 dB are not written, because every write costs a style and layout pass. An IntersectionObserver skips strips scrolled out of view and drops their meters to the floor. The loop runs while playing or priming and until every meter reaches the floor, and suspending the context drops them all.

### Layout

The empty state is centered at the Signal Chain's 600px width, and a loaded session spans the window. Whole strips, through the fader and Mute/Solo, must fit a 900px-tall window; that sets the condensed labels, the 7rem faders, and the tight panel margins. `#mx-desk` pins the Master card beside the strip scroller and wraps it below when fewer than two strips would fit.

### Tooltips and Hints

Copy comes from the `TIPS` table, which reuses `EFFECTS` descriptions where they fit. Every Mixer slider carries its tip in `hint` for screen readers, and `styles.css` hides the hint part on screen. Mute and Solo carry theirs as `aria-description`. Strip meters are `aria-hidden`; the master meters are labeled Left level and Right level, and their visible L and R are `aria-hidden`.

Strip tooltips are created on a control's first `focusin` or first `pointermove` with nonzero movement, delegated on the strips container, because one per control up front would double first paint. Strips that render under a resting pointer get `pointerover` and, in some browsers, a motionless `pointermove`, and neither opens a tooltip. Slider value bubbles (`withTooltip`) are switched on four strips per task after the first frame, and at once for a strip the user reaches first. The Master card and transport tooltips are created eagerly.

### Traps

- **Zip offsets**: entries can set the data-descriptor flag and leave local sizes at zero, so sizes come only from the central directory. Data starts at `lho + 30 + nameLen + extraLen`, read from the local header, whose extra length can differ from the central one. DecompressionStream must get exactly `[dataStart, dataStart + csize)`; extra or missing bytes throw.
- **Unsigned offsets**: offsets and sizes pass 2^31 in real sessions. Read them with `getUint32` or `getBigUint64` and use plain Number math, never `|0`, `<<`, or `>>`.
- **Junk filter order**: drop folders, `__MACOSX/`, `._*`, and `.DS_Store` before the audio-extension test. Each track's AppleDouble `._` twin has a `.wav` extension.
- **WAV format**: classify by format tag (the SubFormat for `0xFFFE`), never by fmt chunk size. Take the data size from the `data` chunk, since metadata chunks follow it. RF64 and BW64 keep the real size in `ds64`, and a size of 0 marks an unfinalized recording whose audio runs to the end of the entry.
- **AIFF format**: samples are big-endian except in AIFC `sowt`, the sample rate is an 80-bit extended float, and audio starts after the `SSND` offset field.
- **Worklet module**: `await ctx.audioWorklet.addModule()` before constructing any AudioWorkletNode, or the constructor throws `InvalidStateError`.
- **Context rate**: `new AudioContext({ sampleRate: null })` throws `NotSupportedError`. Omit the key instead.
- **Worklet scope**: `performance` is undefined there, so time is counted in frames. Size loops from `outputs[0][0].length`, not 128.
- **wa-file-input**: handle `change` only; the component leaks its inner input's `input` event, which carries the previous files. After reading `files`, set `files = []`, which fires no event and keeps the `multiple` list from growing with every pick.
- **Sizes**: Web Awesome sizes are `xs`, `s`, `m`, `l`, and `xl`. `small`, `medium`, and `large` are deprecated and log warnings.
- **wa-tab**: it has only a default slot, so an icon with `slot="start"` does not render.
- **Toggles**: Mute and Solo are `wa-button`s, solid red (`danger`, `accent`) when on and neutral `outlined` when off. A `wa-button` has no pressed state and does not forward ARIA from its host, so `setToggle()` sets `aria-pressed` and `aria-description` on the inner `<button>` in its open shadow root.
- **Slider values**: a value whose distance from `min` is not a whole number of `step`s makes the slider invalid.
- **Fader length**: a vertical `wa-slider` track's length is set only through `::part(track)`; host height does nothing.

## Web Awesome Utilities Used

- `wa-stack`, `wa-cluster`, `wa-split`, `wa-flank`, `wa-flank:end` -- layout
- `wa-flex-nowrap` -- keeps Mixer strips and fader rows on one line
- `wa-gap-*` -- spacing between items
- `wa-align-items-center`, `wa-align-items-start`, `wa-align-self-stretch`, `wa-justify-content-center` -- alignment
- `wa-heading-xl`, `wa-body-m`, `wa-caption-m`, `wa-form-control-label`, `wa-font-size-xs` -- typography
- `wa-text-truncate` -- clips long track names in strip headers; it needs a block element
- `wa-tooltip` -- hover descriptions on effect card headers, EQ band sliders, and every Mixer control
- `wa-slider[hint]` -- inline descriptions on Signal Chain effect sliders, and screen-reader text on Mixer controls

## Running Locally

```sh
uv run python -m http.server
```

Open `http://localhost:8000`. Use `localhost`, not `127.0.0.1`: the kit's domain allowlist rejects 127.0.0.1, so icons fail to load.

## NPM with `.dev.vars`

`.dev.vars` holds `WEBAWESOME_NPM_TOKEN` (gitignored). To run any `npm` command with that token exported as an env var, pipe the file through `xargs` into `env`:

```sh
env $(cat .dev.vars | xargs) npm <command>
```

`cat` emits `KEY=value` lines, `xargs` collapses them into a space-separated arg list, and `env` applies them to the `npm` invocation without leaking them into the parent shell. Do **not** `source .dev.vars` — the values are unquoted and would persist in the current shell.

## Web Awesome Reference

Use the `webawesome` skill for component API docs. Components auto-load via the kit script -- no cherry-pick imports needed. The kit also loads a custom "Awesome" theme variant.

### Versioning

Two version knobs exist, and they are independent:

1. **The kit** (`https://kit.webawesome.com/<token>.js`) pins `product_version` server-side -- this is what the browser actually loads. Change it in the kit settings at <https://webawesome.com/> (account dashboard); it cannot be bumped from this repo.
2. **The npm package** (`@web.awesome.me/webawesome-pro` in `package.json`) is local reference/tooling only -- nothing the page loads imports from `node_modules`. It is still tracked in git: `package.json` and `package-lock.json` are the only record of which version the bundled `webawesome` skill docs and type definitions came from, and the lockfile is what makes the install reproducible and dependency versions auditable. `node_modules/` stays ignored.

When updating, bump both and keep them in sync. Both are currently on **3.12.0**.

The generic `base` CSS part is deprecated in favor of a part named after the component itself -- `wa-button` exposes `button`, `wa-details` exposes `details`. Existing `::part(base)` selectors keep working until the next major version, but new styles should target the component's own name, as the FAB button's `::part(button)` rule in `styles.css` does. `wa-button` still emits `part="base button"`.

`label` is **not** a replacement for `base`. It is a separate, non-deprecated part on `wa-button` that wraps the default slot (`<slot part="label" class="label">`), which is what `.fab wa-button::part(label)` sizes.

To check what the kit currently serves:

```sh
curl -s "https://kit.webawesome.com/c091c003930a4b78.js" | head -c 800
```
