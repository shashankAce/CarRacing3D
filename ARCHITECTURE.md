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
- Player-controlled speed rises under gas, falls under brake or released gas,
  and is capped by the configured maximum.
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
it ships, so Phase 6's port should cost well under 100KB.

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

## 3. 3D — the facts that will bite you

**Two different layers live in this list, and knowing which is which changes
where you go to check it.** Items tagged **[three.js]** are upstream three.js
behaviour: verify them in `node_modules/three/build/three.module.js`, they
survive a NoonEngine upgrade, and they are searchable against three's own issues
and source. Everything untagged is **NoonEngine**: verify it in
`engine/types/3d/*.d.ts` or `node_modules/noonengine`, and re-check it if the
engine is ever bumped.

The list started as pure NoonEngine and drifted, which is worth naming: items 5
and 15-18 were all found while debugging this game and filed here without the
distinction, so anyone hunting a shader or render-target problem in "the engine"
was being pointed at the wrong layer entirely. If you add an item, tag it.

Source: `skills/3d/three-integration.md`, `skills/scenes/creating-a-scene.md`,
`engine/types/3d/*.d.ts`, and three.js 0.185.1 **[all verified]**.

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
5. **[three.js]** **Set `frustumCulled = false` on any InstancedMesh whose instances are
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
15. **[three.js]** **A custom `ShaderMaterial` gets NO output colour-space
    conversion.**
    three.js appends `#include <colorspace_fragment>` only inside its own
    materials' sources. A shader that writes `gl_FragColor` itself must include
    it, or linear values land untouched in an sRGB framebuffer and render far
    too dark. `THREE.Color(0x…)` converts sRGB hex INTO linear working space, so
    a uniform built from a hex literal is linear and will not survive the trip.
    - Measured: the sky dome's horizon colour is linear `(0.3511, 0.483,
      0.6652)`. Un-encoded it displayed as `rgb(89, 123, 170)`; the same colour
      through `FogExp2` on a built-in material rendered `rgb(160, 185, 213)`.
      One colour, two encodings, ~2x apparent brightness apart.
    - Cost of not knowing this: several rounds chasing a sky/fog mismatch as a
      gradient problem, a fog-density problem, and twice as a fake-volumetric
      problem. A linear-space comparison even "cleared" the colours, because in
      linear space they genuinely did match — the divergence is downstream of
      the mix, at encoding. **Compare rendered pixels, not source colours.**
    - Anything with a custom shader is suspect. `SkyDome` is currently the only
      one in this project; check any new one against a built-in material showing
      the same colour before trusting the look.

16. **[three.js]** **`project_vertex` applies the instance matrix to `mvPosition`, NOT to
    `transformed`.** The chunk reads
    `vec4 mvPosition = vec4(transformed, 1.0); #ifdef USE_INSTANCING mvPosition
    = instanceMatrix * mvPosition; #endif`, so any injected code that needs a
    world position has to re-apply the instance (and batching) matrix itself,
    under the same `#ifdef`s:
    ```glsl
    vec4 p = vec4(transformed, 1.0);
    #ifdef USE_BATCHING
        p = batchingMatrix * p;
    #endif
    #ifdef USE_INSTANCING
        p = instanceMatrix * p;
    #endif
    vWorld = (modelMatrix * p).xyz;
    ```
    `modelMatrix * transformed` alone compiles, runs, and gives **every instance
    of an InstancedMesh the mesh's own origin** — one single position for the
    whole batch. Cost of not knowing: the road markers were the only receiver in
    the scene with no shadow on them, and nothing in the shader looked wrong,
    because for non-instanced receivers the same line is correct.
17. **[three.js / GL]** **A quad whose axes come from the light has a
    SUN-DEPENDENT winding.** If a
    quad's two edge vectors are derived from the light direction, and the pass
    maps world Z to NDC y (as a top-down mask does), then its screen-space
    winding is a function of the light azimuth and **flips as the light goes
    round**. No fixed index order is correct for every sun angle, so the face
    test has to be off (`side: DoubleSide`) — that is a requirement, not
    laziness, and it will read as a pointless de-optimisation to anyone who
    finds it later.
    - The failure mode is what makes this expensive: `renderer.info.render`
      counts triangles **submitted, not rasterised**. A fully culled pass
      reports its draw call and its full triangle count while writing nothing at
      all, so a cost measurement looks healthy on a pass that is doing nothing.
      Verify an auxiliary pass by reading its target's pixels, never by its
      draw counters.
18. **[three.js]** **`renderer.info` resets on every `render()` call.** Any auxiliary pass run
    during `update` — before the engine draws the scene — therefore overwrites
    the counters the perf HUD reads in that same frame. A 1-draw mask pass turned
    the HUD's draw count from ~97 into a constant 1. Snapshot
    `info.calls/triangles/points/lines` and restore them around any extra pass,
    and report that pass's own cost separately.

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

