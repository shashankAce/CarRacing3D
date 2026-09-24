# AI Workflow — read this before writing any code

This file exists because generic coding assistants — especially smaller/local
models without broad NoonEngine exposure in training — tend to **guess**
plausible-looking APIs from Cocos Creator, Unity, Phaser, PixiJS, or Three.js
instead of checking what this engine actually exposes. That guessing is the
single biggest source of broken code in this repo. The rule below fixes it:

> **Never write a call into `noonengine` from memory or "it sounds right."
> Verify it exists first, using the lookup order in Rule 1. Every single time.**

If you only follow one rule from this file, follow that one.

## Rule 0 — What this is, and what it is not

This project imports everything from the `noonengine` package. It is **not**
Cocos Creator, Unity, Phaser, or PixiJS, even though a few names look
familiar (`Scene`, `Node`, `Component`, a `res/` folder). Do not reuse those
engines' APIs, method names, config file formats, or workflows here — none of
it applies. Concretely:

| ❌ Do not assume | ✅ Reality in NoonEngine |
|---|---|
| `.prefab` / `.scene` JSON assets, a Scene editor | Scenes are plain JS/TS classes extending `Scene` — write them by hand |
| `cc.resources.load(...)` / `this.load.image(...)` | `assetCache.preloadAssets([{src, type, alias}, ...])` then `.getAsset(alias)` |
| `scene.createNode()` / `new cc.Node()` with a scene-graph API | `const node = new Node(x, y); scene.addChild(node);` |
| `node.addSprite()` / `node.getComponent('Sprite')` string lookups | `node.addComponent(Sprite)` — pass the imported **class**, not a string |
| `node.setPosition(x, y)` (two numbers) | `node.setPosition({x, y})` (one object) — or just `node.x = x; node.y = y;` |
| A `.meta` file per asset, an `assets/` Creator project | `res/` is a flat asset folder read by `AssetCache`; nothing else touches it |
| Any `import ... from 'phaser'/'cocos2d'/'pixi.js'/'three'` for engine basics | Everything 2D comes from `'noonengine'`. (Three.js is only relevant if this project used `--3d`, and even then only for the specific 3D APIs documented in `skills/3d/`.) |

### Playable-asset rule

If this project might ship through any `npm run pack:*` playable target, load
every runtime file from `res/` through `AssetCache`. Use
`assetCache.preloadAssets()` for images, audio, JSON, fonts and similar assets;
use `assetCache.loadModel()`/`loadModels()` for `.fbx` or self-contained `.glb`
models. Do **not** load a `res/` file through `THREE.TextureLoader`,
`THREE.FBXLoader`, `THREE.GLTFLoader`, raw `fetch()`, an HTML/CSS URL, or another
direct URL API: a single-file playable embeds assets as `data:` URIs and only
`AssetCache` resolves those rewritten paths at runtime.

Raw Three.js remains fine for procedural geometry, materials, shaders, render
targets, and assets generated in memory. This rule applies only to file-based
runtime assets stored in `res/`.

## Rule 1 — Ground every API in a real source, in this exact order

Before using any class, method, or property from `noonengine`, resolve it
using the **first** of these that answers your question — do not skip ahead
to guessing:

1. **`skills/<domain>/*.md`** — a topic doc, usually with a working code
   snippet. See the lookup table below. Read the whole file, not just the
   first snippet — usage caveats are often further down.
