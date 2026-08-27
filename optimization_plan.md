# Mobile Optimization Plan

## Current finding

The reported scene cost is roughly 180K triangles and ~14 FPS on mobile. The new FBX vehicles are a major contributor, but they do not account for all of that count on their own.

At the configured maximum of 16 live traffic vehicles plus the SportCar2 player, vehicles account for **77,042 triangles**. At the beginning of a run, the eight seeded traffic vehicles plus the player account for **41,705 triangles**.

The more urgent vehicle issue is draw calls: each FBX is split into many mesh/material groups, so every visible vehicle costs 33–40 draw calls.

## Vehicle measurements

| Vehicle | Triangles each | Meshes | Draw calls each | Wheel triangles |
|---|---:|---:|---:|---:|
| SportCar2 | 3,732 | 8 | 33 | 1,360 |
| Sedan1 | 4,339 | 10 | 33 | 1,584 |
| Car2 | 5,426 | 8 | 38 | 2,608 |
| Jeep2 | 4,782 | 8 | 40 | 2,544 |
| MicroBus4 | 3,987 | 9 | 38 | 1,392 |

Wheel geometry is 35–53% of a vehicle's triangles. Car2 and Jeep2 are the best candidates for wheel simplification.

## Maximum visible traffic cost

The fixed traffic pool's type schedule is eight Sedans, three Car2s, three Jeeps and two MicroBuses.

| Visible vehicles at pool maximum | Triangles | Draw calls |
|---|---:|---:|
| 8 × Sedan1 | 34,712 | 264 |
| 3 × Car2 | 16,278 | 114 |
| 3 × Jeep2 | 14,346 | 120 |
| 2 × MicroBus4 | 7,974 | 76 |
| 1 × SportCar2 player | 3,732 | 33 |
| Total | **77,042** | **607** |

Inactive pooled vehicles are hidden, so `maxAlive` only costs rendering time when those slots are active and visible.

## Other scene costs

| System | Approximate maximum triangles | Notes |
|---|---:|---|
| Terrain | 27,648 | 36 streamed chunks × 768 triangles |
| Road | 432 | Low impact |
| Road dashes and posts | 1,368 | Low impact |
| Sky dome | ~960 | Low impact |
| Near trees | Up to ~29K | Depends on live placements and LOD |
| Far tree impostors | 2 per tree | Low triangle cost |

The performance HUD reports one aggregate triangle count, so it cannot yet attribute the remaining cost above the known vehicle/terrain/tree totals. The tree-shadow mask and material transmission can also hurt frame time without being reflected meaningfully in that count.

## Recommended order

### 1. Merge static vehicle meshes by material

Each vehicle currently has 33–40 draw calls despite using only three visual material classes: `PixelColors`, `Glass` and `Headlights`. Merge static parts per material after loading, reducing each vehicle to roughly three draw calls. This preserves the current model detail and is the highest-value change for mobile CPU/GPU submission overhead.

**Status: complete.** `VehicleModels` now prepares each FBX once as three shared static geometries and creates one mesh per material class for each player/traffic visual. Triangle count is unchanged; the full vehicle set's worst-case draw-call cost falls from about 607 to about 51.

### 2. Add traffic LOD

Render the full FBX only close to the player. Beyond roughly 60–100 metres, use a simplified vehicle mesh or billboard; those cars are already fogged and their fine mesh detail is not readable. This reduces both triangles and draw calls where most traffic sits.

### 3. Simplify wheel geometry

Use lower-sided tyre/rim meshes, especially for Car2 and Jeep2. Wheels are up to half of a model's triangles, so this can materially reduce vehicle cost with little visible loss at gameplay camera distance.

### 4. Disable glass transmission for a mobile quality tier

The glass has few triangles but uses `MeshPhysicalMaterial` transmission. Transmission can require expensive screen-space work. A dark transparent `MeshStandardMaterial`, or physical glass with `transmission: 0`, should retain the look closely while improving mobile GPU time.

### 5. Cap active traffic when gameplay permits

Lowering `traffic.maxAlive` to 8 limits peak vehicle rendering to the seeded traffic count. This changes traffic density and should be play-tested, but is a simple high-impact quality setting.

### 6. Lower tree-shadow mask resolution on low-end devices

The 1024×1024 tree-shadow mask is rendered every frame. Reducing it to 512×512 cuts its fill work and GPU memory to one quarter. This affects shadow sharpness, not the triangle HUD number.

### 7. Reduce projected-shadow casters on low-end devices

Lower `lighting.projectedShadows.maxCasters` from 6 to 3–4. This reduces the per-fragment shadow loop on receivers. It does not reduce triangle count, but it can improve fragment-shader time.

## Suggested first mobile tier

1. Merge vehicle meshes by material.
2. Disable glass transmission.
3. Keep full FBX only near the player and introduce a far traffic LOD.
4. Measure again before reducing vehicle count or visual density.

This sequence should improve FPS while preserving the current number of cars and the game’s visual density.