### 5.3 Chunk recycling budget — MEASURED on device

No longer an estimate. Numbers below are from a low-end Android phone running
the dev build, read off the on-screen `PerfHud` (`debug.showPerf`), at
`chunkSize 40 / resolution 17 / 6 wide × 9 deep = 54 resident chunks`:

| | 5 field samples per vertex | 1 sample per vertex (grid normals) |
|---|---|---|
| typical chunk build | **4.30 ms** (26% of a 16.7ms frame) | **0.3–1.9 ms** |
| rolling peak | 4.80 ms | 1.1–1.4 ms |
| worst in-play build | — | 2.9–4.2 ms |
| opening 54-chunk burst | — | 28 ms total |
| worst frame | 19.1 ms | 18.1–20 ms (**unchanged**) |
| draw calls / triangles | 65–68 / 33–36k | same |

Three conclusions that were NOT obvious from desktop:

1. **Desktop is a useless predictor of mobile here.** Desktop measured 0.193ms
   against the phone's 4.30ms — **22×**, not the 3-5× I assumed. Never
   extrapolate device performance; that's what the counter is for.
2. **The cost was the sample count, not the arithmetic.** Four of the five
   field evaluations per vertex existed only to central-difference a normal.
   Differencing the already-sampled grid instead (with a one-vertex border ring
   so seams still agree) was a 6.3× win. See `chunkMesh.ts`.
3. **Chunk builds were never what caused the worst frame.** Cutting them 6×
   left `worst` unchanged at ~19ms against a 16.7ms vsync. That residue is GC
   and scheduler noise — confirmed by A/B'ing frame times with the HUD on and
   off from outside the page (11.48 vs 11.42ms mean; the HUD-off run had the
   *worse* maximum). Don't optimise toward it without evidence.

Instrumentation lessons worth keeping, both of which produced wrong conclusions
before being fixed:

- **Keep load-time work out of dropped-frame metrics.** `buildAllNow` runs the
  opening 54 chunks before the first frame, cold; its slowest chunk read 19.30ms
  and made the all-time peak look like a catastrophic regression while the game
  ran at a locked 60fps.
- **Never display a duration where a cost is implied.** A `hud` metric reporting
  the frame time after a repaint read 12.0ms against an 11.2ms mean — alarming,
  and meaning 0.8ms. It was removed rather than relabelled.

Mitigations if this ever becomes a problem again, in the order to apply them:

1. **Time-budgeted incremental builds** — slice one chunk across several frames
   against a ms budget rather than a fixed row count, so the queue can't fall
   behind. This bounds the spike without reducing total work; sustained load is
   only `9.9 chunks/s × per-chunk cost`, which is 0.71ms per frame even at the
   old 4.30ms. Designed but not built, since grid normals made it unnecessary.
2. **Lower `resolution`.** Cost scales with its square.
3. Fix the allocation churn from §4.2. *(Done at the port.)*
4. Hoist z-only road terms out of the x scan — `heightRowAt`/`heightInRow`.
   *(Done; worth ~10% on its own.)*
5. ~~Keep P3W's LOD tiers~~ — **this does not reduce build cost in a forward
   scroller, and the original claim here was wrong.** Chunks spawn at the FAR
   edge and approach the player, so a tiered chunk is re-tessellated on the way
   in: far + mid + near ≈ 1.37× the cost of one full-resolution build. LOD helps
   triangles and GPU fill, not CPU. (It also conflicts with grid normals — see
   the caveat in `chunkMesh.ts`.)

Only measure-then-fix. `showStats: true` plus a `performance.now()` timer around
the chunk build is the whole instrumentation needed.

### 5.4 Traffic: pooled nodes, not instancing
Traffic uses a fixed pool of **16** `Mesh3D` nodes sharing one unit
`BoxGeometry` and one material per vehicle type — not an `InstancedMesh`.
At this count the pool is already only one draw call per material, while
per-object lane logic stays readable and swapping in an FBX/GLB later remains a
one-line `object3D` assignment. Never create/destroy vehicles at runtime;
recycle the pool.

Vehicles normally travel on lane centres. When a faster vehicle catches a
slower one, it signals for `0.9s`, reserves a destination lane, then crosses at
`0.85` lanes/second. The clearance test sweeps the relative gap through both
the signalling and crossing intervals, so it rejects a lane that is safe now
but will be occupied when the manoeuvre completes. If the gap closes during
the signal, the manoeuvre is cancelled; if no lane is safe, the vehicle slows
to match. `laneYaw` follows the actual lateral path and eases back to the road
heading, capped at `0.24` radians.

