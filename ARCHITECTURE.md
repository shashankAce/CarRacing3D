# CarRacing3D — Architecture, Constraints & Plan

> **Read this before touching code.** It records what was verified by reading
> the engine source, the `skills/` docs, and the `Procedural_3D_world` project,
> so no agent has to re-derive any of it. Read order:
> [CLAUDE.md](CLAUDE.md) → [AI_WORKFLOW.md](AI_WORKFLOW.md) → this file.
>
> Everything below marked **[verified]** was read out of real source in this
> repo (paths given). Anything marked **[estimate]** is arithmetic that still
> needs measuring on a device.

## 1. What we're building

A **portrait, top-down/TPP 3D infinite car racer** shipped as a **playable ad
creative**, used as a **reskinnable B2B template**.

- Player car drives forward forever; left/right controls steer across the road.
- Traffic vehicles spawn ahead and are dodged ("cut traffic as long as you can").
- Speed ramps from a start value up to a capped maximum over time.
- The 3D environment (terrain, trees, rocks) is **generated procedurally at
  runtime from a seed** — no mesh/texture assets — because the size budget is 2MB.
- Cars are **colored boxes for now**; FBX/GLB models get swapped in later
  without touching game logic.
- Renderer: **WebGL only**.

Non-goals: matching `Procedural_3D_world`'s visual fidelity, rivers, water,
grass, cliffs, multiplayer, real physics.

## 2. Hard constraints (verified, with sources)

### 2.1 The 2MB budget is RAW bytes in ONE html file
`engine/lib/platform/platforms/meta-playables/pack.config.js` **[verified]**:

```js
outputFormat: 'single-html',
allowedFileTypes: ['html'],
inlineAssets: 'disallowed',
budgets: { totalMB: 2, maxFileCount: 1 },
```

Consequences that shape every decision below:

- The cap is measured **on the unpacked single HTML file — uncompressed.**
  Unlike Google's zip budget there is no gzip to hide behind, and any binary
  asset is base64'd at **1.33×** its real size. So "gzipped size" is the wrong
  metric here; count minified raw bytes.
- **No network requests at all** are permitted, and a playable cannot lazy-load:
  the target forces `rollupOptions.output.inlineDynamicImports: true` and
  `assetsInlineLimit: 1GB`. Any `import()` you add gets folded into the one
  chunk anyway — it never saves bytes, it only hides them.
- Related caps if the target changes: `google-playables` 5MB **compressed zip**,
  `applovin-playables` / `unity-playables` 5MB raw single file (4MB via
  ironSource Exchange), `standalone` no cap. Meta's 2MB is the tightest — build
  against it and every other target is free.

### 2.2 The byte floor is comfortable — measured against a real reference
- `three/build/three.module.min.js` = **357KB raw** (the whole library; we
  tree-shake well below that) **[verified]**
- `Procedural_3D_world/dist` — three.js **plus** terrain + river + water shaders
  + trees + grass + rocks, production build = **640KB minified JS + 15KB HTML
  ≈ 655KB raw** **[verified]**

That is an entire procedural world in ~1/3 of our budget.

**Measured on this project (Phase 1, 2026-08-25)** — `npm run pack:meta-playables`
on a scene with a camera, two lights, fog, a ground plane, a road strip and a
box car:

```
build-meta-playables.html   917.9 KB / 2 MB limit   (1 file / 1 limit)
```

The floor is **~918KB, leaving ~1.08MB of headroom** before any content exists.
Cross-checked against the reference above: all of P3W's *non*-three.js code —
terrain, river, water shaders, trees, grass, rocks — is only ~100KB of the 655KB
it ships, so Phase 5's port should cost well under 100KB.

**Size is not the binding constraint on this project — runtime performance is.**
Do not spend time on byte-golfing before there is something to measure.

`skills/build/build-and-check-size.md` notes real Three.js usage costs
~130-150KB **gzipped** and that this is not reducible by import tricks — don't
re-litigate that.

### 2.3 Do NOT use Rapier for physics
`@dimforge/rapier3d/rapier_wasm3d_bg.wasm` = **1.5MB raw** **[verified]** →
base64 in a single HTML ≈ **2MB**, i.e. the entire budget for the physics
engine alone. It is disqualified.

Two sanctioned alternatives:
- **`AABBAdapter`** (`engine/lib/physics3d/adapters/AABBAdapter.js`) — engine-
  native, **zero dependency, no WASM**, same adapter surface as Rapier, so
  `RigidBody3D`/`BoxCollider3D` work unchanged. Linear motion only, every shape
  approximated by its bounding box, no joints. Enable with
  `{ enablePhysics3D: true, physics3D: AABBAdapter }` — no async init.