2. **The real barrel export list** — every symbol you can actually import is
   listed here. If something is not in one of these files, it does not exist
   for you to use, no matter how plausible the name sounds.

   **There are TWO barrels**, and which one a symbol lives in decides the
   specifier you import it with:
   - `'noonengine'` — everything 2D, plus `PhysicsSystem3D` and its adapters.
   - `'noonengine/3d'` — every `*3D` component (`Mesh3D`, `Camera3D`, the
     `Light3D` family, `Geometry3D`/`Material3D`, `ThreeSceneSystem`, ...) and
     the 3D physics components (`RigidBody3D`, `BoxCollider3D`, `Joint3D`, ...).
     This split is what keeps Three.js out of a 2D-only build, so importing a
     3D symbol from `'noonengine'` fails — that is the design working, not a
     bug. See `skills/3d/three-integration.md`.

   Where to read them:
   - `node_modules/noonengine/lib/index.js` and
     `node_modules/noonengine/lib/3d/index.js` (or the matching
     `types/index.d.ts` / `types/3d/index.d.ts`) — normal scaffold. Note
     `lib/`: there is no root `index.js` in the package.
   - `engine/lib/index.js` and `engine/lib/3d/index.js` (or
     `engine/types/index.d.ts` / `engine/types/3d/index.d.ts`) — instead of
     `node_modules/`, only if this project was scaffolded with `--vendor`
     (check: does an `engine/` folder exist at the project root?).
3. **Exact method/property signatures — check the `.d.ts` FIRST, not the
   implementation.** The generated declarations are the fastest and least
   ambiguous answer: one line per member, real types, and the JSDoc contract
   preserved above it, with no implementation body in the way.
   ```
   grep -rn "methodName" engine/types/                  # --vendor project
   grep -rn "methodName" node_modules/noonengine/types/ # normal scaffold
   ```
   They mirror `lib/`'s folder layout, so a class's declarations live at the
   matching path — e.g. `engine/types/components/rendering/Sprite.d.ts`, and the
   3D ones under `engine/types/3d/` (`engine/types/3d/Mesh3D.d.ts`,
   `engine/types/3d/Light3D.d.ts`, ...). A recursive grep from `engine/types/`
   already covers both. You do **not** need TypeScript installed to read them;
   they're plain text, and they are equally valid for a plain-JS project.

   Note these declarations are a *reading* reference only — nothing compiles
   against them. `tsconfig.json`/`jsconfig.json` map `noonengine` and
   `noonengine/3d` straight to `engine/lib/*.js`, whose JSDoc is the real type
   source, so an out-of-date `types/` never breaks a build; it just makes this
   lookup wrong. Re-sync with `npx /path/to/NoonEngine update`.

   Only fall back to grepping the implementation (`engine/lib/`,
   `node_modules/noonengine/lib/`) if the declarations don't answer it — or if
   `types/` is missing, which means the engine copy predates it being vendored
   (`npx /path/to/NoonEngine update` regenerates and re-syncs it).

   Either way, confirm the parameter shape (object vs. positional args,
   required vs. optional) from what you actually find — do not assume it
   matches another engine's convention for a similarly-named method (see the
   `setPosition` row above).
4. **Existing code in `src/`** — only after 1–3 don't resolve it, check
   whether this project already uses the API elsewhere and copy that exact
   pattern.

If none of the four resolve your question, say so explicitly and ask,
instead of writing a best-guess call.

## Rule 2 — Skill doc lookup table

Map what you're trying to build to the doc to read **first**:

