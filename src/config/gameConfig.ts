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

    /**
     * Palette. The single highest-leverage block for a reskin: terrain colour
     * is baked into a per-vertex attribute (see ARCHITECTURE.md §4.1), so a
     * palette swap changes the whole biome with zero geometry change.
     */
    colors: {
        // NOTE: there is no `sky` or `fog` colour here on purpose. Both are
        // DERIVED from the sky dome's own horizon, which the shader warms toward
        // `sky.horizonSunsetColor` as the sun drops — so a hand-set fog colour
        // matches only at one sun angle and shows a seam at every other. See
        // `SkyDome.effectiveHorizonColor`.
        /**
         * Terrain palette. Grass blends vertically from `grassLow` on valley
         * floors to `grassHigh` on crests; `dirt` and `rock` then blend in by
         * slope and altitude (see `terrain.dirtSlope`/`rockSlope`).
         *
         * Two couplings to respect when tuning:
         *
         *  - **`dirt` and `rock` must differ in HUE, not just brightness.** They
         *    saturate on the same steep faces, dirt first, so a rock that only
         *    differs in saturation reads as "washed-out dirt" rather than stone.
         *    Rock was cool blue-grey for exactly this reason before the
         *    reference match warmed it, and dirt had to move redder and darker
         *    to keep the separation. Change one, check the other.
         *  - **These are pre-fog colours.** A palette that looks right up close
         *    reads grey at mid-distance, so it has to start more vivid than it
         *    should look. It was calibrated against a fog that removed 39% of
         *    the colour by 100m; `world.fogFalloff` now removes ~15% there, so
         *    it over-delivers. If the near field is garish, desaturate HERE
         *    rather than thickening the fog, which is doing a different job.
         *
         * Olive rather than green, matched to reference/gameplay_ref.jpg: its
         * grass samples rgb(169,166,77) lit and rgb(141,137,80) mid — red and
         * green within 4 of each other, i.e. khaki. Ours was rgb(136,196,85),
         * green 60 above red, and that one ratio is most of why it read as a
         * different game.
         */
        terrain: {
            // grassLow: 0x87834d,
            grassLow: 0x6a874d,
            grassHigh: 0xb7b562,
            dirt: 0x7a4f2a,
            // rock: 0xa09272,
            rock: 0xd3ad89,
        },
        road: 0x3c3c44,
        roadLine: 0xe8e4cf,
        car: {
            body: 0xe14b3c,
            cabin: 0x27384f,
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
         * BALANCE: the lateral speed a bend demands is
         * `amplitude × frequency × car speed` — here 0.2 × speed — and it has to
         * stay under `steering.maxLateralSpeed` (12) or the road outruns the car
         * and the player is pinned to the edge with no recovery.
         *
         * At amplitude 8 that ceiling is **60 m/s (216 km/h)**, below the 66 m/s
         * top speed. Before the brake existed that made 8 unholdable and it was
         * dropped to 4.5. WITH a brake it becomes the mechanic: the sharpest
         * bends cannot be taken flat out, so the player has to come off the gas.
         * Re-check the ratio whenever amplitude, frequency, max speed or
         * maxLateralSpeed moves.
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
        chunkSize: 40,
        /** Vertices per chunk edge. Cost scales with the square of this. */
        resolution: 17,
        /**
         * Chunks across, centred on the road. Must cover the view frustum at
         * the far edge or you see the terrain's lateral boundary: in portrait
         * the horizontal FOV is only ~42°, so the view is ±106m wide at 280m.
         * KEEP THIS EVEN — chunks are indexed by their min corner, so an even
         * count straddles x=0 and an odd one sits lopsided.
         */
        chunksWide: 6,
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
         * speed / chunkSize — one row per 40m travelled however far ahead it
         * sits. It costs resident memory and triangles only.
         */
        chunksAhead: 7,
        chunksBehind: 1,
        /**
         * Depth of the downward wall hung off each chunk's border, hiding any
         * crack between neighbours. Unnecessary while every chunk is the same
         * resolution, but it's what makes the Phase 7 LOD tiers a drop-in.
         */
        skirtDepth: 5,
        /** Hard cap on chunk rebuilds per frame — the anti-hitch dial. */
        maxBuildsPerFrame: 1,
        /**
         * PLACEHOLDER hills — a cheap 3-octave sine field. Phase 6 replaces
         * `ambientHeightAt` with the ported fbm + ridged-mountain field from
         * Procedural_3D_world, at which point `amplitude`/`baseFrequency` go
         * away and the slope thresholds below need re-tuning against it.
         *
         * `baseFrequency` is the reciprocal of a wavelength: 0.045 is a ~140m
         * lowest octave, with the two above it at ~58m and ~24m. Keep the
         * lowest octave's wavelength WELL under the visible distance
         * (chunkSize * chunksAhead) or the terrain reads as a flat tilt rather
         * than as hills — at 0.016 the wavelength was 393m against ~150m of
         * visible ground, and it looked like a plane.
         */
        amplitude: 5.5,
        baseFrequency: 0.045,

        /**
         * Mountains — a selective, much larger height term on top of the hills.
         *
         * Structure ported from `Procedural_3D_world/src/terrain/ambientHeight.js`:
         * a low-frequency REGION mask decides where a range exists at all, a
         * DISTANCE mask keeps ranges off the roadside, and the shape is a ridged
         * field sampled on a rotated, anisotropically squashed domain so peaks
         * read as elongated chains instead of a field of isotropic bumps. The
         * height is a broad massif hump plus sharp ridge detail on top — without
         * the hump, ridge noise alone fades to bumps at the mask edges instead of
         * a mountain with a base.
         *
         * The steep faces this produces are what trip the rock colour band, which
         * gentle hills never reach — so this is also what makes rock read as rock.
         */
        mountains: {
            /** Peak height above the hills, metres. */
            amplitude: 30,
            /** Region mask: low frequency, thresholded. Wavelength ~1800m. */
            regionFrequency: 0.0035,
            threshold: 0.5,
            /** Half-width of the smoothstep either side of `threshold`. */
            thresholdBand: 0.18,
            /** Ridge detail frequency. Wavelength ~630m. */
            ridgeFrequency: 0.010,
            /** How much a range is squashed across its own strike direction. */
            ridgeSquash: 1.65,
            /** Exponent on the ridge — higher is sharper peaks, deeper gullies. */
            sharpness: 2.2,
            /**
             * Mountains start rising this far from the road centre and reach full
             * height by the second value. Must comfortably exceed the flattened
             * corridor plus shoulder (~18m) or a range becomes a wall at the
             * verge; but the view frustum is only ±21°, so pushing them too far
             * out means they're only ever seen deep in the fog.
             */
            distanceStart: 38,
            distanceFull: 105,
            /**
             * How much the small hill octaves are damped inside a mountain
             * region, so their bumps don't fight the ridge's own shape.
             */
            baseSuppression: 0.65,
        },

        /**
         * Where grass gives way to dirt and then to bare rock, in units of
         * terrain SLOPE (rise over run) rather than normal components — 0 is
         * dead flat, 1 is a 45° face. Converted to normal thresholds once at
         * module load.
         *
         * These have to be set against the slopes the height field actually
         * produces: the first pass used thresholds borrowed from P3W's
         * mountainous valley, which this gentle roadside terrain never reached,
         * so dirt and rock were unreachable and everything was uniformly green.
         */
        /*
         * Set against the measured slope distribution of the field above
         * (median 0.24, p90 0.45, max 0.78): grass dominates ~63% of the
         * ground, dirt is a real but secondary presence, and rock is a rare
         * accent on the steepest faces only. Lowering these browns the whole
         * world out fast — at 0.14/0.34 dirt covered 80% of the ground.
         */
        dirtSlopeStart: 0.20,
        dirtSlopeFull: 0.42,
        /*
         * Rock has been tuned down twice, because it kept landing where nobody
         * looks. Measured on the real vertex grid:
         *
         *  - 0.42-0.66: 4% mean blend. Invisible.
         *  - 0.32-0.56: 51% mean blend in a 5m strip on the SHOULDER (the steep
         *    drop from road corridor to terrain) but only 11% on the hills —
         *    so what rock existed hugged the road edge, two vertices wide, and
         *    read as edge shading rather than as stone.
         *  - 0.24-0.42: 27% on the hills. Confirmed present via
         *    `debug.showSlopeBands` — large solid bands on both sides.
         *  - 0.28-0.48 (here): 18% on the hills, and still saturating on the
         *    shoulder. A compromise, because a debug screenshot showed BOTH
         *    zones are visible from the chase camera, so covering only one was
         *    the wrong trade in either direction.
         *
         * The reason rock looked absent was never coverage — it was `world.fogDensity`
         * washing mid-distance terrain to sky colour. See that setting.
         *
         * Nudged down again when chunk normals moved from analytic central
         * differences (0.4m) to differencing the sampled grid (2.5m) for a 6.3x
         * build speedup. Averaging slope over the vertex spacing lowers it
         * slightly, which cost ~4 points of coverage; 0.20-0.42 and 0.25-0.45
         * restore it to within half a point (dirt 27.5% vs 28.0%, rock 20.4%
         * vs 19.8%).
         *
         * Note this is tuned to PLACEHOLDER hills, whose slopes are gentle.
         * Phase 6's ported ridged-mountain field has genuinely steep faces and
         * will need these raised again, or the world turns grey.
         */
        rockSlopeStart: 0.25,
        rockSlopeFull: 0.45,
        /**
         * Rock also takes over by ALTITUDE, regardless of slope. Slope alone is
         * enough for hills, but a mountain has broad gentle flanks high up that
         * would otherwise be bright grass — a green mountain reads wrong, and the
         * point of raising the terrain was to get rock.
         */
        rockAltitudeStart: 12,
        rockAltitudeFull: 30,
    },

    /**
     * Traffic. Vehicles travel the SAME direction as the player, slower, so the
     * game is about weaving through and overtaking rather than head-on dodging.
     *
     * `laneCount` positions traffic only — the player still moves freely across
     * the road (§6 D2) rather than snapping between lanes.
     */
    traffic: {
        laneCount: 4,
        /** Ceiling on live vehicles; the pool is allocated to exactly this. */
        maxAlive: 16,
        /**
         * Where new vehicles appear, metres ahead of the player. Far enough that
         * they emerge from the fog with time to react, and inside the terrain
         * draw distance so they never hang in empty space.
         */
        spawnAhead: 210,
        /** Recycled once this far behind the player. */
        despawnBehind: 45,
        /**
         * Also recycled once this far AHEAD. Required, not symmetry for its own
         * sake: any vehicle faster than the player recedes forever and, with
         * only a behind-test, would hold its pool slot for the rest of the run
         * until no new traffic could spawn at all. Every type below is slower
         * than `speed.start`, so this should never fire — it's the backstop for
         * a reskin that raises a traffic speed above the player's opening pace.
         */
        despawnAhead: 270,
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
            /**
             * Required clear gap in the target lane, ahead of and behind the
             * mover. This pair is the whole balance, measured over 108km of
             * simulation per setting:
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
            /** Indicator light on the rear corner of the side being moved toward. */
            indicatorSize: 0.42,
            indicatorColor: 0xffb020,
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
            { name: 'car', width: 1.9, height: 0.95, length: 4.2, speedMin: 17, speedMax: 21, weight: 5, color: 0x3f7fbf },
            { name: 'coupe', width: 1.8, height: 0.85, length: 3.9, speedMin: 19, speedMax: 23, weight: 3, color: 0xd8b23a },
            { name: 'van', width: 2.1, height: 1.7, length: 5.4, speedMin: 14, speedMax: 18, weight: 3, color: 0xe3e0d6 },
            { name: 'bus', width: 2.4, height: 2.5, length: 9.0, speedMin: 12, speedMax: 15, weight: 2, color: 0xc25b3a },
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
        bandsAhead: 15,
        bandsBehind: 2,
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
     * Speed ramp. Metres per second — multiply by 3.6 for the km/h readout.
     * 22 m/s ≈ 79 km/h, 66 m/s ≈ 238 km/h.
     */
    /**
     * Speed is now player-controlled: gas accelerates, brake decelerates, and
     * releasing both coasts down. The old automatic ramp is gone — the ramp was
     * what made the run get harder on its own, and that job now belongs to the
     * fuel timer plus the fact that bends can't be held at full speed.
     *
     * `min` is above the FASTEST traffic (23 m/s) on purpose. If the player
     * could brake below traffic speed, vehicles would overtake from behind and
     * hit them from a direction they can't see — an unfair death, and the one
     * thing worth designing out (§5.5a).
     */
    speed: {
        start: 30,
        min: 24,
        max: 66,
        /** m/s² under gas. 7 takes 24 -> 66 in about six seconds. */
        accelerate: 7,
        /** m/s² under brake. Deliberately much stronger than the gas. */
        brake: 14,
        /** m/s² with neither held. */
        coastDrag: 3,
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

    /**
     * On-screen controls: steering at the bottom left, throttle at the bottom
     * right, thumbs in the corners.
     *
     * X positions are derived at build time from the LIVE design width, not from
     * these numbers — under FIXED_HEIGHT the design width varies with aspect
     * ratio (a 19.5:9 phone gives ~591 units against the nominal 720). A first
     * pass placed them at fixed offsets from the centre, which put the left
     * button at x = -5 on a narrow screen, i.e. off the display entirely.
     *
     * A node's position is the hit box's CORNER, not its centre
     * (`InputListener._hitAABB` tests `0 <= local <= width/height`), and y is
     * measured UP from the bottom.
     */
    controls: {
        size: 150,
        /** Glyph size inside a button. */
        glyphSize: 62,
        color: '#f2f6f8',
        pressedColor: '#ffd24a',
        /** Gap from the screen edge, and between the two steering buttons. */
        edgeMargin: 26,
        buttonGap: 12,
        /** Heights of the bottom-left corners (y runs UP from the bottom). */
        steerY: 140,
        gasY: 250,
        brakeY: 80,
    },


    /**
     * Steering. Free lateral movement clamped to the road edges (§6 D2), with
     * the lateral velocity itself damped so the car has weight rather than
     * snapping to the input.
     */
    steering: {
        /** Peak sideways speed, m/s. */
        maxLateralSpeed: 12,
        /** Exponential damping rate on lateral velocity — higher = twitchier. */
        response: 9,
        /** Cosmetic body roll at full lateral speed, radians. */
        rollFactor: 0.16,
        /** Cosmetic nose yaw at full lateral speed, radians. */
        yawFactor: 0.11,
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

    /** Player car dimensions — placeholder boxes until FBX models land. */
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
        /**
         * Exponential damping rate on the car's height, pitch and roll as it
         * rides the ground — i.e. its suspension. Required, not polish: the
         * terrain's smallest octave has a 24m wavelength, and at 66 m/s that is
         * nearly 3 bumps a second. Reading the ground undamped makes the car
         * jitter hard the moment it leaves the road. Lower = softer.
         */
        suspensionRate: 8,
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
        height: 4.4,
        distance: 8.2,
        /** Look-at target height, and how far down the road it sits. */
        lookHeight: 1.3,
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
            hour: 4,
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
         * Real-time shadow maps. The most expensive thing in the renderer for
         * the least gameplay value at this camera angle, so this is a deliberate
         * on/off knob rather than something assumed.
         *
         * `frustumRadius` is the half-extent of the orthographic shadow camera.
         * It has to cover the ground the player can actually see shadows on —
         * too large and the map's texels stretch until shadows go blocky, too
         * small and shadows pop in a few metres ahead of the car. The camera
         * FOLLOWS the car, so this bounds the near field, not the draw distance.
         */
        shadows: {
            /**
             * Re-enabled to be re-measured. These were switched OFF in the
             * "back to 60fps on device" pass, but at 1024/70m — the numbers
             * below are the tuned-down replacements that were never actually
             * verified with shadows on. Depth-pass fill scales with mapSize^2,
             * so 512 is a quarter of what was measured as costing ~8.9ms.
             * Check `frame` and `worst` on the phone; if it regresses, this
             * flag is the one to flip, not the map size.
             */
            enabled: true,
            /**
             * 512, not 1024. Measured at ~8.9ms a frame on a low-end phone at
             * 1024 with a 70m frustum — a third of a 42ms regression. Halving
             * the map quarters the fill of the depth pass, and halving the
             * frustum with it keeps texel density (and therefore edge quality)
             * roughly where it was.
             */
            mapSize: 512,
            frustumRadius: 40,
            near: 1,
            far: 260,
            /** Peter-panning vs acne. normalBias is the safer of the two dials. */
            bias: -0.0005,
            normalBias: 0.6,
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
        heightMax: 14,
        trunkRadiusK: 0.035,
        canopyRadiusK: 0.30,
        tiersMin: 2,
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
        trunkColor: 0x5c4a42,
        foliageLowColor: 0x485b38,
        foliageHighColor: 0xa4aa58,

        /** Average metres between placement candidates, before rejection. */
        spacing: 18,
        /** Candidates on ground steeper than this are rejected. */
        maxSlope: 0.55,
        /**
         * Clearance from the road centre. Must exceed the flattened corridor, or
         * trees grow out of the verge and the player clips scenery that looks
         * like it's beside the road rather than on it.
         */
        roadClearance: 15,
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
        lodCrossover: 200,
        /** Baked impostor texture edge, pixels. */
        spriteTextureSize: 128,
        /** Ceiling on live billboards. Cheap enough to be generous. */
        maxFarInstances: 700,
        /** Sunk slightly so the trunk grows out of the ground, not onto it. */
        sinkDepth: 0.25,
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
        /** Moon disc and halo, same form. 8000 is a ~1.6 degree disc. */
        moonGlow: {
            discAmp: 1.6,
            discExp: 8000,
            haloAmp: 0.06,
            haloExp: 300,
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
             */
            minElevation: 6,
            maxElevation: 24,
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
        showPerf: true,
    },

    /**
     * Renderer/perf knobs handed straight to GameEngine's config. Uncapped
     * devicePixelRatio is the single biggest fill-rate mistake available on
     * mobile — see ARCHITECTURE.md §2.4.
     */
    render: {
        pixelRatioCap: 2,
        resolutionScale: 1,
        /** Real-time shadow maps are off by default — see ARCHITECTURE.md §5.9. */
        shadows: false,
    },
};