- **Hand-rolled overlap test** — recommended, see §5.5.

### 2.4 Runtime knobs that exist in engine config
From `engine/types/core/CoreTypes.d.ts` **[verified]** — use these instead of
touching the renderer:
- `pixelRatio: number` — `0` = use `devicePixelRatio`, `>0` **caps** it. Set
  this to `2` (or lower) — uncapped DPR on a modern phone is the single
  biggest fill-rate mistake available to us.
- `resolutionScale: number` — framebuffer density multiplier, `<1` downsamples.
  The cheap dial to pull if we're fill-rate bound.
- `pauseOnHide` / `pauseOnBlur`, `showStats` (FPS overlay — keep on in dev).

## 3. NoonEngine 3D — the facts that will bite you

Source: `skills/3d/three-integration.md`, `skills/scenes/creating-a-scene.md`,
`engine/types/3d/*.d.ts` **[all verified]**.

1. **3D renders before the 2D pass.** `ThreeSceneSystem.render()` is called
   once per frame by `WebGLBatchRenderer` *before* 2D. So the whole NoonEngine
   2D node tree is automatically a HUD layer on top of the 3D scene, in the
   same `Scene`, via the same `addChild`. No compositing work needed.
2. **Build everything in `onLoad()`, never the constructor.** `runScene()`
   sizes the root node and runs `_initThree()` *before* `onLoad()`. A node added
   in the constructor enters the tree before `threeSceneSystem` exists, and any
   3D wrapper's `onEnable()` **silently no-ops** — no error, just nothing renders.
3. **`addChild()` before setting transforms.** `onEnable()` is what lazily
   creates the underlying THREE object; `cam.position.set(...)` before
   `addChild` is a no-op against a null camera.
4. **`InstancedMesh3D.count` is a rebuild, not a counter.**
   `engine/types/3d/InstancedMesh3D.d.ts`: *"Changing `count` after creation
   rebuilds the underlying THREE.InstancedMesh — all instance matrices set
   beforehand are lost."* **Never set the wrapper's `count` per frame.**
   Allocate max count once at build time, then vary the visible number with
   `instanced.object3D.count = n` (the raw THREE property, free) and
   `object3D.instanceMatrix.needsUpdate = true`. This is exactly what
   `Procedural_3D_world/src/scatter/lodBuckets.js` does.
5. **Set `frustumCulled = false` on any InstancedMesh whose instances are
   spread far from the geometry's local origin.** Otherwise the batch gets
   silently culled out of the *shadow* pass (still visible in the main view,
   casting no shadow) — see the comment in `lodBuckets.js`.
6. **3D wrappers do NOT follow the Node hierarchy.** Every wrapper's
   `object3D` is added to the THREE **scene root** via `sys.addObject()`
   (`engine/lib/3d/Mesh3D.js:114`) — parenting a Node under another Node does
   *not* parent their 3D objects. Grouping is explicit: add a `Group3D` and
   call `group.object3D.add(childMesh)`. This is why the player car is a
   `Group3D` holding plain meshes rather than a Node tree.
7. **Wrapper vs raw THREE:** static, never-toggled geometry → plain
   `THREE.Mesh` + `sys.scene.add(mesh)`. Anything created/destroyed/toggled at
   runtime → the `*3D` wrapper component, because the wrapper's whole purpose
   is add/remove/dispose on the Node lifecycle. A raw object you add yourself
   is a leak you own.
8. **Every wrapper mirrors only 2-4 properties**; everything else goes through
   `.object3D` / `.light` / `.threeCamera`. A missing property is by design,
   not a gap.
9. `sys.onRendererReady = (renderer) => {...}` is the correct place for shadow
   map / tone mapping config (the renderer is created lazily on frame 1).
10. `sys.worldToDesign(worldPos)` converts a 3D world position to 2D design
   coords — use it if a HUD element must track a 3D object.
11. **Input** (`skills/input/input.md`): `Input.KEY_DOWN`/`KEY_UP` are **not**
    spatial and will *never* fire from `node.on(...)`. Keyboard goes through the
    `inputListener` singleton (`inputListener.isKeyDown('ArrowLeft')` to poll).
    On-screen controls use `node.on(Input.POINTER_DOWN/UP, ...)` which
    auto-attaches an `Interactive` component.
12. `assetCache.loadModel()` exists for FBX/GLB and **returns a fresh clone
    every call, including cache hits** — a model scene can only have one
    parent. Relevant for the later model swap; irrelevant now.