| I want to... | Read this |
|---|---|
| Create/structure a scene | `skills/scenes/creating-a-scene.md` |
| Camera(s), viewport/split-screen, layer visibility filtering | `skills/scenes/camera-and-layers.md` |
| Handle clicks/taps/drag/touch/keyboard input | `skills/input/input.md` |
| Show an image / textured quad | `skills/rendering/sprite.md` |
| Play a sprite-sheet animation | `skills/rendering/sprite-animation.md` |
| Draw shapes/lines (not an image) | `skills/rendering/graphics.md` |
| Draw a rectangle/color fill | `skills/rendering/color-rect.md` |
| Show text (regular font) | `skills/rendering/label.md` |
| Show text with mixed styles/tags | `skills/rendering/richtext.md` |
| Show text with a bitmap font | `skills/rendering/bitmaptext.md` |
| Clip/mask content to a region | `skills/rendering/mask.md` |
| A scratch-to-reveal effect | `skills/rendering/scratchcard.md` |
| Particle effects (bursts, continuous emission, static particle fields) | `skills/rendering/particles.md` |
| Load/manage images, atlases, fonts | `skills/assets/asset-cache.md` |
| Load assets in stages (splash first, gameplay after) / per level / per screen | `skills/assets/batch-loader.md` |
| Use a texture atlas / sprite sheet | `skills/assets/sprite-atlas.md` |
| Use a bitmap (BMFont) font asset | `skills/assets/bitmap-font.md` |
| Play a sound effect or background music (2D) | `skills/audio/audio.md` |
| Auto-layout children (rows/columns/etc.) | `skills/layout/layout.md` |
| Anchor/stretch UI to screen edges | `skills/layout/widget.md` |
| A button | `skills/ui/button.md` |
| A checkbox | `skills/ui/checkbox.md` |
| A text input field | `skills/ui/editbox.md` |
| A swipeable page view | `skills/ui/pageview.md` |
| A progress bar | `skills/ui/progressbar.md` |
| A slider | `skills/ui/slider.md` or `skills/ui/rangeslider.md` (min+max) |
| A scrollbar | `skills/ui/scrollbar.md` |
| A scrollable list/view | `skills/ui/scrollview.md` |
| Tween/animate a value over time | `skills/animation/tween.md` |
| Easing curves for a tween | `skills/animation/easing.md` |
| General animation concepts | `skills/animation/animation.md` |
| Materials/shaders/tinting | `skills/material/material.md`, `skills/material/material-library.md`, `skills/material/shader-library.md` |
| Writing a custom GLSL/WGSL shader | `skills/material/custom-shaders.md` |
| Post-processing / bloom / exposure / depth of field | `skills/material/post-processing.md` |
| 2D physics — rigid bodies, colliders, joints (only if scaffolded with `--physics`) | `skills/physics/physics2d.md` |
| 3D physics — rigid bodies, colliders, joints (only if scaffolded with `--3d --physics3d`) | `skills/physics/physics3d.md` |
| 3D content — setup/injection (only if scaffolded with `--3d`) | `skills/3d/three-integration.md` |
| 3D meshes, geometry, groups, LOD (only if scaffolded with `--3d`) | `skills/3d/mesh-and-geometry.md` |
| 3D cameras & lights (only if scaffolded with `--3d`) | `skills/3d/lights-and-camera.md` |
| Skinned/instanced/batched meshes, lines, points, billboards (only if scaffolded with `--3d`) | `skills/3d/advanced-meshes.md` |
| 3D positional audio (only if scaffolded with `--3d`) | `skills/3d/audio3d.md` |
| Delay/repeat a callback, custom events, resize/pause signals, screen↔game coords | `skills/core/timers-and-events.md` |
| Frame-rate work — pooling spawned nodes, warming textures/text before a transition | `skills/core/performance.md` |
| Vector/rect math, color parsing | `skills/core/math-and-color.md` |
| Debug overlay, FPS/draw-call stats, on-screen console log | `skills/debug/debug-tools.md` |
| Build/bundle-size concerns | `skills/build/build-and-check-size.md` |
| Ship to Facebook Instant Games / Telegram / YouTube Playables (loading progress, ready signal, saves, scores) | `skills/build/platform-targets.md` |

If a topic isn't in this table, search `skills/` for it before guessing:
```
grep -rl "keyword" skills/
```

## Rule 2b — Whole-task recipes (when one row isn't enough)

The table above is one row per feature. Real requests usually span several, and
the failure mode is picking the single nearest row and stopping — you end up
hand-rolling something the engine already has. If the request looks like one of
these, read **all** the linked docs before writing code.

### "Replicate this design / mockup / exported HTML page"

Do not translate CSS to absolute-positioned nodes one box at a time. Map the
design's *intent* onto the engine's own primitives first:

