# equalization.rocks

A client-side audio effects chain builder with real-time Web Audio API processing. Users compose a signal chain by adding effect cards (equalization, compressor, delay) between a fixed Source input and Output speaker, then reorder or remove them.

## Tech Stack

- **Web Awesome Pro** loaded via CDN kit script -- provides all UI components (`wa-page`, `wa-card`, `wa-dropdown`, `wa-button`, `wa-icon`, `wa-slider`, `wa-file-input`, `wa-scroller`) and Font Awesome icons
- **Web Audio API** -- real-time audio processing (BiquadFilterNode, DynamicsCompressorNode, DelayNode, GainNode)
- **Vanilla JS** -- no framework, no bundler, no build step
- Static HTML/CSS/JS served directly

## File Structure

| File | Purpose |
|---|---|
| `index.html` | Page shell using `<wa-page>` with header and chain container |
| `app.js` | Chain state, render loop, add/delete/move/reset logic, Web Audio graph |
| `styles.css` | Chain layout, connector lines, EQ slider sizing, audio control styling |
| `assets/` | Favicons, app icons, web app manifest, Open Graph card, and `generate.py`, which renders the raster images |
| `robots.txt`, `sitemap.xml` | Crawler directives; must stay at the site root |
| `README.md` | Public project description and license |

## SEO and Icons

`index.html` carries the description, canonical link, Open Graph and Twitter card tags, and `WebApplication` JSON-LD. The canonical, `og:url`, `og:image`, and JSON-LD URLs are absolute to `https://equalization.rocks/`, since social crawlers reject relative image URLs. Keep the description identical across the meta tag, `og:description`, the JSON-LD, and `assets/site.webmanifest`.

`assets/favicon.svg` is the hand-placed Font Awesome Pro `message-music` duotone glyph and the single source for every other icon. `uv run assets/generate.py` reads its two paths and renders `og-image.png`, the app icons, and `favicon.ico`, using Inter fetched from Fontsource and colors from the kit's elegant palette. Commit the rendered images; nothing renders them at deploy time.

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

### Versioning

Two version knobs exist, and they are independent:

1. **The kit** (`https://kit.webawesome.com/<token>.js`) pins `product_version` server-side -- this is what the browser actually loads. Change it in the kit settings at <https://webawesome.com/> (account dashboard); it cannot be bumped from this repo.
2. **The npm package** (`@web.awesome.me/webawesome-pro` in `package.json`) is local reference/tooling only -- nothing in `index.html` or `app.js` imports from `node_modules`. It is still tracked in git: `package.json` and `package-lock.json` are the only record of which version the bundled `webawesome` skill docs and type definitions came from, and the lockfile is what makes the install reproducible and dependency versions auditable. `node_modules/` stays ignored.

When updating, bump both and keep them in sync. Both are currently on **3.12.0**.

The generic `base` CSS part is deprecated in favor of a part named after the component itself -- `wa-button` exposes `button`, `wa-details` exposes `details`. Existing `::part(base)` selectors keep working until the next major version, but new styles should target the component's own name, so the transitional `::part(base)` fallback on the FAB button has been removed from `styles.css`. `wa-button` still emits `part="base button"`.

`label` is **not** a replacement for `base`. It is a separate, non-deprecated part on `wa-button` that wraps the default slot (`<slot part="label" class="label">`), which is what `.fab wa-button::part(label)` sizes.

To check what the kit currently serves:

```sh
curl -s "https://kit.webawesome.com/c091c003930a4b78.js" | head -c 800
```
