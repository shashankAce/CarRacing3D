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
        sky: 0x9ad1e5,
        /** Match `fog` to `sky` or the far plane reads as a hard edge. */
        fog: 0x9ad1e5,
        ground: 0x6a9b57,
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
         * BALANCE: amplitude and frequency are not free. The lateral speed a
         * bend demands is `amplitude × frequency × car speed`, and it must stay
         * comfortably under `steering.maxLateralSpeed` or the road outruns the
         * car at top speed and the player is pinned to the edge with no
         * recovery available. At amplitude 8 the demand was 13.2 m/s against a
         * 12 m/s maximum — literally unholdable. 4.5 asks for 7.4 m/s, i.e.
         * 62% of max, which leaves room to correct. Re-check this ratio
         * whenever any of the three numbers moves.
         */
        curveAmplitude: 4.5,
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
         * Draw distance, in chunks. Derived FROM `world.fogDensity`, not chosen
         * independently: the spawn edge has to be far enough out that fog hides
         * essentially all of it, or chunks visibly pop into view. At density
         * 0.007, fog hides 86% at 160m — and that remaining 14% was plainly
         * visible as terrain and road appearing ahead of the car. 7 chunks =
         * 280m, where 97.9% is hidden.
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
         * resolution, but it's what makes the Phase 6 LOD tiers a drop-in.
         */
        skirtDepth: 5,
        /** Hard cap on chunk rebuilds per frame — the anti-hitch dial. */
        maxBuildsPerFrame: 1,
        /**
         * PLACEHOLDER hills — a cheap 3-octave sine field. Phase 5 replaces
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
        dirtSlopeStart: 0.22,
        dirtSlopeFull: 0.44,
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
         * Note this is tuned to PLACEHOLDER hills, whose slopes are gentle.
         * Phase 5's ported ridged-mountain field has genuinely steep faces and
         * will need these raised again, or the world turns grey.
         */
        rockSlopeStart: 0.28,
        rockSlopeFull: 0.48,
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
    },

    /**
     * Speed ramp. Metres per second — multiply by 3.6 for the km/h readout.
     * 22 m/s ≈ 79 km/h, 66 m/s ≈ 238 km/h.
     */
    speed: {
        start: 22,
        max: 66,
        /** m/s² — constant until `max`, so time-to-max = (max - start) / accel. */
        acceleration: 1.6,
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
        /** Design space is top-left origin, Y-DOWN. Small y = top of screen. */
        distanceY: 90,
        speedY: 150,
        hintY: 1180,
        distanceFontSize: 62,
        speedFontSize: 34,
        hintFontSize: 26,
        textColor: '#ffffff',
        hintColor: '#d8e6ee',
        hintText: 'HOLD LEFT / RIGHT TO STEER',
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
        near: 0.5,
        far: 260,
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

    lighting: {
        ambientColor: 0x9fb8c8,
        ambientIntensity: 1.5,
        sunColor: 0xfff2dd,
        sunIntensity: 2.2,
        /** Sun direction, as a position offset from the origin. */
        sunPosition: { x: 30, y: 60, z: 25 },
    },

    world: {
        /**
         * THREE.FogExp2 density — the fraction of a surface's colour replaced
         * by sky is 1 - exp(-(density * dist)²).
         *
         * This is a direct trade against `terrain.chunksAhead`: fog has to be
         * thick enough at the draw edge that chunks don't pop into view, and
         * thin enough nearer in that terrain keeps its colour. The first pass
         * optimised only the first half — 0.010 with a 200m edge — and that is
         * 47% fogged at 80m and 76% at 120m, which is where nearly all visible
         * terrain sits. It washed the whole world pale and made the rock band
         * look like it wasn't being generated at all (it was; a debug capture
         * settled it).
         *
         * 0.007 hits the near-field target — 27% hidden at 80m, 51% at 120m —
         * so terrain keeps its colour. But then the DRAW EDGE has to move out to
         * match it: at this density 160m only hides 86%, and that visible 14%
         * is exactly the pop-in you get. See `terrain.chunksAhead`, which is
         * derived from this number. Change one, re-derive the other.
         */
        fogDensity: 0.007,
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