| What the design does | Use |
|---|---|
| flex row/column, grid, evenly-spaced items | `Layout` — `skills/layout/layout.md` |
| pinned to an edge/corner, stretches with the screen | `Widget` anchors — `skills/layout/widget.md` |
| a panel/button background that scales without distorting its corners | `Sprite` with `SpriteType.SLICED` (set `borderLeft/Right/Top/Bottom`) — `skills/rendering/sprite.md` |
| a repeating/patterned background | `SpriteType.TILED`, same doc |
| a bar that fills or empties | `SpriteType.FILLED` + `fillType`/`fillRange`, or `skills/ui/progressbar.md` |
| clipped/rounded content region, `overflow: hidden` | `Mask` — `skills/rendering/mask.md` |
| a scrolling list or pane | `skills/ui/scrollview.md` (+ `skills/ui/scrollbar.md`) |
| solid colour block | `ColorRect` — `skills/rendering/color-rect.md` |
| gradients, strokes, custom shapes | `Graphics` — `skills/rendering/graphics.md` |
| mixed inline styles in one text block | `RichText` — `skills/rendering/richtext.md` |
| plain text | `Label` — `skills/rendering/label.md` (or `bitmaptext.md` for a bitmap font) |
| a tappable element | `skills/ui/button.md`, not a raw click listener, when it needs states |

Two rules that save the most rework: build the hierarchy with `Layout`/`Widget`
rather than hard-coded coordinates, so it survives a resolution change; and use
`SpriteType.SLICED` for every rounded-rect panel instead of exporting one image
per size.

### "Add a loading stage / splash screen / progress bar"

Not one feature — four, and `assetCache.preloadAssets()` alone is the wrong
answer for anything past a single flat list:

1. `skills/assets/batch-loader.md` — `BatchLoader.preload(key, list, onProgress)`
   groups assets by stage and de-duplicates concurrent requests. This is the
   piece most often missed.
2. `skills/ui/progressbar.md` (or a `FILLED` sprite) for the bar itself.
3. `skills/scenes/creating-a-scene.md` for the scene swap once a stage resolves.
4. `skills/build/platform-targets.md` if this ships to a host — the host has its
   own loading bar, driven by `platform.reportProgress(p)`.

### "Spawn a lot of things" (bullets, crops, coins, particles)

`skills/core/performance.md` for `NodePool` first — then
`skills/rendering/particles.md` if it's a visual effect rather than gameplay
objects, and `skills/rendering/sprite-animation.md` if each one animates.

## Rule 3 — Verify by running the project, not by inspection alone

There is **no unit test runner** in this project. The only way to confirm a
change actually works is:
```
npm install     # first time only
npm run dev     # starts Vite, prints a localhost URL
```
Open that URL in a browser and check:
- The game renders what you expect.
- The browser console has no errors (a red error almost always means a wrong
  API call — go back to Rule 1, don't patch around it blindly).

`npm run build` produces a production bundle (trimmed by default); it is not
a substitute for actually running `npm run dev` and looking at the result.

## Rule 4 — Project layout (where things go)

- `src/index.js` (or `.ts`) — entry point; constructs `GameEngine`, defines
  the root `Scene`, calls `engine.start()`.
- `src/` — the rest of your game code (scenes, components, logic) — no fixed
  structure is imposed beyond that; follow whatever organization the project
  already has going, don't invent a new one mid-task.
- `res/` — flat asset folder (images, bitmap fonts, etc.), read via
  `AssetCache` — never referenced by a literal path outside a `preloadAssets`
  entry or an already-established alias.
- `skills/` — the reference docs from Rule 1/2. Read-only reference; don't
  edit these.
- `engine/` — only exists if scaffolded with `--vendor`; the vendored engine
  source itself (see Rule 1.2).

## Rule 5 — When you're not sure, stop and say so

If Rules 1–4 don't resolve a question (the API genuinely isn't documented or
exported anywhere you can find), don't fill the gap with a guess from another
engine. State plainly what you checked and what's still unclear, and ask —
a wrong guess that compiles silently is far more expensive to debug later
than a question now.