Placement now samples the four yawed footprint corners to derive pitch and
roll, then uses a nine-point footprint test for the lowest supported body
height. This keeps long vehicles grounded over crests, dips and lane changes;
the previous single centre-height sample made them float or clip.

### 5.5 Collision: hand-rolled, in 2D
Everything is axis-aligned, one player, and at most sixteen traffic obstacles;
gameplay is on the XZ plane. A `for` loop over the active pool doing an
interval-overlap test on (x, z) is deterministic and frame-exact. Y is still
ignored deliberately: all vehicles share the drivable surface, so a height
test would create a way to drive through a bus on a slope.

The player now has a small render-space Z offset while steering around its
rear pivot. Collision converts that pose back to the player's absolute world Z
with `travelled - car.position.z` before comparing it with each traffic
vehicle's `worldZ`. This keeps collision timing aligned with the visual pose
without turning the cheap AABB test into a rotated-body test.

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

The player axis drives a damped steering yaw, not a free lateral velocity.
The current car reaches `0.22` radians at full input, with a rear pivot at
`0.62` of the half-length. Lateral movement is derived from that same yaw as
`-tan(yaw) * speed * dt`, so the body direction and travel direction agree and
there is no sideways slip. Absolute X is still clamped to the moving road
edges; the car never follows a bend without input. Steering roll is speed-scaled
for feel, while the road's pitch and roll come from the actual tyre contacts.

The body uses exponential response for yaw, tilt and height. Its ground floor
is the maximum required height over a nine-point yawed footprint, with a
`0.04m` maximum downward gap while the suspension catches a falling surface.
This prevents both penetration on rising ground and visible floating on
descents.

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

### 5.5a Tuning difficulty with a simulated driver

Traffic density, spawn spacing and vehicle speeds can't be tuned by feel alone —
the failure they produce is rare and specific: a formation the player physically
cannot pass. Playing for it takes hours; simulating it takes seconds.

The method used in Phase 4, worth reusing for any later balance question:

1. Port the spawn/move/despawn logic into a standalone script (it's pure
   arithmetic on `worldZ`, no engine needed).
2. Add a **greedy driver**: each step, sample ~40 lateral positions, score each
   by clearance to the nearest blocking vehicle within a lookahead, and steer
   toward the best with the game's current yaw-derived lateral path and
   exponential steering response.
3. Run 100km+ per configuration and count crashes — but separately count
   crashes where **no lateral position on the road was safe**. That second
   number is the one that matters; it's the unwinnable case.

What it found, which feel would not have:

- A **pool leak**: traffic faster than the player's opening speed recedes
  forever, and with only a despawn-behind test it holds its slot until the pool
  is full of distant vehicles and spawning stops. Hence `despawnAhead`.
- An **empty opening**: at the original speeds, closing speed early in the ramp
  meant the first overtake was ~26 seconds away — longer than a whole run.
  Hence traffic strictly slower than `speed.start`, plus seeding the road at
  reset (first cut now ~129m, about 5 seconds).
- A **fairness tail**: at spawn gap 62→34 the design is fair 98.8% of the time —
  3 unavoidable deaths per 150km. Loosening to 78→46 gives zero across 160km at
  1.03 crashes/km. In a playable ad an unavoidable death is the one thing that
  stops a player retrying, so that tail was worth 0.6 crashes/km.
- That a **dynamic anti-wall guard wasn't needed.** Transient walls do form
  (~0.05/km, since vehicles at different speeds rearrange long after spawning),
  but they dissolve before the player arrives. Prototyping the guard in
  simulation and measuring no benefit is what kept it out of the codebase.

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

**Fog cannot hide anything on its own.** It blends a surface toward the fog
colour; whether that makes the surface *disappear* depends entirely on what is
behind it. Distant trees sit only 2.9-6.7° above the horizon and mountains
8-18°, and at those elevations the sky gradient is already 16-36% of the way to
the deep blue zenith — so fully-fogged geometry still read as pale shapes against
a bluer sky. The fix is a **haze band** (`sky.hazeHeight`): force the low sky to
exactly the derived fog colour, fading into the gradient above. Raising the
gradient exponent works too, but this camera only ever sees 6-25° of sky, so that
pales out all of it and loses the colour. Set the band to cover the trees and the
BASE of the mountains, so ranges fade at the bottom and stay visible at the top.

Pushing the draw edge out does **not** raise the chunk build rate — that's
`speed / chunkSize`, about 10 chunks/second at top speed, independent of how far
ahead they sit. It costs resident memory and triangles only (54 chunks ≈ 41k
triangles, 0.8MB of typed arrays), and the lateral column count has to grow with
it: portrait's horizontal FOV is only ~42°, so the view is ±106m wide at 280m.

