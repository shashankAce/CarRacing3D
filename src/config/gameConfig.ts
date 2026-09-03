/**
 * gameConfig — THE reskin surface.
 *
 * Every tunable number, colour and label in this game lives here. Nothing
 * else in `src/` should hold a magic number: a reskin for a new B2B client
 * must be an edit to this file and nothing else. See ARCHITECTURE.md §8.
 *
 * ── Axis convention (fixed for the whole project) ─────────────────────────
 *   +X = right, +Y = up, **-Z = forward** (the direction the car drives).
 *   This matches Three.js's default camera orientation, so a camera placed
 *   at +Z behind the car needs no exotic setup.
 *
 *   A `travelled` scalar (metres since start) grows as the car advances. A
 *   world object at absolute `worldZ` is rendered at `z = travelled - worldZ`,
 *   so the car itself always renders at z ≈ 0 and no coordinate ever grows
 *   without bound in the render transform. See ARCHITECTURE.md §5.1.
 *
 * All distances are metres, all angles radians, all times seconds.
 */
export const gameConfig = {

    /** Design resolution. Portrait — see ARCHITECTURE.md §6 D4. */
    design: {
        width: 720,
        height: 1280,
    },

    /** Shared colours; biome-specific terrain and sky palettes are in `environments`. */
    colors: {
        // NOTE: there is no `sky` or `fog` colour here on purpose. Both are
        // DERIVED from the sky dome's own horizon, which the shader warms toward
        // `sky.horizonSunsetColor` as the sun drops — so a hand-set fog colour
        // matches only at one sun angle and shows a seam at every other. See
        // `SkyDome.effectiveHorizonColor`.
        road: 0x3c3c44,
        // road: 0x777778,
        roadLine: 0xe8e4cf,
        car: {
            body: 0xe14b3c,
            cabin: 0x27384f,
        },
    },

    /** Environment sequencing metadata; visual values live in the blocks below. */
    environment: {
        default: 'forest',
        /**
         * Alternates biomes along absolute travel distance. The solid lengths
         * exclude the blend on either side, so a cycle is:
         * forest -> transition -> desert -> transition -> repeat.
         */
        cycle: {
            enabled: true,
            /** Metres of fully forest terrain before it starts drying out. */
            forestLength: 640,
            /** Metres of fully desert terrain before vegetation returns. */
            desertLength: 640,
            /** Metres used by each smooth forest/desert cross-fade. */
            transitionLength: 160,
        },
    },

    /** Runtime-selectable colour palettes. Terrain shape lives in `terrain.presets`. */
    environments: {
        forest: {
            terrain: {
                low: 0x6a874d,
                high: 0xb7b562,
                dirt: 0x7a4f2a,
                rock: 0xd3ad89,
            },
            sky: {
                zenith: 0x4a94b8,
                zenithLow: 0x4a3a78,
                horizon: 0x7fc2ea,
                horizonLow: 0xef8f52,
                glow: 0xfff2c8,
            },
        },
        desert: {
            terrain: {
                low: 0xb9783e,
                high: 0xe2b86f,
                dirt: 0xa65f32,
                rock: 0x8c6047,
            },
            sky: {
                zenith: 0x62a6c8,
                zenithLow: 0x684b75,
                horizon: 0xe5c58f,
                horizonLow: 0xf28b4b,
                glow: 0xffe0a3,
            },
        },
    },

    /**
     * Road geometry. `halfWidth` is the lateral clamp on the player, the width
     * of the asphalt ribbon, AND the half-width of the corridor the terrain
     * height field flattens — one number, so they can never disagree.
     */
    road: {
        halfWidth: 7,
        /** Painted edge line width, each side, inside `halfWidth`. */
        lineWidth: 0.25,
        /** Base world Y of the road surface, before `slopeAmplitude`. */
        level: 0,
        /** How far past the edge the terrain takes to reach ambient height. */
        shoulderWidth: 7,
        /**
         * Lateral sway of the road centreline, metres. Every consumer — height
         * field, asphalt ribbon, markers, the car's own position, and later
         * traffic lanes — reads the same `roadCenterX(z)`, so they cannot
         * disagree. Set to 0 for a dead-straight road. See §5.2.
         *
         * Keep the wavelength (2π / frequency) well under the visible road
         * distance or the bend is imperceptible — see the note in roadPath.ts.
         * At 0.018 the wavelength is ~350m, which at this amplitude peaks at
         * ~8.4m of lateral shift across the visible 200m — a clearly visible
         * bend.
         *
         * BALANCE: the sharpest road heading must remain reachable by
         * `car.steering.maxYawAngle`. The car's lateral movement is derived from
         * that yaw, so there is no independent sideways-speed limit to tune.
         */
        curveAmplitude: 8,
        curveFrequency: 0.018,
        /**
         * Vertical crests and dips, metres. Same deal as the curve: one
         * function (`roadLevelAt(z)`) that the height field, ribbon, dashes and
         * car Y all read. Still much longer-wavelength than the terrain — a road
         * undulating as fast as the hills reads as a rollercoaster — but not so
         * long that it flattens out: these values peak at ~7m of rise across
         * the visible 200m at a 10.5% max grade, which is a steep-but-real
         * highway. The first attempt (3.5 / 0.008) was a 785m wavelength and
         * managed 1.7m of visible rise, i.e. invisible.
         */
        slopeAmplitude: 5.0,
        slopeFrequency: 0.016,
    },

    /**
     * Terrain streaming. A rolling window of chunks is recycled around the car;
     * chunk geometry is rebuilt into pre-allocated buffers, so driving allocates
     * nothing. See ARCHITECTURE.md §5.3 — chunk rebuild cost is the main
     * frame-spike risk in this game, which is what `maxBuildsPerFrame` bounds.
     */
    terrain: {
        /**
         * Chunk size, metres, split by axis rather than one square `chunkSize`.
         * Lateral (X) view is short — portrait FOV is only ~42°, so sideways
         * coverage needed is far less than the forward draw distance — while
         * depth (Z) has to reach as far as the fog does. Independent knobs let
         * the lateral window shrink (fewer chunks-wide, or a narrower
         * `chunkWidth`) without shrinking how far ahead the road is built.
         * Every piece of terrain math that used to assume a square chunk
         * (normal differencing in `chunkMesh.ts`, the self-shadow lattice in
         * `terrainShadow.ts`, the road-corridor margin in `heightField.ts`, tree
         * placement in `ScatterStreamer.ts`) now takes both axes separately.
         * Both were 40 — the old square size — until tuned to the values below;
         * narrower than `chunksAhead × chunkLength`'s ~42°-FOV coverage
         * requirement needs is a real risk here, not just a hypothetical — see
         * the `chunksWide` comment below.
         */
        chunkWidth: 30,
        chunkLength: 40,
        /** Vertices per chunk edge. Cost scales with the square of this. */
        resolution: 17,
        /**
         * Chunks across, centred on the road. Must cover the view frustum at
         * the far edge or you see the terrain's lateral boundary: in portrait
         * the horizontal FOV is only ~42°, so the view is ±106m wide at 280m.
         * KEEP THIS EVEN — chunks are indexed by their min corner, so an even
         * count straddles x=0 and an odd one sits lopsided.
         */
        chunksWide: 4,
        /**
         * Draw distance, in chunks. Derived FROM `world.fogDensity` and
         * `world.fogFalloff`, not chosen independently: the spawn edge has to be
         * far enough out that fog hides essentially all of it, or chunks visibly
         * pop into view. At the current curve fog hides 64% at 160m, 92% at
         * 200m, 99.5% at 240m and 99.99% at 280m. 7 chunks = 280m.
         *
         * There is SPARE HEADROOM here now: full occlusion (0.5% residual)
         * arrives at 241m, so 6 chunks would very nearly do. That is the first
         * place to look if chunk builds or draw calls need trimming — but
         * re-derive it if the fog changes, and note 240m sits exactly on the
         * threshold rather than comfortably past it.
         *
         * This does NOT raise the chunk build RATE, which is set by
         * speed / chunkLength — one row per `chunkLength` metres travelled
         * however far ahead it sits. It costs resident memory and triangles
         * only.
         */
        chunksAhead: 5,
        chunksBehind: 1,
        /**
         * Depth of the downward wall hung off each chunk's border, hiding any
         * crack between neighbours. Unnecessary while every chunk is the same
         * resolution, but it's what makes the Phase 7 LOD tiers a drop-in.
         */
        skirtDepth: 5,
        /** Hard cap on chunk rebuilds per frame — the anti-hitch dial. */
        maxBuildsPerFrame: 1,

        /** Biome-specific terrain shape; streaming settings above stay shared. */
        presets: {
            forest: {
                /** Existing forest values — intentionally preserved. */
                amplitude: 5.5,
                baseFrequency: 0.045,
                mountains: {
                    amplitude: 10,
                    regionFrequency: 0.0035,
                    threshold: 0.5,
                    thresholdBand: 0.18,
                    ridgeFrequency: 0.010,
                    ridgeSquash: 1.65,
                    sharpness: 2.2,
                    distanceStart: 0,
                    distanceFull: 30,
                    baseSuppression: 0.65,
                },
                dirtSlopeStart: 0.20,
                dirtSlopeFull: 0.42,
                rockSlopeStart: 0.25,
                rockSlopeFull: 0.45,
                rockAltitudeStart: 12,
                rockAltitudeFull: 30,
            },
            desert: {
                /** Lower, wider undulations read as dunes instead of grassy hills. */
                amplitude: 3.2,
                baseFrequency: 0.024,
                mountains: {
                    /** Broad distant massifs, with no narrow alpine ridges. */
                    amplitude: 11,
                    regionFrequency: 0.0035,
                    threshold: 0.48,
                    thresholdBand: 0.28,
                    ridgeFrequency: 0.006,
                    ridgeSquash: 0.75,
                    sharpness: 1.05,
                    distanceStart: 15,
                    distanceFull: 60,
                    baseSuppression: 0.45,
                },
                /** Keep ordinary desert ground sandy until a genuinely steep face. */
                dirtSlopeStart: 0.48,
                dirtSlopeFull: 0.82,
                rockSlopeStart: 0.95,
                rockSlopeFull: 1.40,
                rockAltitudeStart: 45,
                rockAltitudeFull: 75,
                /** Directional ripples left in the sand by prevailing wind. */
                windPattern: {
                    enabled: true,
                    height: 0.24,
                    colorStrength: 0.12,
                    frequency: 0.72,
                    warpFrequency: 0.045,
                    warp: 1.15,
                    direction: { x: 0.94, z: 0.34 },
                },
            },
        },

        /**
         * TERRAIN THAT SHADOWS ITSELF — hills shading the ground behind them,
         * mountains laying shadow down their own flanks.
         *
         * This is not the same feature as `lighting.projectedShadows` or
         * `lighting.treeShadows`, and neither of those does this: the terrain
         * mesh has never been a shadow CASTER under either. Those two handle
         * the car, traffic and trees falling onto other surfaces; this
         * handles the ground shading itself.
         *
         * It is baked into the vertex colour at chunk build time, so it costs
         * nothing per frame — no draw call, no render target, no texture, no
         * bundle bytes. The entire price is chunk build time, which is the one
         * budget in this game with very little slack (`maxBuildsPerFrame` is 1).
         * Watch `build/peak/all` on the perf HUD after changing anything here;
         * the numbers that matter are documented in `terrainShadow.ts`.
         *
         * BAKED MEANS BAKED: the shade is locked to the light direction at the
         * moment each chunk was built. That is sound only because the hour is
         * fixed at boot and never advances. If time is ever animated, every
         * resident chunk has to be rebuilt on a change.
         */
        selfShadow: {
            enabled: false,
            /**
             * How dark a fully occluded vertex gets: albedo is multiplied by
             * `1 - strength`. Deliberately well short of black — the ground in
             * shadow still sees the sky, and this term cannot represent that.
             */
            strength: 0.45,
            /**
             * How far to look for an occluder, metres. Derived, not picked: a
             * mountain is `mountains.amplitude` 30m above the hills, and at the
             * clamp elevation below it throws 30/tan(6 deg)... far more than
             * this. 70m is the useful compromise — it catches every hill shadow
             * and the near half of a mountain's, and the far half is deep in
             * fog anyway. Cost is flat in this value; only `steps` costs.
             */
            reach: 70,
            /**
             * March samples per lattice point. THE COST DIAL — total height-field
             * evaluations per chunk are `steps * (chunkWidth/gridStep + 1) *
             * (chunkLength/gridStep + 1)`, and the existing build already spends
             * 361 of them. Distances ramp quadratically, so raising this refines
             * the near end most.
             */
            steps: 5,
            /**
             * Lattice spacing for the march, metres. MUST DIVIDE both
             * `chunkWidth` AND `chunkLength` exactly, or chunk edges stop sharing
             * sample points with their neighbours and seams appear;
             * `makeShadeGrid` warns if it doesn't. Cost scales with the inverse
             * SQUARE of this, so 5 -> 2.5 is 4x.
             */
            gridStep: 5,
            /**
             * Shadow edge softness, as a dimensionless slope (occluder height
             * over distance). Not an attempt at a real penumbra — it is what
             * keeps the coarse lattice from producing a stair-stepped edge.
             * 0.06 is about 3.4 degrees.
             */
            softness: 0.06,
            /**
             * Floor on the light elevation used for the march, degrees. At a
             * true sunset elevation shadows run for hundreds of metres, so a
             * 70m reach sees only their near ends and the terrain reads as
             * blotches rather than shadows. Clamping keeps them long but
             * bounded, and keeps the look continuous across the sun/moon
             * handover rather than popping.
             */
            minElevationDegrees: 6,
        },

    },

    /**
     * Traffic. Vehicles travel the SAME direction as the player, slower, so the
     * game is about weaving through and overtaking rather than head-on dodging.
     *
     * `laneCount` positions traffic only — the player still moves freely across
     * the road (§6 D2) rather than snapping between lanes.
     */
    traffic: {
        /** QA mode: keep the seeded traffic in place for close shadow inspection. */
        frozen: false,
        laneCount: 4,
        /** Ceiling on live vehicles; the pool is allocated to exactly this. */
        maxAlive: 5,
        /**
         * Fixed traffic pool, in spawn/recycle slot order. Keep this list the
         * same length as `maxAlive`; names must match an entry in `types`.
         */
        pool: ['sedan', 'coupe', 'coupe', 'microbus', 'sedan'],
        /**
         * Distant traffic keeps the same complete vehicle, but uses reduced
         * geometry. Tune or disable this entirely from this block.
         */
        lod: {
            enabled: true,
            /** True 3D distance from the player at which the full FBX appears. */
            fullDetailDistance: 190,
        },
        /**
         * Where new vehicles appear, metres ahead of the player. Far enough that
         * they emerge from the fog with time to react, and inside the terrain
         * draw distance so they never hang in empty space.
         */
        spawnAhead: 210,
        /** Recycled once this far behind the player. */
        despawnBehind: 15,
        /**
         * Also recycled once this far AHEAD. Required, not symmetry for its own
         * sake: any vehicle faster than the player recedes forever and, with
         * only a behind-test, would hold its pool slot for the rest of the run
         * until no new traffic could spawn at all. Every type below is slower
         * than `speed.start`, so this should never fire — it's the backstop for
         * a reskin that raises a traffic speed above the player's opening pace.
         */
        despawnAhead: 210,
        /**
         * Vehicles placed across the road at the start of a run, and the nearest
         * one's distance. Without seeding, the first encounter is governed by
         * closing speed from `spawnAhead`, which at the start of the ramp is
         * ~26 seconds — longer than a whole run, so the player would see nothing
         * to dodge. Seeded, the first cut lands around 129m, about 5 seconds in.
         */
        seedCount: 8,
        seedMinAhead: 28,
        /**
         * Player-travel distance between spawn attempts, eased from the first
         * value at `speed.start` to the second at `speed.max`. Shrinking it with
         * speed is what makes the run get harder.
         *
         * Set from a simulation of ~160km per configuration with a greedy driver
         * AI, counting crashes and — more importantly — crashes where NO lateral
         * position on the road was safe:
         *
         *   62 -> 34 :  1.63 crashes/km, 3 unavoidable
         *   78 -> 46 :  1.10 crashes/km, 0 unavoidable   <- here
         *   95 -> 58 :  0.79 crashes/km, 0 unavoidable
         *
         * The tighter setting is fair 98.8% of the time, which is not good
         * enough: in a playable ad an unavoidable death is the one thing that
         * stops a player retrying. A run lasts roughly 900m here.
         */
        spawnGapSlow: 78,
        spawnGapFast: 46,
        /** A lane is unavailable if it holds a vehicle within this of the spawn point. */
        minLaneGap: 34,
        /**
         * Lanes that must stay clear near a spawn, so a wall of traffic is much
         * less likely to form.
         *
         * This alone cannot GUARANTEE it — vehicles travel at different speeds,
         * so they rearrange into new formations long after spawning, and
         * simulation found full-width walls forming at ~0.05/km with this guard
         * in place. A dynamic guard (scan ahead, nudge one vehicle's speed to
         * open a gap) was prototyped in simulation and dropped: at the spawn gap
         * below there are ZERO unavoidable deaths across 160km without it, and
         * transient walls that dissolve before the player arrives are harmless.
         * Bring it back only if real play shows otherwise.
         */
        minFreeLanes: 2,
        /** Radius around a spawn point checked against `minFreeLanes`. */
        freeLaneCheckRange: 26,
        /**
         * Overtaking. Traffic has mixed speeds, so a faster vehicle WILL catch a
         * slower one in its lane — and with no traffic-vs-traffic collision it
         * simply drove through it.
         *
         * Both halves of the fix are needed. Changing lanes handles the common
         * case; slowing to match handles being boxed in, and without it a
         * blocked vehicle still overlaps the one ahead.
         */
        overtake: {
            /** How far ahead a vehicle notices a slower one in its lane. */
            lookahead: 85,
            /** Inside this gap it commits: change lanes, or slow to match. */
            safeGap: 40,
            /** Seconds of indicator before the move starts. Signal, then act. */
            signalTime: 0.9,
            /** Indicator blinks per second. */
            blinkHz: 2.5,
            /** Lanes per second during the change. */
            laneChangeSpeed: 0.85,
            /** Maximum body yaw added while crossing into another lane. */
            laneChangeMaxYaw: 0.24,
            /** How quickly the body turns into and straightens after a lane change. */
            laneChangeYawResponse: 8,
            /**
             * Required clear gap in the target lane, ahead of and behind the
             * mover. Traffic checks the swept relative gap through signalling
             * and crossing, and reserves the destination lane once committed.
             * This pair is the whole balance, measured over 108km of simulation
             * per setting:
             *
             *   34/20 : 0 overlaps, 0.15 lane changes/km — vehicles almost
             *           always resolved by slowing instead, so the indicator
             *           was effectively never seen
             *   22/12 : 0 overlaps, 0.75/km   <- here
             *   18/10 : 27 overlap frames, up to 0.88m of interpenetration
             *
             * One notch looser than this and vehicles clip each other again.
             */
            minGapAhead: 22,
            minGapBehind: 12,
            /** m/s² used to converge on a blocker's speed, and to recover after. */
            matchRate: 9,
            /** Additive blink laid over the exact red tail-light UV surfaces. */
            indicatorColor: 0xffffff,
            indicatorOpacity: 1,// 0-1
            /** RGB brightness multiplier; values above 1 intensify the additive glow. */
            indicatorGlowStrength: 2.5,
        },

        /**
         * Vehicle types. `weight` is relative spawn probability.
         *
         * EVERY speed here must stay below `speed.start` (22 m/s). The game is
         * built on the player overtaking: a vehicle faster than the player is
         * never passed, never scores, and just recedes. The first pass had them
         * at 20-36 m/s, which meant most traffic outran the opening pace and the
         * road ahead emptied out.
         *
         * Closing speed therefore runs from ~1 m/s at the start of the ramp to
         * ~54 m/s against a bus at top speed. That spread is inherent to a 3x
         * speed ramp, and it's what makes late-run traffic genuinely dangerous.
         */
        types: [
            { name: 'sedan', model: 'sedan', width: 2.12, height: 1.30, length: 4.60, speedMin: 17, speedMax: 21, weight: 5 },
            { name: 'coupe', model: 'car', width: 1.92, height: 1.34, length: 4.20, speedMin: 19, speedMax: 26, weight: 3 },
            { name: 'jeep', model: 'jeep', width: 2.26, height: 1.80, length: 4.23, speedMin: 14, speedMax: 18, weight: 3 },
            { name: 'microbus', model: 'microbus', width: 2.16, height: 2.08, length: 4.86, speedMin: 12, speedMax: 15, weight: 2 },
        ],
    },

    /**
     * Scoring. Distance is the base; cutting past traffic is the skill bonus.
     *
     * Every overtake counts as one cut — that IS the game's stated goal ("cut
     * traffic as long as it can"), and a separate proximity-gated "near miss"
     * tier was dropped as complexity Phase 4 doesn't need. Add it back as a
     * second counter if the metric needs more texture.
     */
    scoring: {
        /** Score per vehicle cut. */
        cutBonus: 50,
    },

    /**
     * The asphalt ribbon, streamed in bands so it can follow a curving road.
     *
     * `bandsAhead * bandLength` must reach past the terrain's own draw edge, or
     * the road ends in mid-air before the ground does — and dark asphalt against
     * pale fog is the most conspicuous thing in the scene to pop in.
     */
    roadSurface: {
        bandLength: 20,
        bandsAhead: 11,
        bandsBehind: 1,
        /** Z-subdivisions per band. Only matters when `curveAmplitude` is non-zero. */
        segmentsPerBand: 4,
        /** Lift above `road.level` — coplanar surfaces z-fight. */
        lift: 0.02,
        /**
         * Asphalt surface, generated at boot — see `procedural/roadTexture.ts`.
         *
         * `tileMeters` MUST divide `bandLength` evenly. UVs are local to a 20m
         * band and every recycled band carries identical ones, so a tile length
         * that does not divide cleanly puts a hard line across the road every
         * band boundary.
         */
        texture: {
            size: 128,
            /** World metres per texture repeat. 4 divides bandLength 20 exactly. */
            tileMeters: 4,
            /**
             * Fine aggregate depth. 0.10 gives roughly the reference's 5%
             * modulation (sd 5.24/255 on a mean of 99). The first pass used 0.22
             * with a one-sided clamp down to 0.45, i.e. ~20x the reference's
             * contrast, which read as noise painted on rather than as asphalt.
             */
            grain: 0.32,
            /**
             * Faint lengthwise streak. Nearly zero on purpose: the reference's
             * horizontal and vertical gradients differ by only 4%, so asphalt is
             * essentially isotropic and the earlier 4:1 stretch was a guess that
             * the measurement did not support.
             */
            streak: 0.12,
        },
        /**
         * A LITTLE metallic, which only works because the road gets an
         * environment map (`procedural/skyEnv.ts`). Metalness drives diffuse to
         * zero and reflects the environment instead, so without one this would
         * render the road nearly black rather than glossy. 0.18 is enough for
         * the asphalt to pick up the sky and go slightly cooler in the distance,
         * which is what the reference's road does; much more and it stops
         * reading as a surface at all.
         */
        metalness: 0.10,
        /** Down from 0.88, for a visible specular lobe from the sun. */
        roughness: 0.78,
        /** Sky reflection strength. Below 1 because asphalt is not a mirror. */
        envIntensity: 0.35,
    },

    /**
     * Fuel — the reason a run ends even when the player never crashes.
     *
     * Drains by TIME, not by distance. That is the whole point: with a constant
     * per-second burn, distance per tank is maximised by going fast, so the
     * player is pushed to rush. Draining per metre would make speed neutral, and
     * draining by throttle would reward coasting — the opposite of the intent.
     */
    fuel: {
        /** Seconds of fuel in a full tank. The main dial on run length. */
        capacity: 55,
        /** Fraction remaining at which the gauge turns to the warning colour. */
        warnAt: 0.25,
    },

    /** One bottom-centre virtual joystick for steering, gas, and brake. */
    controls: {
        /** Vertical centre in the Y-up design space; X follows the live screen centre. */
        centerY: 175,
        /** Visible gate, thumb knob, movement limit, and forgiving hit radius. */
        baseRadius: 104,
        knobRadius: 43,
        travelRadius: 62,
        touchRadius: 135,
        /** Per-axis travel ignored, preventing thumb drift on the other axis. */
        deadZone: 0.22,
        strokeWidth: 5,
        baseColor: '#17232a66',
        baseStrokeColor: '#f2f6f899',
        knobColor: '#f2f6f8cc',
        knobStrokeColor: '#ffffffdd',
        pressedColor: '#ffd24add',
        knobPressedColor: '#ffd24aee',
    },

    /** Small in-game button used to swap the active environment. */
    environmentToggle: {
        labels: { forest: 'FOREST', desert: 'DESERT' },
        width: 180,
        height: 64,
        edgeMargin: 22,
        y: 1190,
        fontSize: 18,
        color: '#fff3d2',
        pressedColor: '#ffd05a',
        prefix: 'BIOME',
    },

    /** Browser fullscreen toggle; fullscreen itself must begin from a user tap. */
    fullscreenButton: {
        size: 72,
        backgroundRadius: 32,
        edgeMargin: 22,
        fontSize: 34,
        strokeWidth: 3,
        enterGlyph: '⛶',
        exitGlyph: '✕',
        color: '#f2f6f8',
        pressedColor: '#ffd24a',
        backgroundColor: '#17232a99',
        pressedBackgroundColor: '#5b4b18cc',
        strokeColor: '#f2f6f8aa',
    },

    /** Premium, tactile overlays shared by the pause and end-of-run screens. */
    overlays: {
        backdropColor: '#0e0e0ee0',
        panelColor: '#1b1c1cf4',
        panelStroke: '#87abe54d',
        panelShadow: '#00000066',
        surfaceColor: '#e5e2e1',
        mutedColor: '#ddc1ae',
        orange: '#ff8c00',
        orangeShelf: '#904d00',
        green: '#2e4d36',
        greenShelf: '#183721',
        neutral: '#353535',
        neutralShelf: '#1f2020',
        buttonText: '#17110a',
        fontFamily: 'Arial, sans-serif',
        panelWidth: 450,
        panelRadius: 26,
        buttonHeight: 82,
        buttonRadius: 16,
        buttonShelf: 7,
        buttonGap: 30,
        pause: {
            title: 'PAUSED',
            icon: 'Ⅱ',
            titleY: 770,
            panelY: 650,
            panelHeight: 560,
            resumeY: 666,
            restartY: 562,
            menuY: 458,
            iconRadius: 32,
            iconStrokeWidth: 2.5,
            iconFontSize: 40,
            titleFontSize: 40,
            buttonFontSize: 23,
            linkFontSize: 17,
            resumeText: '▶  RESUME',
            restartText: '↻  RESTART RUN',
            mainMenuText: 'CHANGE CAR',
        },
        gameEnd: {
            // Cinematic backdrop gradient (reference: reference/design/gameend) — dark
            // near the top and bottom edges, transparent through the middle, so the
            // crashed scene stays visible behind the message instead of a flat scrim.
            backdropTop: '#0e0e0ee6',
            backdropMid: '#0e0e0e00',
            backdropBottom: '#0e0e0ef2',
            backdropTopStop: 0.34,
            backdropBottomStop: 0.62,

            // The reference's hero headline — kept verbatim as the emotional hook that
            // pulls the player into another run; the crash reason/stats sit below it.
            headline: 'HOW\nFAR CAN\nYOU\nDRIVE?',
            headlineY: 800,
            headlineFontSize: 150,

            reasonY: 954,
            statsY: 898,
            reasonFontSize: 32,
            statsFontSize: 22,
            statsLetterSpacing: 2,

            buttonY: 300,
            brandY: 168,
            taglineY: 112,
            buttonFontSize: 27,
            brandFontSize: 34,
            brandLetterSpacing: 4,
            taglineFontSize: 15,
            taglineLetterSpacing: 3,

            replayText: 'RACE AGAIN  ▶',
            brand: 'FAST LANE',
            tagline: 'ENDLESS RACING ADVENTURE',
        },
        pauseButton: {
            size: 68,
            radius: 28,
            edgeMargin: 22,
            fontSize: 27,
            glyph: 'Ⅱ',
            color: '#e5e2e1',
            background: '#1b1c1ce6',
            stroke: '#87abe566',
            pressed: '#ffb77d',
        },
    },


    /**
     * Scrolling road markers. On a flat placeholder world these are the only
     * thing that conveys motion, and they exercise the world-scroll maths that
     * Phase 3's terrain streamer will reuse.
     *
     * Each set wraps with a modulo over `spacing * count`, so `count` sets both
     * the draw distance and the recycle period — no pooling bookkeeping.
     */
    markers: {
        /** Fraction of the wrap span that sits ahead of the car; the rest trails behind. */
        aheadFraction: 0.85,
        /**
         * Dashed centre line. `spacing` is a direct perceived-speed dial:
         * closer dashes stream past faster at the same m/s.
         */
        dash: {
            spacing: 6,
            count: 50,
            width: 0.22,
            length: 3.0,
        },
        /** Roadside posts — the strongest speed cue, because they pass close by. */
        post: {
            spacing: 10,
            count: 32,
            width: 0.18,
            height: 1.2,
            /** Lateral gap beyond the road edge. */
            offset: 1.0,
            color: 0xdedad0,
        },
    },

    hud: {
        /**
         * Performance counters — see `debug.showPerf`. Placed high, where the
         * frame is sky, so the readout never sits over the car.
         */
        perfY: 930,
        /**
         * 24, not larger: FIXED_HEIGHT means the design WIDTH shrinks on taller
         * phones — a 19.5:9 screen gives only ~591 design units — and the
         * longest line here is ~34 monospace characters.
         */
        perfFontSize: 24,
        /** Light: the top of the frame is the dome's deep-blue zenith. */
        perfColor: '#bfe8c9',
        /**
         * Seconds per sample window. Also the repaint interval. Has to be long
         * enough that the build RATE is meaningful: chunks arrive in rows of 6
         * roughly every 0.6s at top speed, so a 0.25s window reads 0/s most of
         * the time and a big number occasionally. One second is stable, and
         * `worst` still catches any spike inside it.
         */
        perfRepaintInterval: 1.0,
        /**
         * NOTE ON THE Y AXIS: node positions are Y-UP — y is measured from the
         * BOTTOM of the design space. So `hintY: 430` sits low on the screen and
         * `distanceY: 1195` sits at the very top.
         *
         * Don't be misled by `Display.js`'s "top-left origin, Y-down" comment:
         * that describes `screenToDesignInto`, the screen→design step of POINTER
         * conversion, which is a different space from node placement (pointer
         * events then go through `camera.screenToWorld`, landing back in Y-up
         * world coords).
         */
        distanceY: 1195,
        speedY: 1135,
        /**
         * Below the buttons rather than over the road: at mid-height it sat on
         * the car, and the band between the buttons and the game-over panel is
         * too narrow to hold it. Down here it also reads as a legend for the
         * controls it describes.
         */
        hintY: 45,
        /** Cars cut — the skill readout, so it sits with the distance. */
        cutsY: 1088,
        cutsFontSize: 30,
        cutsColor: '#ffd98a',
        /**
         * Fuel gauge, drawn as block glyphs in a monospace label. A real bar
         * would need a ColorRect and the `graphics` system, which auto-trim
         * strips from the build — not worth pulling a whole system in for one
         * rectangle. Phase 7 can revisit.
         */
        fuelY: 1035,
        fuelFontSize: 28,
        fuelColor: '#8de89b',
        fuelWarnColor: '#ff7a5c',
        fuelCells: 14,
        /** Game-over panel. */
        gameOverY: 760,
        gameOverFontSize: 76,
        gameOverColor: '#ffffff',
        gameOverText: 'CRASHED',
        outOfFuelText: 'OUT OF FUEL',
        summaryY: 670,
        summaryFontSize: 34,
        restartY: 570,
        restartFontSize: 30,
        restartText: 'TAP TO RESTART',
        restartColor: '#9fe8ff',
        distanceFontSize: 62,
        speedFontSize: 34,
        hintFontSize: 26,
        textColor: '#f4f9fb',
        hintColor: '#c9d9e2',
        hintText: '◀ ▶ STEER    ▲ GAS    ▼ BRAKE',
    },

    /**
     * Runtime vehicle catalog. All FBX assets use the same three Unity material
     * names; `VehicleModels` maps them to the settings below. The authored
     * meshes are hundreds of FBX units wide, hence the small per-model scales.
     * Runtime collision dimensions are measured from the FBX after this scale
     * is applied, so changing `scale` cannot leave a smaller collider behind.
     */
    vehicles: {
        paletteTexture: 'res/models/vehicles/PixelColors.png',
        /** The car pre-highlighted in the selection screen. */
        playerDefault: 'sport',
        /**
         * Test replacement wheel for every player and traffic FBX. The shape
         * mirrors tyre.html; dimensions are fitted to each source wheel's own
         * bounds, so only this block needs changing while the design is tuned.
         */
        testWheels: {
            enabled: true,
            tyreSegments: 20,
            tyreWidth: 0.62,
            rimSize: 0.55,
            fullDiameterBars: 5,
            barRotation: 0,
            barWidthFactor: 0.72,
            /** Temporary QA multiplier: slow enough to verify spin direction. */
            rotationSpeed: 0.25,
            tyreColor: 0x383838,
            spokeColor: 0xb7c1c9,
            roughness: 0.48,
            metalness: 0.42,
        },
        models: [
            // Player-only performance. Values are metres/second and m/s²;
            // traffic continues to use its independent `traffic.types` speeds.
            { id: 'sport', label: 'SPORT', description: 'Track-bred pace with instant response.', asset: 'res/models/vehicles/SportCar2.fbx', lod: { vertexReduction: 0.55 }, scale: 0.009, rotationY: Math.PI, width: 2.11, height: 1.24, length: 4.21, speed: { start: 30, min: 20, max: 120, accelerate: 8.2, brake: 16, autoBrake: 14 } },
            { id: 'sedan', label: 'SEDAN', description: 'Balanced, stable and easy to control.', asset: 'res/models/vehicles/Sedan1.fbx', lod: { vertexReduction: 0.55 }, scale: 0.01, rotationY: Math.PI, width: 2.12, height: 1.30, length: 4.60, speed: { start: 28, min: 18, max: 66, accelerate: 6.6, brake: 14, autoBrake: 11 } },
            { id: 'car', label: 'COUPE', description: 'Agile handling with strong acceleration.', asset: 'res/models/vehicles/Car2.fbx', lod: { vertexReduction: 0.60 }, scale: 0.011, rotationY: Math.PI, width: 1.92, height: 1.34, length: 4.20, speed: { start: 29, min: 19, max: 75, accelerate: 7.2, brake: 14, autoBrake: 13 } },
            { id: 'jeep', label: 'JEEP', description: 'Rugged, confident and ready for rough roads.', asset: 'res/models/vehicles/Jeep2.fbx', lod: { vertexReduction: 0.60 }, scale: 0.01, rotationY: Math.PI, width: 2.26, height: 1.80, length: 4.23, speed: { start: 25, min: 16, max: 54, accelerate: 5.0, brake: 12, autoBrake: 10 } },
            { id: 'microbus', label: 'MICRO BUS', description: 'Heavy, dependable and built for control.', asset: 'res/models/vehicles/MicroBus4.fbx', lod: { vertexReduction: 0.55 }, scale: 0.012, rotationY: Math.PI, width: 2.16, height: 2.08, length: 4.86, speed: { start: 22, min: 14, max: 47, accelerate: 4.2, brake: 10, autoBrake: 8 } },
        ],
        materials: {
            /** Car body paint (the pixel-colour palette texture covers the whole shell). */
            pixelColors: { roughness: 0, metalness: 0.5 },
            glass: { color: 0x333333, roughness: 0.12, metalness: 0.1, opacity: 0.545 },
            headlights: { color: 0xffd800, emissive: 0xffb000, emissiveIntensity: 3.5, roughness: 0.3 },
        },
    },

    /**
     * Optional, self-contained pre-race showroom. Set `enabled` false to skip
     * every showroom interaction and start directly with `vehicles.playerDefault`.
     */
    carSelect: {
        enabled: true,
        title: 'SELECT YOUR',
        titleAccent: 'RIDE',
        loadingText: 'LOADING CARS…',
        driveText: 'DRIVE THIS CAR',
        headerHeight: 100,
        titleMainX: -47,
        titleAccentX: 126,
        titleBaselineY: 0,
        arrowY: 650,
        arrowEdge: 28,
        arrowSize: 70,
        statsPanelTop: 158,
        statsPanelLeft: 28,
        statsPanelRight: 302,
        statsPanelMinimumRight: 22,
        statsPanelWidth: 390,
        statsPanelMinWidth: 275,
        statsPanelHeight: 300,
        carNameAccentX: 8,
        carNameAccentWidth: 7,
        carNameAccentRotation: -14,
        carNameX: 18,
        carNameY: -18,
        descriptionX: 0,
        descriptionY: -60,
        descriptionLineHeight: 23,
        statsFirstY: -150,
        statsGap: 64,
        statIconX: 23,
        statIconSize: 42,
        statLabelX: 57,
        statLabelOffsetY: 13,
        statBarX: 57,
        statBarWidth: 150,
        statBarMinWidth: 90,
        statBarHeight: 8,
        statBarOffsetY: -9,
        statValueRight: 2,
        statValueGap: 90,
        driveY: 105,
        driveWidth: 430,
        driveHeight: 92,
        driveCornerRadius: 10,
        driveShadowOffset: 7,
        driveShadowSpread: 14,
        titleFontSize: 35,
        carNameFontSize: 34,
        descriptionFontSize: 18,
        statFontSize: 14,
        statValueFontSize: 14,
        driveFontSize: 32,
        titleColor: '#ffffff',
        titleAccentColor: '#e2202e',
        descriptionColor: '#f0f3f6',
        headerGradientLeft: '#03070b',
        headerGradientCenter: '#0b2639',
        headerGradientRight: '#03070b',
        headerEdgeColor: '#2b394377',
        statLabelColor: '#f7f8fa',
        statValueColor: '#ffffff',
        statTrackColor: '#818080',
        statFillColor: '#e2202e',
        driveColor: '#ffffff',
        driveGradientTop: '#e2202e',
        driveGradientBottom: '#7e1219',
        driveStroke: '#4f0b10',
        driveShadowColor: '#00111dcc',
        stats: {
            speedLabel: 'TOP SPEED',
            accelerationLabel: 'ACCELERATION',
            brakingLabel: 'BRAKING',
            maxSpeedKph: 440,
            maxAcceleration: 9,
            maxBraking: 18,
        },
        showroom: {
            layer: 1,
            background: 0x03070d,
            camera: {
                fov: 42,
                minFov: 34,
                maxFov: 72,
                /** Keeps roughly 20% clear breathing room on both screen sides. */
                fitPadding: 1.38,
                /** Extra framing only for unusually long/tall vehicle silhouettes. */
                fitOverrides: { microbus: 1.18 } as Record<string, number>,
                /** Keeps tall vehicles centred vertically instead of aiming near their wheels. */
                vehicleCenterHeightFactor: 0.5,
                /** Moves the framing upward so the car appears lower without changing camera angle. */
                compositionOffsetY: 1.5,
                fovResponse: 7,
                near: 0.1,
                far: 60,
                position: { x: 6.2, y: 3.2, z: 11.4 },
                target: { x: 0, y: 3, z: 0 },
            },
            rotationSpeed: 0.16,
            initialRotation: -0.55,
            drag: {
                width: 560,
                height: 430,
                centerY: 690,
                sensitivity: 0.007,
                autoResumeDelay: 0.1,//seconds
            },
            platform: {
                radius: 3.25,
                height: 0.36,
                topY: 0.36,
                color: 0x18242f,
                roughness: 0.28,
                metalness: 0.62,
                rimColor: 0xffffff,
                floorColor: 0x070b10,
                wallColor: 0x09131e,
            },
            ceiling: {
                height: 12,
                color: 0x05090d,
                roughness: 0.88,
                metalness: 0.08,
                /* Honeycomb fixture settings (currently disabled).
                lightHeight: 6.06,
                lightColor: 0xf4fbff,
                hexRadius: 1.55,
                tubeRadius: 0.045,
                rotation: { x: 0, y: 0, z: 0 },
                */
            },
            transition: {
                duration: 0.55,
                slideDistance: 4.8,
            },
            ambient: { color: 0x71849a, intensity: 0.52 },
            /** Responsive cones cover the complete rotating vehicle silhouette. */
            spotlightCoveragePadding: 1.08,
            spotlightMaxAngle: 1.15,
            spotlights: [
                { color: 0xffffff, intensity: 330, distance: 28, angle: 0.48, penumbra: 0.62, position: { x: -4.8, y: 5.8, z: 5.0 } },
                { color: 0x66cfff, intensity: 250, distance: 25, angle: 0.50, penumbra: 0.72, position: { x: 5.5, y: 5.4, z: 2.2 } },
                { color: 0xb26cff, intensity: 300, distance: 24, angle: 0.44, penumbra: 0.68, position: { x: 0.4, y: 4.8, z: -5.3 } },
            ],
            shadowMapSize: 512,
        },
    },

    /** Startup progress UI and the real work each segment represents. */
    loading: {
        statusY: 400,
        barY: 365,
        barWidth: 390,
        barHeight: 24,
        barStrokeWidth: 2,
        barInset: 4,
        statusFontSize: 22,
        statusColor: '#e5e2e1',
        backdropColor: '#131313',
        trackColor: '#e2202e',
        fillColor: '#e2202e',
        /** Native loading.jpg aspect ratio; keeping it prevents portrait-art distortion. */
        backgroundImageAspectRatio: 852 / 1846,
        fontFamily: 'MonsterRacing',
        errorText: 'UNABLE TO LOAD VEHICLES',
        stages: {
            assets: 'LOADING ASSETS',
            compile: 'COMPILING ASSETS',
            world: 'GENERATING PROCEDURAL WORLD',
            shadows: 'BAKING SHADOWS',
        },
        /** The overall bar maps to four measured startup phases, not elapsed time. */
        weights: {
            assets: 0.38,
            compile: 0.26,
            world: 0.26,
            shadows: 0.10,
        },
    },

    /** Player car dimensions and handling. FBX footprint comes from `vehicles.models`. */
    car: {
        width: 2.0,
        height: 0.9,
        length: 4.2,
        /** Cabin box, as a fraction of the body box. */
        cabinLengthFactor: 0.5,
        cabinWidthFactor: 0.85,
        cabinHeight: 0.6,
        /** Gap between the ground and the bottom of the body — the wheels fill it. */
        rideHeight: 0.24,
        wheel: {
            radius: 0.36,
            width: 0.26,
            /** How far the tyre sits outboard of the body's side, as a fraction of its width. */
            outboard: 0.35,
            /** Axle positions, as a fraction of the body's half-length. */
            axleOffset: 0.62,
            color: 0x1a1a1e,
        },
        /** Rear-pivot steering. Yaw follows input; speed scales only body roll. */
        steering: {
            /**
             * Maximum body direction away from world-forward (about 13 degrees).
             * Yaw is controlled only by steering input, not speed.
             */
            maxYawAngle: 0.22,
            /** Exponential response toward the requested angle. */
            response: 9,
            /** Body lean at maximum steering yaw and `speed.max`. */
            maxRollAngle: 0.05,
            /**
             * Pivot rearward from centre as a fraction of half-length. 0 uses
             * the centre; 1 uses the rear bumper; 0.62 matches the rear axle.
             */
            yawPivotFactor: 0.62,
        },
        /** Ground contact and chassis alignment while riding slopes. */
        suspension: {
            /** Vertical response toward the tyre-supported body height. */
            heightResponse: 20,
            /** Pitch/roll response toward the plane formed by all four tyres. */
            tiltResponse: 14,
            /** Maximum visible separation while descending before snapping down. */
            maxGroundGap: 0.04,
        },
    },

    /** Gameplay hitbox tuning, independent of rendered FBX dimensions. */
    collision: {
        /** Fraction of the measured player FBX footprint used by its OBB. */
        player: {
            widthScale: 0.88,
            lengthScale: 0.90,
        },
        /** Fraction of each measured traffic FBX footprint used by its OBB. */
        traffic: {
            widthScale: 0.88,
            lengthScale: 0.90,
        },
    },

    /**
     * TPP follow camera. `followRate` feeds exponential damping (§5.6).
     *
     * The camera translates laterally with the car but NEVER yaws — its look-at
     * target sits ahead of the camera's own x, not the car's, so the view axis
     * stays parallel to -Z and steering reads as the world sliding sideways
     * rather than swinging.
     *
     * `height` and `fov` are the two strongest levers on perceived speed: a low,
     * wide camera puts fast-moving ground close to the edges of frame. Raising
     * `height` makes the same m/s feel slower, every time.
     */
    camera: {
        fov: 68,
        /**
         * `far` must exceed `sky.domeRadius`, which must in turn exceed the
         * farthest terrain corner (305m at the current chunk window) — the dome
         * is drawn LAST and depth-tested so it only shades visible sky, and that
         * only works if it sits behind everything. `near` is raised off 0.5 to
         * claw back depth precision over the longer range; the camera is 8.2m
         * behind the car, so 1m clips nothing.
         */
        near: 1,
        far: 400,
        /** Offset from the car, in the car's own space. +Z is behind. */
        height: 5,
        distance: 12,
        /** Look-at target height, and how far down the road it sits. */
        lookHeight: 5,
        lookAhead: 20,
        followRate: 7,
        /** Extra pull-back at top speed, metres. Keep small — pulling back reduces speed feel. */
        distanceSpeedGain: 0.8,
        /** Extra FOV degrees at top speed. Stretches the periphery; reads as acceleration. */
        fovSpeedGain: 8,
    },

    /**
     * Lighting. `sunDirection` points TOWARD the sun and is the single source of
     * truth for it: the directional light is placed along it, the sky dome's glow
     * and horizon warmth are driven by it, and the shadow frustum is aimed down
     * it. Change it in one place and everything agrees.
     */
    lighting: {
        /**
         * Ambient at FULL sun. `timeOfDay` interpolates away from this toward
         * `ambientColorLow`/`ambientIntensityLow` as the sun drops, and lands
         * exactly back on these two at solar noon — so the approved daylight
         * look is preserved rather than approximated.
         */
        ambientColor: 0x8ba6bd,
        /**
         * 0.55, down from 0.8, with `sunIntensity` raised to compensate — the
         * pair stretches dynamic range rather than changing overall exposure.
         *
         * Measured against reference/gameplay_ref.jpg with the same foliage filter and
         * the same percentiles on both images: the reference spans 5.0x from its
         * darkest to brightest foliage, ours spanned 3.5x. Our lit level was
         * already close; it was the shadow side sitting too high, which is what
         * makes low-poly cones read as flat painted shapes instead of lit
         * surfaces. Ambient is the floor under every shadowed face, so it is the
         * only thing that sets how dark the dark side can get.
         *
         * Careful: this is also the floor under the terrain and the cars, and
         * `timeOfDay` interpolates from `ambientIntensityLow` to this value, so
         * lowering it steepens that curve as well as darkening midday shadow.
         */
        ambientIntensity: 0.55,
        /**
         * Ambient at the sun's floor. A low sun stops filling the scene: at 9
         * degrees an upward terrain normal gets N.L ~ 0.16, so the sun's
         * contribution falls from ~2.29 to ~0.46 and the whole scene goes muddy
         * (measured, not estimated). 1.75 brings the total back to ~2.2 of the
         * daylight ~3.1 — deliberately not all the way, because full
         * compensation flattens the shaping that makes dusk read as dusk.
         *
         * The colour matters as much as the level: at sunset the fill light
         * comes off an orange sky, so keeping the daylight blue makes lit faces
         * look wrong in a way that is hard to place.
         */
        ambientColorLow: 0xd9a179,
        /**
         * Dawn's fill light, the cool counterpart of `ambientColorLow`. Fill
         * comes off the sky, so leaving this warm under a blue-grey pre-dawn sky
         * mismatches lit faces against their own background — the same error as
         * leaving it blue under a sunset.
         */
        ambientColorLowDawn: 0x93a6c4,
        ambientIntensityLow: 1.75,
        sunColor: 0xfff2dd,
        /** Raised with `ambientIntensity` lowered, so the LIT level holds while the range widens. */
        sunIntensity: 3.3,
        /**
         * The moon, which replaces the sun as the light source once the sun sets.
         * It is placed at the sun's ANTIPODE — opposite azimuth, mirrored
         * elevation — which is where a FULL moon actually sits, so it rises as
         * the sun sets and tracks the same arc twelve hours out of phase.
         *
         * `moonIntensity` is a fraction of `sunIntensity`, not an absolute. Real
         * moonlight is ~400,000x weaker than sunlight and would render black, so
         * this is a stylised "you can still see" level. The colour is cool
         * because night vision shifts blue — the convention every night scene
         * follows, even though moonlight is physically sun-coloured.
         */
        moonColor: 0xb8c9e8,
        moonIntensity: 0.35,
        /** Ambient at night, replacing the low-sun pair once the sun is down. */
        ambientColorNight: 0x2c3e5e,
        ambientIntensityNight: 0.5,
        /**
         * Unit-ish; normalised on use. Behind and to the right of the camera.
         *
         * `y` is the mood dial: the sky shader mixes the horizon toward
         * `sky.horizonSunsetColor` by (1 - y), so 0.66 read as dusk — pink haze
         * under a purple zenith. It also sets how much orange gets mixed into
         * the DERIVED fog colour, so pushing it too low desaturates the whole
         * scene. 0.80 keeps the sun low enough for legible shadows.
         */
        sunDirection: { x: 0.38, y: 0.80, z: 0.5 },
        /**
         * Time of day. RESOLVED AT BOOT — `resolveTimeOfDay()` overwrites
         * `sunDirection`, `ambientColor` and `ambientIntensity` above before the
         * scene is built, so everything downstream (sky gradient, derived fog
         * and background, light direction, shadow frustum) follows from one
         * vector with no other wiring.
         *
         * `mode: 'fixed'` is the default ON PURPOSE. This is a reskin template:
         * a client approves one look, and live time would show their users a
         * different one depending on when they opened it — and an ad network
         * reviewing at 2am would see the darkest version. Ship 'fixed' unless
         * live time is a deliberate feature of the campaign, and use 'fixed'
         * for QA either way so screenshots are reproducible.
         */
        timeOfDay: {
            /** 'fixed' uses `hour`; 'local' reads the device clock ONCE at boot. */
            mode: 'fixed' as 'fixed' | 'local',
            /** Hour used by 'fixed' mode, 0-24 and fractional. */
            hour: 12,
            /**
             * Observer latitude, degrees. This is a REAL solar position now, not
             * a stylised arc — latitude sets how high the sun climbs, how fast it
             * rises, and how far from due-east it comes up. 35 gives a temperate
             * path; near 0 the sun goes almost overhead and rises nearly
             * vertically, near 60 it stays low and skims.
             */
            latitude: 35,
            /**
             * Solar declination, degrees: the season. 0 is an equinox, where the
             * sun rises due east at 06:00 and sets due west at 18:00. +23.4 is
             * midsummer (long day, sun rises north of east), -23.4 midwinter.
             */
            declination: 0,
            /**
             * Angle between the camera's forward axis and the sun AT SUNSET,
             * degrees. Positive puts it to screen right.
             *
             * The one artistic constraint on an otherwise physical path: it
             * rotates the whole sky so the day ends at the chosen angle, which in
             * turn fixes the car's compass heading. Sunrise direction, noon
             * height and how the light swings across the day then all follow from
             * `latitude` and `declination` rather than being posed separately.
             *
             * KEEP THIS AT 40 OR MORE. Because the sun approaches the view axis
             * monotonically through the afternoon, this value IS its closest
             * approach while it is above the horizon — which makes it the knob
             * that decides whether its glow lands in frame.
             *
             * And the glow in frame breaks the fog, which is the real constraint
             * here. Fog can only hide something when the sky behind it is the
             * same colour, and it is ONE colour. With the sun ahead on the
             * horizon the sky spans rgb(135,94,39) at the frame edge to
             * rgb(255,255,221) at the sun — 161/255 of gradient — and no single
             * value tracks that. Measured: the terrain/sky mismatch at the
             * skyline was 50/255 with the sun dead ahead, and deriving the fog
             * from the sky (see `procedural/sky/skyModel.ts`) only brought it to
             * 48. The fix is not a better fog colour, it is keeping the glow out
             * of shot.
             *
             * Where 40 comes from: the broad lobe is `broadAmp * cos(θ)^broadExp`,
             * so at the nearest visible direction (offset − 19.2° half-FOV) it is
             * 0.040 at offset 30 — still visible — and 0.0006 at offset 40, which
             * is nothing. 60 is comfortably clear.
             *
             * The cost is that the sun is never in shot: this buys raking
             * side-light and long shadows, not a sun you can see. Values from
             * ~20 to ~160 show neither sun nor moon at any hour. Below ~19 the
             * sun is in frame and the fog problem above returns.
             */
            sunsetOffsetDegrees: 330,
            /**
             * Sun elevation, degrees (negative = below horizon), at which night
             * is fully established: the moon has taken over as the light source
             * and the sky has reached its night palette. Between 0 and this the
             * two blend, so dusk is gradual rather than a switch.
             */
            twilightEndDegrees: -8,
        },
        /** How far along `sunDirection` the light is placed, metres. */
        sunDistance: 90,
        /**
         * TREE SHADOWS — hundreds of static casters, in one top-down texture.
         *
         * A separate mechanism from `projectedShadows` for one hard reason:
         * that one holds each caster in a uniform slot, and `trees.maxInstances`
         * is 400. So tree silhouettes are drawn — already projected onto the
         * ground plane — into a single orthographic top-down render target, and
         * the GROUND materials sample it by world XZ. One extra draw call (the
         * quads are instanced) and one texture fetch per ground fragment, for an
         * unbounded number of casters.
         *
         * This is what finally makes tree shadows drape. The decal quads failed
         * on a measured fact: a 14m tree at a 28 degree sun projects 30m of
         * ground while terrain amplitude is 5.5m, so a planar quad is buried for
         * most of its length. Here nothing is placed in the world at all — the
         * mask is a function of ground position, evaluated by the ground shader
         * at whatever height the fragment actually has, so burial cannot happen.
         *
         * GROUND ONLY, and that is structural: a lookup by world XZ gives every
         * point of a vertical surface at the same XZ the same value, so sampling
         * this on a tree trunk or a car would give a vertical streak. Vehicles
         * are therefore not mask receivers. A tree's shadow falling across the
         * car is what this split gives up.
         */
        treeShadows: {
            enabled: true,
            /**
             * Mask resolution. With `windowSize` this is THE quality number for
             * tree shadows, and the reason they read softer than the vehicles':
             *
             *     vehicle: 256 texel cell over a ~3m footprint  = ~85 texels/m
             *     tree:    1024 texel mask over a 160m window   =  6.4 texels/m
             *
             * Still a 13x gap, and it is structural — a per-caster cell is a
             * fixed budget for ONE object, while the mask spreads its texels over
             * the whole window. Raising this or lowering `windowSize` is the only
             * lever, and both cost the same thing: mask fill per frame, which
             * scales with the SQUARE of the density.
             *
             * 4MB of GPU memory at 1024 (RGBA). An alpha-only RedFormat target
             * would be 1MB and is safe on WebGL2, but it complicates readback in
             * `debugStats`; worth doing if memory ever binds. Download size — the
             * actual 2MB budget — is untouched either way.
             */
            maskSize: 512,
            /**
             * Side of the world window the mask covers, metres. Trades texel
             * density directly against how far ahead shadows exist at all, and
             * shrinking it is the CHEAPEST quality win available — unlike
             * `maskSize` it costs no memory.
             *
             * Chosen against the fog, not the draw distance. With `forwardBias`
             * 0.40 this reaches 144m ahead, where fog has erased about half of
             * everything; the edge fade then has an easy job hiding the boundary.
             * Pushing it below ~120m starts cutting shadows while they are still
             * clearly visible, and no amount of fade hides that.
             */
            windowSize: 160,
            /**
             * How far the window is pushed AHEAD of the car, as a fraction of
             * `windowSize`. The ground behind the camera is off screen, so
             * centring the window on the car would spend nearly half its texels
             * on nothing. 0.35 leaves a little margin behind for the shadow of a
             * tree the car has just passed.
             */
            forwardBias: 0.40,
            /**
             * Lateral distance from the road centre (`roadCenterX` at the tree's
             * OWN z, since the road curves) past which a near tree stops
             * casting into the mask. Trees this far out sit in the background
             * scatter, not the roadside treeline — `trees.roadClearance` (12) to
             * `terrain.chunksWide` x `terrain.chunkWidth` / 2 (60) is the full
             * range a tree can occupy, and nothing beyond a few tree-depths of the
             * verge ever throws a shadow onto ground the camera can see.
             *
             * Skipped before `TreeShadowMask.add`'s per-instance vector math,
             * not after — same shape as the near/far LOD split, just against the
             * road instead of the viewer.
             */
            maxRoadDistance: 30,
            /**
             * Atlas cell resolution per tree variant. 256, not 128, so the ATLAS
             * is not the bottleneck as well: at 256 a cell resolves ~40 texels/m
             * across the shadow and ~7.5 along it once the sun's stretch is
             * applied, both comfortably past the mask's 6.4. One bottleneck, in
             * the place where raising the dial actually pays.
             */
            textureSize: 256,
            /**
             * Instance slots for trees in the mask. `trees.maxPerVariant` times
             * the variant count bounds the near tier, but most of those are
             * outside the window, which `add` rejects before spending a slot.
             */
            maxCasters: 320,
            /**
             * How much direct light a fully occluded ground fragment loses.
             * Lower than `projectedShadows.opacity` on purpose: a canopy is not
             * opaque, and dappled light through leaves is the look this is
             * standing in for.
             */
            opacity: 0.72,
            /**
             * Fraction of the window's edge over which the mask fades out. The
             * window has a hard boundary and shadows simply stop existing past
             * it; without a fade that boundary is a visible straight line across
             * the terrain, travelling with the car.
             */
            edgeFade: 0.08,
        },

        /**
         * PROJECTED SHADOWS — the shadow is computed inside each RECEIVER's
         * fragment shader, and is the technique that replaced the decal quads.
         *
         * The decals failed for a reason no amount of placement work would have
         * fixed: they composited a dark quad on top of already-lit ground, so
         * they read as plates. This instead scales `directDiffuse`/
         * `directSpecular` after `lights_fragment_begin`, i.e. it removes the
         * SUN and leaves ambient and the env map alone — which is what makes a
         * shadow shift cool instead of merely dark. There is also no quad, so
         * the whole "draping on irregular terrain" problem disappears: every
         * fragment resolves its own shadow at its own position.
         *
         * Zero extra draw calls and zero per-frame render targets. The cost is
         * per fragment on every receiver and scales with `maxCasters`.
         *
         * Handles the CAR and TRAFFIC. It cannot handle trees — `trees
         * .maxInstances` is 400 and these are uniform slots — so tree shadows
         * are still missing and need a different mechanism. See `terrain
         * .selfShadow` for the ground's own shading, which is unrelated.
         *
         * Like everything else here, it relies on the hour being fixed at boot:
         * the silhouette atlas is baked once for one light direction.
         */
        projectedShadows: {
            enabled: true,
            /**
             * Uniform slots for simultaneous casters, and a COMPILE-TIME
             * constant in the receiver shader — changing it recompiles every
             * patched material.
             *
             * 6 is derived, not guessed: `traffic.maxAlive` is 16, but
             * `traffic.spawnAhead` is 210m and a shadow is unreadable past a
             * few tens of metres, so the nearest five plus the player is the
             * whole visible population. Casters beyond the slot count are
             * dropped by distance, and the player's is pinned.
             *
             * Each slot costs three vec4 uniforms and, per fragment, a handful
             * of dot products — plus a texture fetch ONLY for fragments actually
             * inside that caster's footprint, which is why the practical cost is
             * far below the worst case.
             */
            maxCasters: 6,
            /**
             * Atlas cell resolution per caster. This is the reason this approach
             * beats the shadow map on quality: a cell is a fixed budget for ONE
             * object, whereas a shadow map spreads its texels over the whole
             * frustum. 256 across a 4m car is ~64 texels/m; a 512 map over the
             * shadow reach managed about 7.
             */
            textureSize: 256,
            /**
             * How much of the direct light a fully occluded fragment loses.
             * Can sit near 1 because this is genuine light attenuation and
             * ambient still lights the surface — unlike the decals, where the
             * same number was an alpha blend and had to stay low to avoid
             * looking painted on.
             */
            opacity: 0.85,
            /**
             * Shadows fade out between these distances DOWN-LIGHT of the
             * caster, in metres.
             *
             * This is not a stylistic softening — it is the fix for the one
             * artefact of having no depth test. The lookup is a shadow-map
             * lookup minus the depth compare, so without a limit a car's shadow
             * would darken a hillside 200m away. Set `fadeFar` comfortably past
             * the longest legitimate shadow: at the current sun that is roughly
             * the caster's height times 2.2, so a 2.5m bus needs ~6m and the
             * headroom below covers a lower sun without re-tuning.
             */
            fadeNear: 10,
            fadeFar: 25,
        },

    },

    /**
     * Trees. Geometry is low-poly on purpose — see the measurement note at the
     * top of `src/procedural/tree.ts` for why Procedural_3D_world's generator
     * isn't used.
     *
     * `spacing` is the dominant cost dial: candidate count scales with its
     * inverse square, and every survivor is a matrix write per frame plus its
     * triangles in both the main and the shadow pass.
     */
    trees: {
        /** Distinct geometries generated at boot and instanced. */
        variants: 4,
        /**
         * Bigger and fewer. Canopy area goes as the square of the radius, so
         * raising the size and thinning the count keeps the same amount of
         * foliage on screen for far less geometry: at spacing 18 with these
         * heights the covered ground area is ~2100m² against ~1650m² at the
         * previous 12/5.5-9.5, from roughly HALF the trees — so ~3.7k triangles
         * instead of ~8.3k, in both the main and the shadow pass.
         */
        heightMin: 8,
        heightMax: 16,
        trunkRadiusK: 0.035,
        canopyRadiusK: 0.30,
        tiersMin: 3,
        tiersMax: 4,
        trunkSegments: 5,
        canopySegments: 6,
        /**
         * Matched to reference/gameplay_ref.jpg by taking the reference's HUE and
         * SATURATION and keeping our own lightness — the reference values are
         * final rendered pixels, already lit and fogged, so pasting them into
         * base-colour slots would double-count the exposure.
         *
         * The hue is the whole point. Sampled foliage there is olive: lit
         * rgb(113,117,70), where red and green are within 4 of each other. Ours
         * was rgb(95,138,69), green a clear 43 above red. That single ratio is
         * why the reference trees "feel different" despite being the same
         * low-poly shape — it reads as warm light on foliage, not as emerald.
         *
         * These are then RAISED for exposure. Getting the hue right left the
         * trees too dark: measured foliage rendered at a median rgb(64,75,57)
         * against the reference's lit rgb(113,117,70). The cause is not ambient
         * light drowning the sun — measured contrast across our own foliage is
         * 2.7x, against 1.5x in the reference, so if anything ours is the more
         * directional of the two. It is simply that a Lambert diffuse term
         * divides irradiance by pi, so a camera-facing face ends up at ~0.50x
         * its albedo, and the albedo was too low to survive it.
         *
         * Blue is raised less than red and green on purpose: `ambientColor` is a
         * cool blue, so the unlit side drifts blue, and holding blue back in the
         * albedo is what keeps the olive reading in shadow as well as in light.
         */
        trunkColor: 0x885c43,
        foliageLowColor: 0x37622a,
        foliageHighColor: 0x71b53a,

        /** Average metres between placement candidates, before rejection. */
        spacing: 38,
        /** Candidates on ground steeper than this are rejected. */
        maxSlope: 0.55,
        /**
         * Clearance from the road centre. Must exceed the flattened corridor, or
         * trees grow out of the verge and the player clips scenery that looks
         * like it's beside the road rather than on it.
         */
        roadClearance: 10,
        /**
         * Density mask: candidates whose noise value falls below this are
         * dropped, which is what produces clumps and clearings instead of an
         * even sprinkle. 0 keeps everything.
         */
        densityCutoff: 0.42,
        densityFrequency: 0.012,
        /** Ceiling on live instances per variant. */
        maxPerVariant: 120,
        /**
         * Trees are scattered on chunks within this many ahead — the FULL
         * terrain window, because past `lodCrossover` a tree is two triangles
         * instead of ~60, so reaching the draw edge costs less than stopping
         * short at 4 chunks did with geometry all the way out.
         *
         * Stopping short was the actual cause of trees being visible at
         * distance: the window ended at ~200m, where fog still leaves 8% of a
         * tree's colour showing, so they winked out while still faintly visible.
         * At the draw edge fog leaves 0.006%.
         */
        maxChunksAhead: 7,
        /**
         * THE LOD KNOB. Distance in METRES at which a tree switches from real
         * geometry to a baked billboard. Measured as true 3D distance from the
         * car, so it means the same thing for a tree off to the side as for one
         * straight ahead.
         *
         * Tune it by eye: the perf HUD prints `lod <m> near <n> far <n>`, so you
         * can see both the value and how many trees each tier is holding.
         * Raising it moves trees into geometry (better looking, more triangles
         * in the main AND shadow passes); lowering it does the reverse. The swap
         * is a hard switch with no cross-fade, so what you are looking for is
         * whether you can catch a tree changing shape as you drive at it.
         *
         * What makes the switch invisible is fog having already removed most of
         * the difference by the time it happens. That budget CHANGED when
         * `world.fogFalloff` went to 4 — the curve now holds the near field much
         * clearer, so a swap at 140m is more exposed than it used to be:
         *
         *   crossover   fog hides   was (exponent 2)
         *   ---------------------------------------
         *     100m         15%            29%
         *     120m         28%            49%
         *     140m         45%            62%
         *     160m         64%            71%
         *     180m         81%            80%
         *     200m         92%            86%   <- current
         *
         * So if the pop is visible, ~170-180m is where fog starts doing the work
         * it used to do at 140m. Watch `tris` and `near` in the HUD as you go —
         * and check `maxPerVariant`, because the near tier demotes overflow back
         * to billboards rather than dropping it.
         */
        lodCrossover: 190,
        /** Baked impostor texture edge, pixels. */
        spriteTextureSize: 128,
        /** Ceiling on live billboards. Cheap enough to be generous. */
        maxFarInstances: 700,
        /** Sunk slightly so the trunk grows out of the ground, not onto it. */
        sinkDepth: 0.25,

        /**
         * Broadleaf variant shape knobs, kept for `procedural/treeBroadleaf.ts`
         * even though nothing currently instantiates it — see that file's own
         * header comment. Trunk/foliage colour and `variants`' shared height
         * range come from the fields above so it would read as part of the same
         * forest if re-enabled.
         */
        broadleaf: {
            variants: 2,
            trunkRadiusK: 0.032,
            /** Portion of total height the straight trunk climbs before branching. */
            trunkHeightMinK: 0.5,
            trunkHeightMaxK: 0.66,
            /** Short angled stubs breaking up the silhouette below the canopy. */
            branchCountMin: 1,
            branchCountMax: 2,
            branchLengthMinK: 0.16,
            branchLengthMaxK: 0.26,
            /** Tilt off vertical, radians — 35-55 degrees. */
            branchTiltMin: 0.61,
            branchTiltMax: 0.96,
            /** Overall canopy envelope radius, as a fraction of total height. */
            canopyRadiusK: 0.34,
            /**
             * The canopy is ONE icosahedron (`canopyDetail` subdivisions) with
             * each vertex pushed in/out along its own radius by a random factor
             * in this range — a single deformed blob reading as an irregular,
             * clumped mass instead of the conifer's clean radial cones, but
             * still one shape (not several overlapping ones) merged with the
             * trunk/branches into the tree's one mesh.
             */
            canopyDetail: 1,
            canopyJitterMin: 0.75,
            canopyJitterMax: 1.2,
            /** Flattens the blob vertically so it reads as a canopy, not a ball. */
            canopySquashY: 0.82,
        },
    },

    /** Sparse low-poly scenery used by the desert biome. */
    desertProps: {
        /** Full generated catalog; rocks remain available for future biomes. */
        variants: 4,
        /** Only the first two cactus variants are placed in the desert scene. */
        activeVariants: 2,
        spacing: 24,
        roadClearance: 11,
        maxSlope: 0.62,
        densityCutoff: 0.34,
        densityFrequency: 0.0105,
        maxPerVariant: 180,
        maxChunksAhead: 5,
        sinkDepth: 0.12,
        cactusColor: 0x47724f,
        cactusHighlight: 0x6e9360,
        rockLowColor: 0x78503e,
        rockHighColor: 0xb77b54,
    },

    /**
     * Procedural sky dome — a gradient, a sun glow and drifting noise clouds,
     * all evaluated per-pixel. One draw call, no textures, which is why it fits
     * a 2MB budget where a cubemap would cost hundreds of kilobytes.
     *
     * `horizonColor` is the single biggest lever on how vivid the game looks,
     * because the scene's fog colour is DERIVED from it: every surface past ~60m
     * is blended toward it, and by 140m it's 62% of what you see. The first pass
     * used P3W's hazy-valley 0xc9dcef, which after the sunset mix came out as
     * rgb(210,204,206) — 3% saturation, i.e. grey — and washed the whole world
     * out. 0x7fc2ea lands at 27%, so distance reads as blue atmosphere instead
     * of as fading to white.
     */
    sky: {
        /**
         * Zenith at FULL sun. The sky shader blends toward `zenithLowColor` as
         * the sun drops, the same way it blends the horizon — so the top of the
         * sky tracks time of day instead of staying midday blue under a sunset.
         */
        zenithColor: 0x4a94b8,
        /** Zenith before sunrise: deep, cool, still holding night. */
        zenithDawnColor: 0x1d3a6b,
        /** Zenith after sunset: violet, the classic complement to an orange horizon. */
        zenithSunsetColor: 0x4a3a78,
        /** Zenith at night. */
        zenithNightColor: 0x0a1024,
        /** RESOLVED AT BOOT from the pair above. See `resolveTimeOfDay()`. */
        zenithLowColor: 0x4a3a78,
        /**
         * LEFT ALONE deliberately when matching reference/gameplay_ref.jpg.
         *
         * The reference's horizon band samples rgb(215,244,242) — near-white —
         * and setting this to that DID land closer to it. It also made the top
         * of the frame WORSE (89,144,176 against the reference's 74,148,184,
         * versus 74,138,175 keeping this value), because the upper sky is a
         * blend of both ends. And since this is also the fog colour, it paled
         * the entire far field, undoing the vivid/hazy balance for a part of the
         * frame that was explicitly not the concern.
         *
         * Worth knowing if you do want to chase it: the daylight horizon can
         * never actually reach this colour. `sunHeight` peaks at
         * sin(timeOfDay.maxElevation) = 0.799, so the horizon is permanently
         * ~20% `horizonLowColor`. Best case at this value is rgb(201,228,231).
         */
        horizonColor: 0x7fc2ea,
        /**
         * The horizon colour at a low sun; `horizonColor` is where it lands at a
         * high one, blended by the sun's height. `effectiveHorizonColor()` runs
         * the same blend on the CPU to derive the scene's fog and background, so
         * fog matches the sky at ANY sun angle by construction rather than by a
         * hand-matched constant.
         *
         * Verified at a sunset angle (sunDirection.y 0.10, sunHeight 0.157):
         * predicted rgb(226,153,124), measured on screen rgb(226,152,124). Both
         * halves of the reskin — sky and fog — track the sun together.
         *
         * Note the scene goes genuinely dim there: at 9 degrees of sun elevation
         * a mostly-upward terrain normal gets N.L ~ 0.16, so a sunset preset
         * wants `lighting.ambientIntensity` raised to stay readable.
         */
        horizonSunsetColor: 0xef8f52,
        /**
         * The DAWN counterpart of `horizonSunsetColor`.
         *
         * Sun height alone cannot tell 4am from 8pm — both are a low sun — so
         * without this, pre-dawn rendered as the same warm orange as sunset,
         * which reads as plainly wrong when you know the time. Real pre-dawn
         * twilight is cool: the sun is still below the horizon and what light
         * there is has been scattered blue.
         */
        horizonDawnColor: 0x7d8fb3,
        /** Horizon at night — kept lighter than the zenith, as a real night sky is. */
        horizonNightColor: 0x1b2740,
        /**
         * RESOLVED AT BOOT — the low-sun horizon colour actually in force, set
         * from `horizonDawnColor` or `horizonSunsetColor`. This, not either of
         * those, is what the sky shader and the derived fog read, so they cannot
         * disagree about which half of the day it is.
         */
        horizonLowColor: 0xef8f52,
        /**
         * LIVE as of `timeOfDay.azimuthCenter` moving past 90 degrees.
         *
         * For most of this project it was dead: the sun sat behind the camera,
         * 127 degrees off the view centre against a ~19 degree half-frustum, so
         * neither this colour nor the two glow terms in SkyDome's shader ever
         * rendered a pixel. The sun is now in FRONT and in frame in the late
         * afternoon, which is what makes it visible — and which also means the
         * scene is backlit and shadows point toward the viewer.
         */
        sunGlowColor: 0xfff2c8,
        /**
         * Sun glow lobes: a broad halo plus a tight disc, each an amplitude and
         * a `pow(dot, exp)` exponent. A lobe falls to half at
         * sqrt(2*ln2/exp) radians, so 84 spans about 15 degrees and 1820 about 3.
         *
         * `broadAmp` was 0.5 and clipped. 15 degrees is most of a ±19.2 degree
         * frame, and 0.5 of a near-white glow on top of an orange horizon lands
         * well over 1.0, so the entire centre of the sky flattened to pure white
         * — which is also what stopped the fog matching anything, since a single
         * fog colour cannot follow a blown-out gradient.
         *
         * These are mirrored on the CPU by `procedural/sky/skyModel.ts`, which is
         * what derives the fog colour, and they are interpolated into the dome's
         * GLSL from here so there is only one set of numbers.
         */
        sunGlow: {
            broadAmp: 0.18,
            broadExp: 84,
            tightAmp: 1.6,
            tightExp: 1820,
        },
        /**
         * A solid lunar disc, expressed as dot-product edges. Unlike a pow()
         * lobe, this has no falloff around the rim that can read as a glow.
         * The 0.50°–0.66° radius includes a narrow anti-aliased edge only.
         */
        moonGlow: {
            discAmp: 1.6,
            discInnerDot: 0.999846,
            discOuterDot: 0.999735,
        },
        /**
         * Half-width of the arc the FOG COLOUR is averaged over, degrees, at the
         * horizon.
         *
         * The fog is one colour and the sky is not, so it cannot match everywhere
         * — with the sun in frame the sky spans from dark orange at the frame edge
         * to white at the sun. Averaging across the visible arc minimises the
         * worst-case mismatch instead of matching one point perfectly and missing
         * badly elsewhere. Slightly wider than the frame's own 19.2 so the value
         * does not lurch as the sun crosses the edge.
         */
        fogSampleArcDegrees: 24,
        /**
         * The horizon-to-zenith ramp. ONE curve, deliberately — there is no
         * separate haze band any more.
         *
         * The band was two stages: a `pow(h, 0.55)` gradient, then an override
         * forcing the bottom 11.5° back to the fog colour. Both halves worked,
         * but their seam was visible. A sub-1 exponent rises FASTEST right at
         * the horizon, which is exactly where the override was holding things
         * flat — so the sky sat at pure fog colour to ~6°, then rushed to 41% of
         * the way to the deep blue zenith by 11.5° where the override ended.
         * That kink in the rate of change is what read as the horizon not
         * matching the fog.
         *
         * `smoothstep` raised to a power above 1 replaces both stages with a
         * single monotone ramp that leaves the horizon with ZERO slope, so
         * nothing rushes and there is no boundary anywhere for the eye to catch.
         * It also happens to dominate the old pair at every elevation the camera
         * can see (-43°..+25° at a -8.8° pitch and 68° FOV):
         *
         *   elevation      old (gradient + band)      this ramp
         *   ----------------------------------------------------
         *    2.9° trees          14% zenith            0.1%
         *    6.9° treetops       ~25%                  2.3%
         *   11.5° band edge      41%                    12%
         *   17.5°                52%                    36%
         *   24.8° top of frame   62%                    76%
         *
         * So distant geometry sits against a purer fog colour AND the top of the
         * frame is BLUER than before — the old worry that flattening the low sky
         * must pale the whole visible sky only applied to widening the band.
         *
         * Below the horizon the ramp clamps to 0, i.e. exactly the fog colour.
         * Terrain covers everything below 0° in practice, but if a chunk seam
         * ever shows a sliver of dome it is guaranteed to be invisible.
         */
        /** Elevation (as sin) where the ramp reaches full zenith colour. */
        /**
         * Lowered from 0.55 (33°) so the ramp completes nearer the top of what
         * the camera can see (~25°), letting the upper sky actually reach
         * `zenithColor`. With a near-white horizon and the ramp finishing above
         * the frame, the top of the screen could not get blue enough to match
         * the reference — there was no zenith value that solved it, the
         * extrapolation went negative in red.
         */
        skyTopHeight: 0.45,
        /**
         * How long the horizon colour is held before the ramp lifts. Above 1
         * flattens the low sky; 1.0 is the plain smoothstep. This is the knob
         * for "distant things are still visible" — raise it.
         */
        horizonHold: 1.8,
        /**
         * Clouds as camera-pinned billboards, not as shader noise.
         *
         * The first version computed a 3D noise field per pixel in the sky
         * shader: ~16 evaluations of 3D simplex per cloud pixel, measured at
         * 7.7ms a frame (≈14ms on a low-end phone). The cost was structural —
         * every pixel of the upper sky paid it whether a cloud was there or not.
         * Sprites pay only for the pixels they cover, and one texture fetch.
         *
         * The puff textures are generated on the CPU at boot, so they cost no
         * bundle bytes and can afford more octaves than realtime ever could.
         */
        clouds: {
            /** Billboards on the sky. Each is one quad. */
            count: 14,
            /** Distinct puff textures, shared across the sprites. */
            variants: 3,
            textureSize: 128,
            seed: 20260826,
            /** Distance from the camera. Inside `domeRadius` so they sit in front of it. */
            radius: 300,
            /** World-space width; height is a random fraction of it. */
            sizeMin: 90,
            sizeMax: 190,
            /**
             * Elevation band, degrees. Derived from what the camera can actually
             * see: at a fixed -8.8° pitch and a 68° vertical FOV, visible
             * elevation is -43°..+25°, so clouds above ~25° are never in frame.
             * A first pass used 14..46° and produced an empty sky.
             *
             * Both raised 20% from that derived band (6/24 -> 7.2/28.8) on
             * request. `maxElevation` now sits ABOVE the +25° visible ceiling —
             * cloud instances randomly placed past 25° (elevation is sampled
             * uniformly across the whole band) render outside the frustum and
             * are simply never seen, same failure shape as the "empty sky"
             * first pass above, just partial instead of total. Worth checking
             * the sky on the dev server for thinning near the top of frame.
             */
            minElevation: 7.2,
            maxElevation: 28.8,
            /**
             * Half-width of the arc clouds occupy, degrees, measured around
             * forward. The horizontal FOV is only ~42° (±21°), so this is that
             * plus margin either side, letting clouds drift in rather than pop.
             */
            arcDegrees: 34,
            opacity: 0.8,
            /**
             * Cloud tint at FULL sun — white, because a lit cloud is white.
             *
             * Clouds are unlit (`fog: false`, MeshBasicMaterial), so nothing
             * tied them to the sun: at sunset they stayed pure white and only
             * looked warm where the orange sky showed through their 20%
             * transparency. Real clouds take the colour of the light hitting
             * them, and at a low sun that is most of what you notice about them.
             */
            color: 0xffffff,
            /** Cloud tint before sunrise — cool, catching a sky that has no sun in it yet. */
            dawnColor: 0x9fb0cc,
            /** Cloud tint after sunset — warm, lit from below by a sun under the horizon. */
            sunsetColor: 0xf0b48a,
            /** Cloud tint at night. */
            nightColor: 0x4a5878,
            /** RESOLVED AT BOOT from the pair above. See `resolveTimeOfDay()`. */
            lowColor: 0xf0b48a,
            /**
             * Radians per second of azimuth drift. ZERO on purpose: clouds this
             * far away have no perceptible parallax against a car, so drift just
             * reads as the sky sliding. Static also means their matrices are
             * written once at startup instead of every frame.
             */
            driftSpeed: 0.01,
        },

        /**
         * Must ENCLOSE all world geometry (farthest terrain corner ≈ 305m) and
         * sit inside `camera.far`. Both constraints come from drawing the dome
         * last with depth testing on, which is what stops it shading pixels that
         * terrain covers — 4 fbm evaluations a pixel is far too much to spend on
         * fragments that get painted over.
         */
        /**
         * RESOLVED AT BOOT. How much of a full day the sky is showing: 1 at solar
         * noon, 0 once the sun is at or below the horizon.
         *
         * This replaced blending the sky off `sunDirection.y`, which breaks the
         * moment the moon becomes the light source — the direction fed to the
         * lighting is then the MOON's, and its height would brighten the sky
         * toward the DAY palette at midnight. The sky has to blend off the SUN's
         * height whatever is currently lighting the scene.
         */
        dayFactor: 1,
        /**
         * RESOLVED AT BOOT — the true sun and moon directions, independent of
         * `lighting.sunDirection`, which carries whichever of the two is
         * currently the light source. The dome needs both regardless of that, or
         * it cannot gate the sun glow off while drawing the moon.
         */
        sunDirection: { x: 0.38, y: 0.80, z: 0.5 },
        moonDirection: { x: -0.38, y: -0.80, z: -0.5 },
        domeRadius: 350,
    },

    world: {
        /**
         * Fog falloff exponent. THREE's FogExp2 is hardcoded to 2; this replaces
         * it via a ShaderChunk patch — see `procedural/fogCurve.ts` for the full
         * reasoning and the honest admission that it isn't physics.
         *
         * Short version: at exponent 2 the near field and the streaming edge are
         * locked together and no density satisfies both. 4 delays the onset and
         * then saturates hard, so 80m keeps 94% of its own colour while 240m
         * keeps 0.5%. Lower this to 3 if the fog reads as a curtain at a fixed
         * distance on a long straight; that is the failure mode to watch for.
         *
         * Changing it requires a reload — it compiles in as a shader literal.
         */
        fogFalloff: 4,
        /**
         * THREE.FogExp2 density. With `fogFalloff`, the fraction of a surface's
         * colour replaced by sky is 1 - exp(-(density * dist)^fogFalloff).
         *
         * Derived from the draw edge, which is the hard constraint: a new chunk
         * row arrives INSTANTLY across a large area, and change detection is far
         * more sensitive than static contrast, so anything above ~0.5% residual
         * there reads as the world being built. 0.0063 puts 240m at exactly that
         * — and, because of the exponent, still leaves 98% at 60m, 94% at 80m
         * and 72% at 120m, where nearly all the terrain the player actually
         * looks at sits.
         *
         * History worth not repeating: at the old exponent of 2, matching this
         * occlusion needed 0.0096, which fogged 45% at 80m and washed the world
         * pale enough that the rock band looked like it was never generated (it
         * was; a debug capture settled it). The fix was the curve's shape, not
         * its scale.
         *
         * Paired with `sky.horizonHold` — fog can only HIDE if the sky behind it
         * is the fog colour. And with `terrain.chunksAhead`, which now has spare
         * headroom: full occlusion arrives at 241m against a 280m draw edge, so
         * that is the first place to look if chunk builds need trimming.
         */
        fogDensity: 0.0063,
    },

    /**
     * Development-only visualisations. All default off and none of them ship —
     * flip one, reload, look, flip it back.
     */
    debug: {
        /** Draws the exact player and traffic collision OBBs and dimensions. */
        collisionBox: {
            enabled: false,
            playerColor: 0x39ff88,
            trafficColor: 0xff9f32,
            labelColor: '#b8ffd3',
            labelY: 970,
            labelFontSize: 22,
        },
        /**
         * Repaints the terrain by slope band in high-contrast colours instead of
         * the real palette: BLUE where it's grass, GREEN where dirt is blending
         * in, RED where rock is. The point is to answer "is this band being
         * produced at all, and where?" without squinting at subtle earth tones
         * through fog — which is exactly the question the real palette can't
         * answer. Chunks are built once, so this needs a reload to take effect.
         */
        showSlopeBands: false,
        /**
         * On-screen performance counters: FPS and worst frame time, per-chunk
         * build cost (last / recent peak / all-time peak), resident chunk count,
         * build queue depth and rate, and Three.js draw calls and triangles.
         *
         * Left ON while profiling on real devices. Turn it off before shipping —
         * it's a per-frame label bake and it covers the screen.
         */
        showPerf: false,
    },

    /**
     * Renderer/perf knobs handed straight to GameEngine's config. Uncapped
     * devicePixelRatio is the single biggest fill-rate mistake available on
     * mobile — see ARCHITECTURE.md §2.4.
     */
    render: {
        pixelRatioCap: 2,
        resolutionScale: 2,
    },
};