13. **Node positions are Y-UP** — a node's `y` is measured from the BOTTOM of
    the design space, so `new Node(x, 1180)` on a 1280-tall design sits near the
    TOP. Verified from a render, after getting it backwards from a doc comment:
    `engine/lib/core/Display.js:407` does say "top-left origin, Y-down", but that
    describes `screenToDesignInto`, the screen→design step of POINTER conversion
    — a different space from node placement (pointer events then pass through
    `camera.screenToWorld`, which lands back in Y-up world coords). Don't infer
    the node convention from the input convention.
    And because the policy is `FIXED_HEIGHT`, the design **width** varies with
    the device's aspect ratio: `cfg.design.width` is the design-time value, not
    a runtime truth. Read `inputListener.engine.display.designWidth` for the
    live value (that's how the touch left/right split is decided), and
    centre-anchor HUD elements — anything pinned near a left/right edge needs
    the Widget system, which auto-trim currently strips out.
14. A global pointer listener is `inputListener.on(type, cb, null, context)` —
    the third arg is the **target node** (null = fires on every event, no
    hit-test), the fourth is the callback's `this`. `off(type, cb, target)`
    takes no context and matches on callback reference.

## 4. Procedural_3D_world — exactly what to take

Path: `/Users/schaurasiya/ShashankWorkspace/Procedural_3D_world`.
Read its `ARCHITECTURE.md` / `PROGRESS.md` only if the notes below aren't enough.

**The single most important property of that codebase, and the reason it ports
cleanly to an infinite runner:** `heightAt(x, z, p)` and `normalAt(x, z, p)`
are **pure functions of absolute world position** — normals come from an
analytic central-difference gradient of the height field, never from mesh
topology. Quoting `src/terrain/heightField.js`:

> *"this is what keeps lighting seamless across chunk boundaries, since it only
> ever depends on world position, never on which chunk's vertices happen to be
> nearby."*

So a chunk can be built, destroyed, and rebuilt at any grid coordinate in any
order and it always stitches perfectly to its neighbours. That is precisely
what chunk recycling needs.

### 4.1 Port table

| Source (in P3W) | LOC | Verdict |
|---|---|---|
| `src/utils/noise.js` | 984 | **Take.** We need `mulberry32`, `buildPermutation`, `simplex2D`, `fbm2D` (+`ridgedFbm2D` for mountains). Named ESM exports → the 3D/worley half tree-shakes away. |
| `src/utils/math.js` | 4 | **Take** (`smoothstep`). |
| `src/terrain/ambientHeight.js` | 85 | **Take as-is** — pure noise (rolling hills + ridged mountain mask). |
| `src/terrain/chunkMesh.js` | 99 | **Take, near-verbatim.** Highest-value file. Builds a chunk in *local* coords with `mesh.position` offset, bakes per-vertex color, and adds a **downward skirt** off every perimeter vertex to hide LOD cracks between chunks at different resolutions — no cross-chunk coordination needed. |
| `src/terrain/terrainColor.js` | 94 | **Take, retune.** Height/slope→color bands baked into a vertex-color attribute. **This is the primary reskin hook** — palette swap = whole new biome, zero geometry change. |
| `src/terrain/heightField.js` | 82 | **Take the structure, rewrite the carve.** It hard-depends on `river/riverPath.js` (`riverPathX`, `riverElevation`). Replace the river channel with a **road corridor**: flat at road level within `roadHalfWidth`, `smoothstep` blend up to ambient over a shoulder width. Structurally identical, and it inherits the same guarantee that ground can never poke through the road surface. |
| `src/terrain/params.js` | 42 | **Rewrite.** `worldZRange()` assumes a finite `chunksPerSide` world — meaningless for infinite. |
| `src/terrain/terrainSystem.js` | 100 | **Take the shape, rewrite the loop.** Its `regenerate()` builds a fixed `chunksPerSide` grid; we need a rolling window. Its `updateLod()` throttling pattern (200ms + 4-unit camera-move threshold before re-tiering) is worth keeping verbatim. |
| `src/scatter/scatter.js` | 131 | **Take the rejection rules, rewrite the domain.** Slope / height / density-mask rejection and jittered-grid sampling are all good. But candidates are sampled over `worldZRange` (finite) — must become **per-chunk, seeded from chunk coords**, so a chunk regenerates identically when revisited. Add a **road-corridor rejection** (nothing within `roadHalfWidth + margin`). |
| `src/scatter/lodBuckets.js` | 91 | **Take as reference.** Two InstancedMeshes (near/far geometry) per variant, repartitioned by camera distance without rebuilding anything. May be simpler per-chunk for us — decide when we get there. |
| `src/vegetation/tree.js` + `treeSkeleton.js` + `treeTubeMesh.js` + `treeFoliageMesh.js` + `treeTextureAtlas.js` | 944 | **Take, but budget it.** Biggest and most expensive piece. Real branch skeleton → tube mesh → foliage sprays, with a procedurally painted texture atlas. `ringDetail: 0.4` is the built-in cheap tier. See §6 open decision D3. |
| `src/rocks/boulder.js` + `rockField.js` + `rockTextures.js` | 406 | **Take.** Noise-displaced icosphere + vertex-color AO/strata + procedural texture. Cheap and good. |
| `src/river/*`, `src/sky/volumetricFog.js`, `grass*.js`, `bush*.js`, `cliffOutcrop*.js`, `riverBank*.js` | ~1400 | **Skip.** Out of scope. |
| `src/sky/skyDome.js` | — | **Evaluate.** A cheap gradient dome is worth it if it's shader-only. |
| every `*LabMain.js`, `src/core/viewport.js` | ~600 | **Skip.** Lab harnesses; NoonEngine owns the renderer/camera bootstrap. |

### 4.2 Two bugs-in-waiting to fix while porting

Both are fine in a desktop dev app and will hurt on a phone at 60fps:

1. **`normalAt()` allocates a `new THREE.Vector3()` per call**
   (`heightField.js:76`). It's called once per terrain vertex *and* once per
   scatter candidate → thousands of allocations per chunk build → GC sawtooth.
   Rewrite to write into a caller-supplied scratch vector.
2. **`placementsToMatrices()` allocates a `Matrix4` and a `Vector3` per
   placement** (`scatter.js`, `.clone()` at the end). Same problem. Write
   directly into the InstancedMesh's matrix buffer instead of building an array.

## 5. Design decisions for the infinite run

### 5.1 The world scrolls; the car stays near the origin
The car's transform stays at small coordinates forever. We keep a single
`travelled` scalar (metres since start). Every world object is placed at
`z_render = z_world - travelled`.

- Terrain/scatter sample noise at **absolute** `z_world` (so the landscape never
  repeats), but every mesh's actual `position.z` stays within a small window
  around the camera.
- No floating-origin rebase step, no precision drift in the render transforms,
  no growing chunk indices in the transform path. `z_world` only ever feeds
  `Math`/noise in float64, which is exact far past any session length.
- `travelled` doubles as the score/distance readout.

This is the "approach which could enable infinite game run" the brief asks for.

### 5.2 Road as a function, not a mesh
`roadCenterX(z)` — a pure function, exactly mirroring P3W's `riverPathX(z)`.
Ship it returning `0` (dead-straight road, correct for a lane-dodging playable),
but because it's a function, a gently curving road later is a **config change,
not a rewrite**. The height field, the scatter rejection, traffic lane
positions, and the road strip mesh all consume the same function, so they can
never disagree.

The road surface itself is a long strip mesh built the same way as a terrain
chunk (recycled in bands), or a small number of quads if the road stays
straight. Lane markings: vertex colors or a procedurally drawn canvas texture —
never an image file.

### 5.3 Chunk recycling budget — the real perf risk
`chunkMesh.buildChunkGeometry` at P3W's default `resolution: 33` costs, per
chunk **[estimate]**:

- 33×33 = 1089 grid verts + ~128 skirt verts
- per vertex: 1 `heightAt` + 4 more inside `normalAt` + `terrainColorAt`
- ⇒ ~5,500 `heightAt` calls, each running a 4-octave fbm plus the ridged
  mountain mask ⇒ **~50,000 simplex evaluations per chunk**

That is very likely a **multi-millisecond frame spike every time a chunk
recycles** — the exact thing that makes an infinite runner feel bad. Mitigations,
in the order to apply them:

1. **Build at most one chunk per frame** (a work queue), never a batch.
2. **Lower `resolution`.** A top-down camera sees far less terrain relief than
   P3W's valley flythrough. Start at 17 and only raise it if it reads as flat.
3. Fix the allocation churn from §4.2.
4. Cache a row of heights so `normalAt`'s ±x samples reuse neighbours.
5. ~~Keep P3W's LOD tiers~~ — **this does not reduce build cost in a forward
   scroller, and the original claim here was wrong.** Chunks spawn at the FAR
   edge and approach the player, so a tiered chunk is re-tessellated on the way
   in: far + mid + near ≈ 1.37× the cost of one full-resolution build. LOD helps
   triangles and GPU fill, not CPU. (It also conflicts with grid normals — see
   the caveat in `chunkMesh.ts`.)

Only measure-then-fix. `showStats: true` plus a `performance.now()` timer around
the chunk build is the whole instrumentation needed.

### 5.4 Traffic: pooled nodes, not instancing
Traffic count is small (~20-30 alive). **Use a pre-allocated pool of `Mesh3D`
nodes** sharing one `BoxGeometry` and a handful of materials — not an
InstancedMesh. Reasons: it's already one draw call per material at this count,
per-object logic stays readable, and **swapping in an FBX/GLB later is a
one-line `object3D` assignment** instead of an instancing redesign. Never
create/destroy at runtime; recycle from the pool.

### 5.5 Collision: hand-rolled, in 2D
Everything is axis-aligned, one player, ~30 obstacles, and gameplay is on the
XZ plane. A `for` loop over the active pool doing an interval-overlap test on
(x, z) is ~10 lines, deterministic, and frame-exact.

Prefer that over `AABBAdapter`. Switch to `AABBAdapter` only if we later want
engine-managed colliders, raycasts, or gravity — it's the sanctioned zero-weight
path and swaps to Rapier in one line, but for "did the box clip that box" it's
indirection with no payoff.

### 5.6 Camera
TPP follow, behind and above the car. Smooth with **exponential damping**, not a
fixed lerp factor:

```js
const k = 1 - Math.exp(-followRate * dt);   // frame-rate independent
cam.position.lerp(target, k);
```

A plain `lerp(a, b, 0.1)` per frame is framerate-dependent and will feel
different on a 120Hz phone than in the dev browser. Look-at target leads the car
slightly so the player sees oncoming traffic sooner as speed rises.

### 5.7 Controls
Hold-to-steer, both input paths always live:
- Keyboard: poll `inputListener.isKeyDown('ArrowLeft'/'ArrowRight')`.
- Touch: two `Input.POINTER_DOWN`/`POINTER_UP` regions (or screen halves) — plus
  a drag-to-steer path, which tests better on mobile playables.

Steering integrates a lateral velocity with clamping to the road edges, plus a
small visual roll/yaw on the car body for feel. Not instant lane snapping unless
D2 (§6) says otherwise.

### 5.7a The mistake that recurred three times: frequency vs. visible distance

Every procedural field in this game is sampled over a *bounded* view — roughly
150-280m of visible ground. A sine or noise term whose **wavelength (2π/frequency)
exceeds that distance cannot be perceived as shape**; you see a fraction of one
wave, which reads as a flat tilt. This was got wrong three separate times:

| what | first frequency | wavelength | vs. visible | symptom |
|---|---|---|---|---|
| terrain hills | 0.016 | 393m | ~150m | "a plane with a tint" |
| road curve | 0.004 | 1571m | ~200m | "the road is still straight" |
| road elevation | 0.008 | 785m | ~200m | 1.7m of rise — invisible |

**Before committing any frequency, compute `2π/f` and compare it to
`terrain.chunkSize * terrain.chunksAhead`.** Aim for a wavelength of roughly a
third to a half of that, and check the resulting amplitude *across* the visible
span, not in the abstract.

The same trap has a second face: a single low-frequency octave has slope
`amplitude × frequency`, which for hills big enough to see is far too gentle to
ever trigger a slope-based colour band. That's why `ambientHeightAt` is
multi-octave — the small high-frequency octave is what creates slope, and
therefore what makes terrain read as ground rather than as a tinted surface.

### 5.7b Two mesh layers, one surface: the traps

Terrain and road are separate meshes covering overlapping ground, which creates
two failure modes that both showed up in play:

1. **The road ribbon sits `roadSurface.lift` (2cm) above the terrain corridor**,
   to stop the two z-fighting. So anything positioned with `heightAt` sits 2cm
   *inside* the visible road — a constant sink that reads from a chase camera as
   the body's underside cutting into the asphalt. Anything that drives must use
   **`surfaceHeightAt`** (top of asphalt inside the corridor, terrain outside),
   never `heightAt`.
2. **The flattened corridor must be wider than the asphalt** by more than one
   terrain vertex spacing. Terrain is a triangle mesh on a `chunkSize /
   (resolution-1)` grid; if the shoulder starts rising exactly at
   `road.halfWidth`, a triangle can have one vertex inside the corridor and the
   next already lifted, and linear interpolation carries the ground **up to 84cm
   above the asphalt**, swallowing the road edge in a staircase. `FLAT_MARGIN` in
   `heightField.ts` handles this, derived from the grid rather than hardcoded.

### 5.8 Fog is a feature, not decoration
An exponential fog matched to the sky/background color lets the far plane and
the chunk spawn boundary sit close in without a visible pop-in edge. It's the
cheapest way to buy back a shorter draw distance. `sys.scene.fog = new
THREE.FogExp2(...)` — no wrapper needed (per `skills/3d/three-integration.md`).

**`world.fogDensity` and `terrain.chunksAhead` are one decision, not two.**
FogExp2 hides `1 - exp(-(density·dist)²)` of a surface's colour, and the two
settings pull opposite ways:

- Fog must be **thick at the spawn edge** (≥~98% hidden) or chunks visibly pop
  into view as you drive.
- Fog must be **thin nearer in** (≤~30% at 80m) or every terrain colour washes
  to sky and the world looks pale and flat.

Both halves were got wrong in turn: density 0.010 with a 200m edge hid the
boundary but washed out 76% of the colour at 120m (and made the rock band look
like it wasn't being generated at all); dropping to 0.007 fixed the colour but
left 14% showing at a 160m edge, which is plainly visible pop-in. The pair that
satisfies both is **0.007 with a 280m edge** (`chunksAhead: 7`). Change either
and re-derive the other.

Pushing the draw edge out does **not** raise the chunk build rate — that's
`speed / chunkSize`, about 10 chunks/second at top speed, independent of how far
ahead they sit. It costs resident memory and triangles only (54 chunks ≈ 41k
triangles, 0.8MB of typed arrays), and the lateral column count has to grow with
it: portrait's horizontal FOV is only ~42°, so the view is ±106m wide at 280m.

### 5.9 Shadows: default OFF
Real-time shadow maps are the most expensive thing we could switch on for the
least gameplay value at this camera angle. Ship with a **fake blob shadow**
(a dark, soft, unlit quad parented under each car). Keep the shadow-map path
behind a config flag for the "high-end reskin" case.

## 6. Decisions

All four were confirmed by the project owner on 2026-08-25 — these are settled,
not assumptions to revisit.

| # | Decision | Settled as |
|---|---|---|
| D1 | Which ad target is the 2MB from? | **`meta-playables`** — 2MB raw single HTML, no network requests. Everything here is built to its rules, which satisfies every other network too. |
| D2 | Discrete lane snapping vs free lateral steering? | **Free lateral steering** with clamping to the road edges, plus a visual roll on the car. Traffic still spawns on lane centres. |
| D3 | How rich are the trees? | **Port, then measure.** Start with P3W's generator at its cheap `ringDetail: 0.4` tier and a **3-variant** pool, and measure both boot-time generation cost and frame cost. If either is material, fall back to a simple cone/sphere tree — at this camera distance the full skeleton may be invisible detail we're paying full price for. |
| D4 | Portrait 720×1280? | **Yes** — matches the existing scaffold and `pack:google-playables --orientation=portrait`. |
| D5 | Does the car follow a curving road on its own? | **No.** Settled 2026-08-25 after trying both. The car's lateral position is ABSOLUTE and only steering moves it; the clamp to the asphalt is what tracks the curve. So holding a bend takes input, and reaching an edge is a collision that shoves the car along it. Storing the car's position as an offset from the road centre was tried and rejected — it carried the car through bends with no input, making the curve decoration. |
| D6 | Can the car leave the road? | **No** — it clamps at the asphalt edge. But it rides `surfaceHeightAt` and has real suspension, so the code already behaves correctly if that ever changes. |

## 7. Implementation plan

**These numbers match the git history** — one commit per phase, message prefixed
`Phase N complete`. Keep them aligned; if a phase gets split or reordered,
renumber here and in the code comments that reference a phase, in the same pass.

Each phase ends in something runnable in the browser (`npm run dev`, port 8000)
— there is no test runner in this project, so "verify by running it" is the only
verification that exists.

**Phase 1 — 3D boot + size floor.**
`enable3D`/`three` in the engine config, `pixelRatio: 2`, a `MainScene` with
`Camera3D` + lights + a flat ground plane + a colored box car. Then **immediately
run `npm run pack:meta-playables`** and record the byte count in this file. This
establishes the real floor before any content exists, so every later phase can be
attributed. *Do not skip this — it's the cheapest size information we will ever get.*

**Phase 2 — the core loop feels right.**
Input (keyboard + touch), lateral steering with clamping, TPP follow camera with
exponential damping, speed ramp to a cap, `travelled` counter, 2D HUD showing
speed/distance. Ground can still be a single flat plane. **This phase decides
whether the game is fun**; nothing after it is worth doing if the steering and
camera don't feel good.

**Phase 3 — infinite scroll.**
`roadCenterX(z)`, the road strip mesh, recycled terrain chunks (flat-colored, no
scatter yet), the one-chunk-per-frame build queue, fog. Verify: drive for several
minutes with no hitching, no seams, no drift.

**Phase 4 — traffic and the game loop.**
Pooled traffic boxes, lane spawn logic scaled by speed, hand-rolled collision,
crash → game over → restart, near-miss scoring.

**Phase 5 — the procedural environment.**
Port `noise` → `ambientHeight` → the road-carving `heightField` → `terrainColor`
→ `chunkMesh`. Then per-chunk scatter with road rejection, then rocks, then
trees, then LOD. Fix the §4.2 allocation churn as part of the port, not after.

**Phase 6 — playable polish.**
CTA button gated on `platform.isAdCreative`, `platform.triggerCTA(storeUrl)`
(never `window.open`), `platform.notifyReady()` moved to when the game is
genuinely playable, `platform.isAudioEnabled()` (a hard YouTube cert rule),
tutorial hand/arrow prompt, restart, juice (speed lines, camera shake, particles).

**Phase 7 — perf + size pass.**
Profile on a real mid-range phone. Tune `resolutionScale`, draw distance, scatter
density, chunk resolution. Re-pack and confirm the 2MB budget.

## 8. Reskin contract (the B2B deliverable)

The template's value is that a reskin is a **config edit, not a code edit**.
Every tunable lives in one file (`src/config/gameConfig.ts`) — nothing else in
the codebase holds a magic number:

- **Palette**: terrain color bands, road/lane colors, sky/fog, car colors, HUD.
- **Feel**: start/max speed, acceleration curve, steering rate, camera offset
  and damping, road width, lane count.
- **World**: seed, chunk size/resolution/draw distance, tree & rock density,
  `roadCenterX` curvature amplitude, biome band thresholds.
- **Content**: traffic spawn rate curve, vehicle type mix and dimensions.
- **Creative**: CTA copy, store URL, tutorial text, logo placement.

Model swap-in path: because traffic and the player are pooled `Mesh3D` nodes
(§5.4), replacing a box with an FBX/GLB is assigning `object3D` from
`assetCache.loadModel()` — no gameplay code changes. Note `loadModel()` returns
a fresh clone per call, and check whether a multi-material FBX can even be
instanced before assuming it can (`skills/3d/three-integration.md` warns about
exactly this).

## 9. Proposed module layout

```
src/
  index.ts                  # engine config, platform wiring, runScene
  config/gameConfig.ts      # THE reskin surface — every tunable, nothing else
  scenes/GameScene.ts        # owns systems, fixed update order
  game/
    PlayerCar.ts             # steering, lateral clamp, visual roll
    FollowCamera.ts           # TPP damping
    TrafficSystem.ts          # pool, spawn, recycle
    Collision.ts               # hand-rolled AABB over the active pool
    GameState.ts               # speed ramp, travelled, score, game over
  world/
    WorldScroll.ts            # the `travelled` scalar, world→render offset
    roadPath.ts                # roadCenterX(z), roadHalfWidth
    RoadMesh.ts                # recycled road strip
    TerrainStreamer.ts         # rolling chunk window + one-per-frame build queue
    ScatterStreamer.ts         # per-chunk deterministic trees/rocks
  procedural/                 # ported from Procedural_3D_world, cleaned
    noise.ts  math.ts  ambientHeight.ts  heightField.ts
    terrainColor.ts  chunkMesh.ts  scatter.ts
    tree/  rock/
  ui/
    Hud.ts  StartScreen.ts  GameOverScreen.ts  CtaButton.ts
```

## 10. Log

- **2026-08-25** — Research pass. Read `skills/3d/*`, `skills/build/*`,
  `skills/input/input.md`, `skills/scenes/creating-a-scene.md`, the engine's 3D
  typings and platform pack configs, and all of `Procedural_3D_world/src`'s
  terrain/scatter/vegetation/rock modules. Wrote this document. No game code
  written yet. D1-D4 confirmed by the project owner: meta-playables (2MB raw),
  free lateral steering, port-then-measure on the tree generator, portrait 720×1280.
- **2026-08-25** — **Phase 1 done.** `src/index.ts` (engine config: `enable3D`,
  `three`, `pixelRatio: 2`, WebGL, portrait 720×1280 `FIXED_HEIGHT`),
  `src/config/gameConfig.ts` (the reskin surface + the axis convention), and
  `src/scenes/GameScene.ts` (camera, ambient + directional light, fog, flat
  ground, placeholder road strip with edge lines, box car, 2D HUD label).
  `tsc --noEmit` clean; rendering confirmed in the browser by the project owner.
  Size floor recorded in §2.2: **917.9KB / 2MB**.
  Removed `res/bunny.jpg` — an unreferenced scaffold sample that was being
  base64-embedded into the playable at 14.7KB (recoverable from commit 630fe8a).
  Two engine facts learned and folded into §3: wrappers don't follow the Node
  hierarchy (item 6), and `vite.config.js`'s hardcoded
  `detectUsage('./src/index.js')` resolves a `.ts` entry fine — auto-trim
  detected all 11 used symbols correctly.
  Known-inert pack warning: `jcgt.org` (a paper citation inside a three.js
  shader comment) and `xxxxxx.io` (the engine's version banner) get flagged as
  external URLs by the static scan; neither is a network call. Re-check before
  a real submission.
- **2026-08-25** — **Phase 2 done.** The core loop is live and the game is
  playable: `src/world/WorldScroll.ts` (the `travelled` scalar, `renderZ()`, and
  the `repeatingZ()` modulo wrap that Phase 3's streamer will reuse),
  `src/game/GameState.ts` (speed ramp to cap, distance),
  `src/game/InputController.ts` (keyboard + hold-to-steer screen halves,
  collapsed into one -1…+1 axis sampled per frame),
  `src/game/PlayerCar.ts` (damped lateral velocity, clamp to road edges,
  cosmetic roll/yaw), `src/game/FollowCamera.ts` (exponential damping, easing
  back with speed), `src/world/RoadMarkers.ts` (instanced centre dashes +
  roadside posts — the only motion cue on a flat world), `src/ui/Hud.ts`
  (distance, km/h, steering hint).
  `tsc --noEmit` clean. Pack size **925.0KB / 2MB** (+7.1KB over Phase 1).
  Auto-trim correctly picked up `InstancedMesh3D`, `Input` and `inputListener`.
  Two more engine facts folded into §3 (items 13, 14): 2D design space is
  Y-DOWN with a width that varies under `FIXED_HEIGHT`, and the exact shape of
  global pointer listener registration/removal.
  Tuned after the owner drove it: the camera was yawing on every steer because
  its look-at target tracked the car's x — it now targets the camera's OWN x, so
  the view axis is permanently parallel to -Z and steering is pure lateral
  translation. Speed also felt roughly half its readout, which was the camera
  rather than the number: `height` 6.5→4.4, `distance` 10.5→8.2, `fov` 55→68,
  dash spacing 9→6m, post spacing 18→10m, plus `speed.start/max` 18/55→22/66 m/s.
  Replaced the speed-based pull-back (which *reduces* the sensation) with
  `fovSpeedGain: 8`. **Camera height and marker spacing are the two strongest
  perceived-speed levers — reach for those before raising m/s.**
- **2026-08-25** — **Phase 3 done.** Infinite scroll, streamed and generated at
  runtime (nothing baked — baking would cost bytes the 2MB budget doesn't have).
  New: `src/world/roadPath.ts` (`roadCenterX`/`roadLevelAt`/`roadHeadingAt`/
  `roadPitchAt` — the single definition of where the road is, how high, and which
  way it points, read by the height field, the ribbon, the markers and the car),
  `src/procedural/{math,heightField,terrainColor,chunkMesh}.ts`,
  `src/world/TerrainStreamer.ts` (fixed 54-slot pool, buffers rewritten on
  recycle, one build per frame, nearest-first), `src/world/RoadMesh.ts` (asphalt
  as recycled 20m bands, three vertex-coloured strips per band in one draw call).
  The flat placeholder ground is gone. `PlayerCar` rewritten: absolute lateral
  position (D5), five-point ground sampling, suspension damping on height/pitch/
  roll, footprint-based no-penetration height, wheels.
  Allocation churn from §4.2 fixed at the port, not after: `normalAt` and
  `terrainColorAt` write into scratch objects, and nothing in the per-frame path
  allocates.
  `tsc --noEmit` clean. Pack size **934.7KB / 2MB**.

  Findings promoted into this document because they cost real time and will
  recur: §5.7a (wavelength must be well under the visible distance — got wrong
  three times, and a single low-frequency octave can't produce slope), §5.7b (the
  2cm asphalt layer, and why the flat corridor must exceed the asphalt by a
  vertex spacing), §5.8 (fog density and draw distance are one coupled decision).

  Also: `debug.showSlopeBands` was added and earned its keep — a screenshot with
  it on settled in one look that the rock band was being generated correctly and
  that fog was what made it look absent. Terrain colour bands are tuned to the
  PLACEHOLDER hills; Phase 5's ridged mountains will need them re-derived.
  Flagged, not done: the four wheel meshes are barely visible from a chase camera
  and are a cheap optimisation target (see the note in `PlayerCar._buildWheels`);
  traffic must not copy that pattern.