### 5.8a Mobile GPU budget — what three "nice" features actually cost

Sky, shadows and trees were added at the owner's request and took the game from
a locked 60fps to **17-25fps (59ms mean, 135ms worst)** on a low-end phone. The
recovery is worth recording in full, because almost none of it was where I
expected.

Desktop mean frame time, SwiftShader (software rendering, so fragment-bound like
a weak mobile GPU — good for RANKING fragment costs, useless for absolute ones):

| step | mean | frames >20ms |
|---|---|---|
| as first built | 33.9 ms | 399/400 |
| shadow map 1024→512, frustum 70→40m, posts stop casting | 22.8 ms | 289 |
| clouds: shader noise → baked sprites | 22.5 ms | 219 |
| **trees: bigger and fewer** | **15.3 ms** | **6** |
| *(all three features off, for reference)* | 13.2 ms | 0 |

Result on device: back to **60fps**, with full resolution intact —
`render.pixelRatioCap` never had to be lowered, so nothing was paid in sharpness.

**The A/B that mattered.** Each feature was measured by disabling it alone:
clouds 7.7ms, shadows 8.9ms, trees 7.9ms. Roughly equal thirds — so there was no
single culprit to fix, and any one fix alone would have looked like failure.
Measure all of them before concluding anything.

**"Bigger and fewer" beat every micro-optimisation** *(the owner's suggestion)*.
Raising tree size and thinning the count to hold canopy coverage constant was
sized to save ~2× on triangles; it saved **7ms**, over half the remaining
regression. So tree COUNT was costing far more than its triangles: per-instance
matrix writes, and every tree rasterised a second time into the shadow map.
Count is expensive, size is nearly free. Apply this to rocks and any future
scatter before tuning anything else.

**Per-pixel procedural detail is the wrong shape for a mobile playable.** The
sky's noise clouds cost 7.7ms because every pixel of the upper sky paid for ~16
evaluations of 3D simplex whether a cloud was there or not. Two wrong turns
before the right one: cheapening the noise (broke the look — a raw noise value
compared against a processed density gives dark blotches), then a baked
cloud-plane texture (still a fetch across the whole sky). Billboards pay only
for the pixels a cloud covers. The gradient-and-glow dome, measured separately,
is very nearly free — it was never the problem.

**The fixed camera is an exploitable constraint.** Because the camera never yaws
or re-pitches, the visible sky is a permanent window: elevation 6-25°, azimuth
±21°. Cloud quads therefore need no billboarding (a quad facing +Z always faces
this camera), can be one instanced draw per texture, and only need to exist in
the forward arc. A first attempt scattered them over the full celestial sphere
and rendered an empty sky — ~1.6 of 14 inside the horizontal cone, none inside
the elevation band.

**Draw order for a sky that isn't wasteful.** Draw the dome LAST with depth
testing and no depth write, so only pixels with no geometry in front of them
shade. The usual skybox trick (draw first) pays full fragment cost for the ~60%
of the screen that terrain then paints over. The price is that the dome must
ENCLOSE all geometry — hence `sky.domeRadius` 350 against a farthest terrain
corner of 305m, and `camera.far` 400 to contain it.

### 5.9 Shadows: in the lighting equation, or not at all

This section has been rewritten twice. It first said to ship a fake blob shadow.
It then said real shadow maps were in and viable at 512. Both are superseded:
the shadow map was rejected by the owner on **quality**, not cost, and the baked
decal quads that replaced it were rejected for looking like plates under the car.

**The single lesson worth keeping.** A shadow is not a dark shape on the ground,
it is the absence of the sun. Every technique that composites darkness ON TOP of
already-lit ground reads as a sticker no matter how good its silhouette is:
uniform alpha, a hard edge, no hue shift, and a visible separation at grazing
angles. Three separate attempts failed on this, and it was diagnosed twice as a
placement problem before the actual cause landed — it is not *where* the shadow
is drawn, it is **where in the pipeline it is applied**.

Anything that works injects after `#include <lights_fragment_begin>` and scales
`reflectedLight.directDiffuse` / `directSpecular` only. Ambient and the env map
survive, so shadow shifts cool as well as dark. And there is no quad, so
"draping over irregular terrain" — the problem that consumed the decal attempt —
simply stops existing: each fragment resolves its own shadow at its own position.

**Two mechanisms, split by caster count.**

| | casters | mechanism | per frame |
|---|---|---|---|
| car, traffic | ~6 | uniform slots, `ProjectedShadows` | 0 draws |
| trees | 400 | top-down texture, `TreeShadowMask` | 1 instanced draw, ~276 tris |

The split is forced: uniform slots cannot hold 400 casters, and a texture
cannot be sampled on a vertical surface without smearing (see below). Both share
one silhouette atlas and one `onBeforeCompile` patch, attached to **every** lit
receiver — terrain, road, markers, traffic, the car. The ground is not special.

**Sample in the LIGHT's frame, not on the ground plane.** The obvious
formulation projects the silhouette onto the ground and samples it by world XZ.
That is correct for flat ground and smears on everything else, because every
point of a vertical surface at one XZ reads the same value. Instead use
`r = dot(rel, R)`, `u = dot(rel, U)`, `d = -dot(rel, S)` — a shadow-map lookup
with the depth test removed. Correct on any surface orientation, and the
`1/sin(elevation)` stretch falls out for free rather than being applied by hand,
which is one fewer sign to get wrong.

**Having no depth test costs exactly two things, and both need handling.** A
shadow would otherwise reach infinitely down-light (`fadeNear`/`fadeFar` bound
it) and would fall on surfaces between the caster and the sun (`d <= 0` rejects
those). What cannot be recovered is a caster shadowing ITSELF, since that is the
case the depth test exists for — hence `attach`'s `skip` option, so the car's own
material opts out of its own silhouette rather than darkening its whole
down-light half on top of what N·L already does.

**The tree mask needs an occluder-HEIGHT channel, not just coverage.** A
ground-indexed mask answers "is the ray arriving at this ground point blocked".
A fragment 1.7m up is lit by a ray that meets the ground `|S.xz|/S.y` metres
further down-light — 2.2m per metre of height at a 24° sun, 4.6m at 12° — so the
lookup must be unprojected along the light first. That much is exact
(`lift · R = 0` and `lift · U_xz = U.y`, verified to six decimals). But
unprojection alone still says only "blocked somewhere", and a raised receiver
needs "blocked ABOVE me": without the height test it picks up **~11m of spurious
shadow on the sunward side of every tree**, so the shadow on a car begins well
before the shadow on the road. Two misaligned shadows look worse than one
missing one. So the atlas carries coverage in alpha and the highest blocking
geometry in red, written under MAX blending. Measured against analytic ray
occlusion, height rejection holds IoU at **0.998** across receiver heights where
coverage alone decays to 0.938.

**Resolution is the honest limitation.** A per-caster atlas cell is a fixed
budget for one object; a mask spreads its texels over a whole window.

| | texels/m |
|---|---|
| vehicle — 256² cell over a ~3m footprint | ~85 |
| tree — 1024² mask over a 160m window | 6.4 |
| the rejected 512 shadow map over its reach | ~7 |

The 13× vehicle/tree gap is structural and cannot be tuned away. Note the mask
still beats the shadow map it replaced, and that **a low sun makes tree shadows
worse**: shadow length is `1/tan(elevation)`, so a 14m tree throws 31m at 24°
and 65m at 12° — the same cell stretched over twice the ground.

**Terrain self-shadowing is a separate feature, and a disappointing one.** The
terrain mesh has only ever carried `receiveShadow`, so hills have never shaded
valleys under any setting — no shadow technique addresses it, because terrain is
not a caster. `terrain.selfShadow` marches toward the light on a coarse lattice
at chunk build time and multiplies the result into the vertex colour, so it costs
nothing per frame. It was expected to matter and mostly does not: cast shadow
needs terrain steeper than the sun's elevation, and this height field's median
slope is 15°.

| sun elevation | terrain in shadow |
|---|---|
| 52° | **0.0%** |
| 24° | 3.0% |
| 12° | 17.8% |
| 6° | 39.4% |

And at 12°, only 3.2% of terrain is sun-facing yet shadowed — the part `N·L`
cannot already produce. Kept because it is nearly free and because Phase 6
replaces `ambientHeightAt` with a real fbm + ridged field whose sharper relief is
exactly what makes it pay.

**Verification: a symmetric test cannot detect a symmetry error.** Three sign
bugs in this work were each caught by comparing two independent formulations,
and none would have been caught by checking the result looked plausible:
- The mask's across axis was `-R` instead of `+R`. A mirrored rectangle **is**
  the same rectangle, so every check on placement, extent and direction passed
  while every silhouette was flipped. Only comparing the mask's UV against the
  light-frame UV showed it: 1.43 error against 0.0000.
- Aggregate agreement is a useless metric when the positive class is rare. A
  shadow footprint is ~11% of a test grid, so "everything is lit" already scores
  89%. Use IoU over the shadowed set.
- Pixels, not counters, for an auxiliary pass — see §3 item 17.

`lighting.shadows.enabled` (the real map) is still present and switchable.
`lighting.bakedShadows` is the dead decal path, kept only until it is deleted.

**Not yet measured on device:** the mask pass's fill, and the per-fragment cost
on vehicle materials. Every number above is static analysis or a readback.

## 6. Decisions

All four were confirmed by the project owner on 2026-08-25 — these are settled,
not assumptions to revisit.

| # | Decision | Settled as |
|---|---|---|
| D1 | Which ad target is the 2MB from? | **`meta-playables`** — 2MB raw single HTML, no network requests. Everything here is built to its rules, which satisfies every other network too. |
| D2 | Discrete lane snapping vs free lateral steering? | **Free lateral steering** with clamping to the road edges. Input drives a rear-pivot yaw and derives lateral movement from it; speed scales the visual roll. Traffic still spawns on lane centres. |
| D3 | How rich are the trees? | **RESOLVED 2026-08-26: fallback taken.** P3W's generator measures **38,900 triangles and 2.9MB per tree** (its own cheap `ringDetail: 0.4` tier only reaches 38,216 — that thins branch rings, and the triangles are in the foliage). The whole scene runs ~40k triangles. Low-poly geometry is used instead, ~60 triangles a tree; everything else from P3W (scatter, instancing, vertex colour, proportions) is kept. Original plan below. |
| D3-orig | *(superseded)* | **Port, then measure.** Start with P3W's generator at its cheap `ringDetail: 0.4` tier and a **3-variant** pool, and measure both boot-time generation cost and frame cost. If either is material, fall back to a simple cone/sphere tree — at this camera distance the full skeleton may be invisible detail we're paying full price for. |
| D4 | Portrait 720×1280? | **Yes** — matches the existing scaffold and `pack:google-playables --orientation=portrait`. |
| D5 | Does the car follow a curving road on its own? | **No.** Settled 2026-08-25 after trying both. The car's lateral position is ABSOLUTE and only steering moves it; the clamp to the asphalt is what tracks the curve. So holding a bend takes input, and reaching an edge is a collision that shoves the car along it. Storing the car's position as an offset from the road centre was tried and rejected — it carried the car through bends with no input, making the curve decoration. |
| D7 | Is speed automatic or player-controlled? | **Player-controlled** (Phase 5). Gas accelerates, manual brake decelerates, and releasing gas applies automatic braking. Current tuning is `30/24/66 m/s` for start/min/max; the coupe can reach `26 m/s`, so the old “minimum above all traffic” invariant is no longer exact and must be rechecked if rear encounters become a problem. |
| D8 | What ends a run besides crashing? | **Fuel**, draining on TIME rather than distance. Constant per-second burn means distance-per-tank is maximised by speed, which pushes the player to rush. Per-metre would make speed neutral; per-throttle would reward coasting. |
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

**Phase 5 — player throttle and fuel.**
Gas and brake replace the automatic speed ramp; four on-screen buttons (steer
left/right, gas, brake) plus keyboard; a fuel tank that drains on time and ends
the run when empty. Added at the owner's request after playing Phase 4, and it
changes the shape of the game: the ramp used to supply the difficulty curve, and
that job now belongs to the fuel clock plus the fact that the sharpest bends
cannot be held at full speed. `road.curveAmplitude` goes to 8 for the same
reason — see the balance note on that setting.

**Phase 6 — the procedural environment.**
Port `noise` → `ambientHeight` → the road-carving `heightField` → `terrainColor`
→ `chunkMesh`. Then per-chunk scatter with road rejection, then rocks, then
trees, then LOD. Fix the §4.2 allocation churn as part of the port, not after.

**Phase 7 — playable polish.**
CTA button gated on `platform.isAdCreative`, `platform.triggerCTA(storeUrl)`
(never `window.open`), `platform.notifyReady()` moved to when the game is
genuinely playable, `platform.isAudioEnabled()` (a hard YouTube cert rule),
tutorial hand/arrow prompt, restart, juice (speed lines, camera shake, particles).

**Phase 8 — perf + size pass.**
Profile on a real mid-range phone. Tune `resolutionScale`, draw distance, scatter
density, chunk resolution. Re-pack and confirm the 2MB budget.

## 8. Reskin contract (the B2B deliverable)

The template's value is that a reskin is a **config edit, not a code edit**.
Every tunable lives in one file (`src/config/gameConfig.ts`) — nothing else in
the codebase holds a magic number:

- **Palette**: terrain color bands, road/lane colors, sky/fog, car colors, HUD.
- **Feel**: start/min/max speed, gas/brake response, steering yaw and rear-pivot
  response, suspension, camera offset and damping, road width, lane count.
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
    PlayerCar.ts             # rear-pivot steering, lateral clamp, suspension
    FollowCamera.ts           # TPP damping
    TrafficSystem.ts          # pool, spawn, recycle
    Collision.ts               # hand-rolled AABB over the active pool
    GameState.ts               # throttle speed, fuel, travelled, game over
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
  PLACEHOLDER hills; Phase 6's ridged mountains will need them re-derived.
  Flagged, not done: the four wheel meshes are barely visible from a chase camera
  and are a cheap optimisation target (see the note in `PlayerCar._buildWheels`);
  traffic must not copy that pattern.
- **2026-08-25** — **Phase 4 done.** Traffic and the game loop.
  `src/game/TrafficSystem.ts` (fixed 16-vehicle pool; one shared unit BoxGeometry
  scaled per type and one material per type, so a vehicle is one draw call and
  the pool is four materials — deliberately not `PlayerCar`'s six-mesh approach,
  which at this count would be ~96 draw calls; lane placement, weighted type
  selection, spawn spacing eased by speed, seeding on reset, and recycling in
  both directions). `src/game/Collision.ts` (hand-rolled XZ interval overlap —
  see §5.5; Y ignored deliberately, since every vehicle is on the same surface).
  `src/ui/GameOverPanel.ts`, a `cuts` readout in the HUD, and `RunPhase` on
  `GameState` with crash/restart wiring in the scene.
  Traffic reuses the road functions the player and markers already use —
  `roadCenterX`, `surfaceHeightAt` (NOT `heightAt`; see §5.7b) and
  `roadPitchAt`/`roadHeadingAt` — so it sits correctly through curves and crests
  with no code of its own.
  Balance set by simulation rather than feel; method and findings in §5.5a.
  Verified end to end: crash panel reads `242 m · 3 cut · 392 pts` (242 + 3×50),
  world freezes, tap restarts with a re-seeded road and no page errors.
  `tsc --noEmit` clean. Pack size **943.7KB / 2MB** (+7KB), draws 67 → 74.

  Known rough edge, deferred to Phase 7: on impact the player's car is left
  overlapping the vehicle it hit, because there's no separation or crash
  animation — the run simply stops. It reads as clipping. A short impact
  sequence (or just backing the car off to contact distance) is the fix.
- **2026-08-25** — **Phase 5 done.** Player throttle and fuel, requested after
  the owner played Phase 4. `src/ui/TouchControls.ts` (four hold-to-act buttons),
  throttle + fuel on `GameState` with an `OUT_OF_FUEL` phase, a fuel gauge in the
  HUD, and a run-end reason on the game-over panel. The automatic speed ramp is
  gone. `road.curveAmplitude` raised 4.5 → 8: at 0.2×speed of lateral demand
  against a 12 m/s steering limit that puts a hard ceiling of 60 m/s through the
  sharpest bends, below the 66 m/s top speed — unholdable before a brake existed,
  and the point of having one now.
  The HUD moved to the top of the screen to clear room for the buttons.

  Three findings worth keeping:
  - **A node's hit box is anchored at its position, not centred**
    (`InputListener._hitAABB` tests `0 <= local <= width/height`), and
    `LabelSystem` writes a label's measured text size back into its node
    (`LabelSystem.js:512`). So a button is a bare parent node carrying the hit
    box with the glyph on a CHILD — put the glyph on the hit node and the touch
    target shrinks to one character.
  - **Release must be keyed on pointer id.** A per-node pointer-up never fires
    for a finger that slides off the button, and a global "release everything"
    drops the steering button the moment the player lifts their gas thumb.
  - **Anchor on-screen controls to the LIVE `display.designWidth`.** Fixed
    offsets from the design centre put the left button at x = -5 on a 19.5:9
    phone, i.e. off the display.

  Verified in a browser: gas measured 24 → 45 m/s over 3s at 7 m/s² (`163 km/h`,
  matching the arithmetic exactly), press highlighting works, cuts still score,
  crash and restart still work. `tsc --noEmit` clean.
- **2026-08-26** — **Phase 6, part one: sky, sun, shadows, trees, mountains.**
  Rocks and LOD not done.
  New: `procedural/sky/SkyDome.ts` (P3W's dome shader, reduced to gradient + sun
  glow), `procedural/sky/CloudSprites.ts` + `cloudTexture.ts` (CPU-baked puffs on
  instanced quads in the forward arc), `procedural/tree.ts` (low-poly conifer,
  ~60 triangles), `procedural/mergeGeometry.ts` (hand-rolled, so
  `BufferGeometryUtils` stays out of the bundle — an InstancedMesh draws ONE
  geometry, so an unmerged tree cannot be instanced at all),
  `procedural/random.ts`, `world/ScatterStreamer.ts` (per-chunk deterministic
  placement, ported rejection rules, instanced per variant).
  `lighting.sunDirection` is now the single source of truth for the light, the
  sky's glow and horizon warmth, and the shadow frustum's aim. Scene fog and
  background are DERIVED from the dome's effective horizon — the shader warms it
  by sun height, so a hand-matched fog colour agrees at exactly one sun elevation
  and seams at every other.
  Mountains added to `ambientHeightAt` on the owner's suggestion ("increase the
  terrain height that looks like rock, but not for all"), structurally ported
  from P3W: region mask for where, distance mask to keep ranges off the verge,
  ridged field on a rotated squashed domain for elongated chains, massif hump for
  bulk, hill octaves damped inside regions. Rock colour now also triggers by
  ALTITUDE, since a mountain's broad gentle flanks stayed green on slope alone.
  Two things taller terrain broke, both caught: the chunk bounding sphere was
  sized for ±11m of hills against ~40m mountains, and would have culled chunks at
  the edge of frame.
  Perf: 59ms → 60fps on device. Full write-up in §5.8a; §5.9 rewritten now that
  real shadows have shipped. `tsc --noEmit` clean. Pack **956.6KB / 2MB**, one
  file, passing.
  Process note: I spent several turns reporting pack size from a grep of the
  `Total:` line while the pack was in fact FAILING (an unembeddable `.rar` in
  `res/`, over the 1-file limit). Read the whole pack output.

- **2026-08-26** — **Shadows rebuilt.** The real shadow map was rejected by the
  owner on quality (a 512 map over its reach resolves ~7 texels/m); the baked
  decal quads that replaced it were rejected for reading as plates under the
  car. Replaced by two mechanisms that both modulate lighting inside the
  receiver's shader — `world/ProjectedShadows.ts` (car and traffic, uniform
  slots, 0 extra draws, ~85 texels/m) and `world/TreeShadowMask.ts` (400 trees
  in one top-down texture, 1 instanced draw, ~276 tris) — sharing one silhouette
  atlas (`procedural/shadowSilhouette.ts`) and one `onBeforeCompile` patch
  attached to every lit receiver. Plus `procedural/terrainShadow.ts`, terrain
  self-shadowing baked into the vertex colour at chunk build (2.15x build cost,
  ~+1.2ms/chunk on a low-end phone estimate). §5.9 rewritten in full; three new
  **three.js** gotchas in §3 (16-18) — and §3 retitled and tagged, because it
  claimed to be a NoonEngine list while items 5 and 15-18 are all upstream
  three.js, which sends anyone debugging a shader or render target to the wrong
  layer. Bundle **994.8KB / 2MB**.
  Four rounds of being wrong, all worth recording:
  I twice told the owner a limitation was "structural" when it was not — tree
  shadows draping (solved by moving the lookup into the ground shader) and tree
  shadows on vehicles (solved by unprojecting along the light, then by adding an
  occluder-height channel). Both times the owner pushed back and was right; both
  times my claim rested on the formulation I happened to have rather than on
  anything inherent. "Structural" needs a derivation, not an intuition.
  I also reported cost figures for a pass that was producing an entirely empty
  texture, because `info.triangles` counts submitted triangles and the pass was
  fully backface-culled — see §3 item 17. And I reported an FPS drop that was a
  hitch from my own concurrent build; three repeat runs showed no change.
  Process note that worked: every sign convention in this work was verified by
  comparing two independent formulations numerically (light-frame vs mask UV,
  mask lookup vs analytic ray/box occlusion) rather than by looking at a render.
  All three sign bugs were found that way and none would have survived to the
  owner; the two failures above are both cases where I reasoned instead of
  measuring.

- **2026-08-26** — **Gameplay and geometry tuning.** `ca488ac` moved the fixed
  preview to 14:00, raised the low-poly tree range from 8–14m to 8–16m, and
  reduced roadside clearance from 15m to 12m. `dd12dc9` reduced the terrain
  window from six to four chunks across; the draw distance remains fog-coupled
  at seven chunks ahead. These are config-only changes intended to make the
  gameplay reference read correctly while lowering resident terrain cost.
- **2026-08-26** — **Car and traffic handling rebuilt** (`faf61ac`). Player
  steering now uses a damped rear-pivot yaw (`0.22` rad max) and derives lateral
  movement from yaw and speed instead of integrating a sideways velocity. The
  car and traffic now use yawed tyre/footprint samples for pitch, roll and
  ground support, with bounded suspension travel. Traffic lane selection now
  reserves target lanes and sweeps relative gaps through signalling and
  crossing; lane-change yaw follows the actual path. Collision accounts for the
  player's render-space Z offset before comparing absolute world positions.
  Releasing gas now applies `autoBrake` (`14 m/s²`), matching manual braking;
  `coastDrag` is gone. No new runtime dependency or physics system was
  introduced.
