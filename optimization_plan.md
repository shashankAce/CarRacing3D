# Mobile Optimization Plan

## Previous plan: complete

The original plan below is entirely implemented and confirmed in current
`gameConfig.ts`:

1. **Merge static vehicle meshes by material** — done. `VehicleModels` batches
   each FBX into one mesh per material class.
2. **Traffic LOD** — done (see "Add traffic LOD" / "Add configurable traffic
   wheels and pool" commits).
3. **Simplify wheel geometry** — done. `vehicles.testWheels.enabled: true`
   replaces the original FBX wheels with a 20-segment procedural wheel,
   instanced.
4. **Disable glass transmission** — done. Glass now uses transparent
   `MeshStandardMaterial`; this matters because any `MeshPhysicalMaterial`
   transmission value above zero enables three.js's full transmission pass.
5. **Cap active traffic** — done, and further than planned:
   `traffic.maxAlive: 5` (plan asked for 8).
6. **Lower tree-shadow mask resolution** — done. `treeShadows.maskSize: 512`.
7. **Reduce projected-shadow casters** — `projectedShadows.maxCasters: 6`,
   left at 6 deliberately (derived from `traffic.spawnAhead`, not a guess —
   see the config comment).
8. **Coarse-reject projected-shadow casters per fragment** — done. Each live
   caster now supplies a conservative XZ rectangle derived from the exact
   light-space r/u/d volume. Fragments outside it skip the caster before the
   expensive dot products and atlas-coordinate work, without changing any
   accepted shadow sample.

The measurements and per-vehicle table below this line are from before that
work and are now stale — the FBX draw-call counts (33-40/vehicle) no longer
reflect the batched vehicles. Superseded by the measurements that follow.

## Current measurements

Methodology: Playwright + CDP, `Emulation.setCPUThrottlingRate` at 20x, driven
with continuous gas + weaving steer input (not idle) so terrain/traffic
streaming stays live. Headless Chromium defaults to SwiftShader (software
GL), which bottlenecks at ~4-5fps regardless of throttle and is useless for
absolute numbers — relaunched with `--use-angle=metal` for real GPU
rendering (Apple M4 Pro on the dev machine) so the CPU throttle actually
isolates CPU-bound cost, the way a weak mobile chip would.

| | value |
|---|---:|
| avg FPS, 20x CPU throttle, sustained driving | ~55-60 |
| worst single frame | 22-65ms (occasional spike, not sustained) |
| draw calls | 136-161 |
| triangles | 76k-96k |

This lines up with the "brought fps to 50 on mobile" commit. No single
remaining bottleneck — the batching/capping work above already did its job.
**Stale relative to the config below** — terrain and road-band tuning since
this measurement should have shifted draw calls down slightly; not
re-profiled after the latest round of edits.

## Draw-call breakdown (verified, not estimated)

Confirmed by hooking `WebGL2RenderingContext`'s real `drawElements` /
`drawArrays` / instanced draw methods directly (below three.js, so exact),
single-frame capture cross-checked against the HUD's own
`renderer.info.render.calls`: 138 distinct draws measured vs. 136-141
reported by the HUD — matches within measurement noise. Measured against an
earlier config (`chunksWide: 3`, `bandsAhead: 15`); the counts below are from
that snapshot.

| Source | Draws (at time of measurement) | How identified |
|---|---:|---|
| Terrain chunks | 42 | 2304 indices = 768 triangles/draw. One unmergeable `THREE.Mesh` per resident chunk (unique heightfield geometry per chunk — see `TerrainStreamer.ts`). Count = `chunksWide × (chunksAhead + chunksBehind + 1)`, independent of `chunkWidth`/`chunkLength` (world-space size per chunk, not chunk count). |
| Road-surface bands | ~35 | 72 indices = 24 triangles, exactly `STRIP_COUNT(3) × segmentsPerBand(4)`'s output in `RoadMesh.ts`. Count = `bandsAhead + bandsBehind + 1`, independent of `bandLength`. |
| Vehicles | ~15-20 | One large non-indexed `drawArrays` per visible vehicle per material batch (body/glass/headlights), plus one small instanced wheel draw each. |
| Trees, road markers, sky dome, clouds | ~40 combined | All `InstancedMesh` — one draw per variant/type regardless of instance count. |

Terrain chunks and road bands together were the majority of draws — two
independent streaming-mesh systems, both drawing one unmergeable mesh per
resident segment. Not vehicles (which the original plan correctly targeted,
and which are already fixed).

**Current chunk/band counts, recomputed from present config, not re-measured:**

- Terrain: `chunksWide(4) × (chunksAhead(5) + chunksBehind(1) + 1) = 4 × 7 = 28` draws.
- Road bands: `bandsAhead(10) + bandsBehind(1) + 1 = 12` draws.

Both counts came down from the measured snapshot (terrain 42 → 28,
`chunksWide` 3 → 4 was a symmetry fix, not a perf move, but it happens to
also cost fewer draws than the in-between broken state; bands 18 → 12, a
deliberate cut — see below). Total draws should now read noticeably lower
than the 136-161 range above; worth a fresh profiling pass rather than
trusting this arithmetic.

## Terrain chunk shape: width/length split

`terrain.chunkSize` (one square value) was replaced with independent
`chunkWidth` (X, lateral) and `chunkLength` (Z, forward), on the reasoning
that sideways view is short (portrait FOV ~42°) while forward draw distance
has to reach as far as the fog does — no reason to spend the same world-space
size in both directions. Current values: `chunkWidth: 30`, `chunkLength: 40`.

This touched every place that assumed a square chunk, now split per axis:
normal-differencing gradient in `chunkMesh.ts` (a shared divisor there would
have tilted every normal once width ≠ length), the self-shadow lattice in
`terrainShadow.ts`, the road-corridor flatness margin in `heightField.ts`
(keyed to `chunkWidth` specifically — that margin protects against a
*lateral* triangle-crossing artifact), and tree placement's jittered grid in
`ScatterStreamer.ts`.

**Important:** neither `chunkWidth` nor `chunkLength` affects draw-call
count — chunk *count* is `chunksWide` and `chunksAhead`/`chunksBehind`,
independent of how many world-metres each chunk spans. This was tested
directly (`chunkWidth` dropped 40 → 20 with no draw-call change) before
`chunkWidth` was set to its current 30.

**Coverage check, not yet done:** at `chunkWidth: 30`, `chunksWide: 4`, total
lateral terrain reaches `4 × 30 / 2 = 60m` from the road centre. The frustum
at the current draw distance (`chunksAhead(5) × chunkLength(40) ≈ 200m`,
~42° horizontal FOV) needs roughly ±75-80m at that far edge — 60m is still
short of that by the same math flagged when `chunkWidth` was briefly 20.
Worth checking for a visible terrain edge/pop-in near the horizon.

### `terrain.chunksWide` symmetry bug (fixed)

Was changed to `3` (odd) mid-session, which is exactly the failure mode
the adjacent comment warns about: chunks are indexed by their min corner,
so an odd count doesn't straddle the road. With `chunksWide: 3` the actual
world coverage was `X ∈ [-40, +80]` — the right side of the road had
**double** the terrain of the left. Fixed back to `4` (even), which
straddles symmetrically. If this value moves again, keep it even.

## Road-surface bands

`roadSurface.bandsAhead` cut **15 → 10**, `bandsBehind` **2 → 1**. Pool size
(= road-band draw calls) falls from 18 to 12. `bandLength` stays `20`, so
`texture.tileMeters: 4` keeps dividing it evenly — a mid-session attempt to
shrink `bandLength` to `17` instead would have broken that (17 isn't
divisible by 4), putting a hard seam across the road every band boundary,
*without* even reducing draw calls (pool size is `bandsAhead + bandsBehind +
1`, independent of `bandLength`). Reverted in favour of the `bandsAhead`/
`bandsBehind` cut. 200m ahead now also matches terrain's own
`chunksAhead(5) × chunkLength(40)`, so road and terrain draw distance line
up. Visually checked by the project owner.

## Tree shadows: road-distance cutoff

`lighting.treeShadows.maxRoadDistance: 30` (lateral metres from
`roadCenterX`, evaluated at each tree's own z since the road curves). Near
trees already cast into `TreeShadowMask` up to `trees.lodCrossover` (180m) in
every direction; trees in the background scatter were paying
`TreeShadowMask.add`'s per-instance vector math every frame for a shadow that
never reaches ground the camera can see. `ScatterStreamer.ts`'s
shadow-emission loop now skips a tree before that call if
`|treeX - roadCenterX(treeZ)| > maxRoadDistance`. Does not change draw
count — `TreeShadowMask` is always exactly one instanced draw regardless of
caster count — this is a CPU-side cut only. Not yet visually verified against
the treeline at the cutoff distance.

## Non-performance tuning this session

These are visual/gameplay changes made alongside the performance work above,
recorded here because they touch the same config and interact with it —
not because they're optimizations.

- **`camera.fov: 70 → 68`.**
- **`terrain.mountains.amplitude: 30 → 10`** (peak height above the hills).
- **`terrain.mountains.distanceStart: 38 → 0`**,
  **`distanceFull: 105 → 30`** (how far from the road mountains start rising
  / reach full height). The OLD `distanceFull: 105` exceeded even the
  original square `chunkSize: 40` terrain's best-case coverage
  (`chunksWide(4) × 40 / 2 = 80m`), so mountains could never have reached
  full strength even before the width/length split — dead config regardless
  of the later narrowing. The new `distanceFull: 30` sits comfortably inside
  the current `chunkWidth`-derived 60m half-width, so this now actually
  resolves.
- **`sky.clouds.minElevation: 6 → 7.2`, `maxElevation: 24 → 28.8`** (both
  +20%, on request). **Unresolved:** the camera's documented visible
  elevation ceiling is +25° (fixed -8.8° pitch, now 68° vertical FOV per the
  `camera.fov` change above — a touch narrower than the 68° the comment
  already assumed, so the ceiling is close to but not exactly re-derived).
  `maxElevation: 28.8` sits above that ceiling, so cloud instances rolled
  into the 25-28.8° slice of the band render off the top of frame — thinning
  cover near the top of the sky rather than actually moving it up. Not yet
  checked visually.

## Open items

- Re-profile draw calls / FPS against the current config — the numbers above
  are computed from formulas, not measured, and several tuning changes have
  stacked since the last real capture.
- Terrain lateral coverage vs. view frustum at `chunkWidth: 30` — check for a
  visible edge at the horizon.
- Cloud `maxElevation: 28.8` vs. the ~25° visible ceiling — check for visible
  thinning near the top of frame.
- Tree shadow cutoff (`maxRoadDistance: 30`) — check the treeline doesn't
  visibly lose its shadow too close to the road.
- Tree density noise (`trees.densityCutoff: 0.42`, `densityFrequency: 0.012`)
  produces genuine tree-free patches on flat ground by design (wavelength
  ~524m, independent of slope) — now more visible than before because the
  narrower terrain corridor leaves less lateral room to still be in a dense
  patch off to the side of a clearing. Not changed; flagged during
  investigation of "trees missing on flat terrain."
