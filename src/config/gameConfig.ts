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

    /** Road geometry. `halfWidth` is the lateral clamp on the player. */
    road: {
        halfWidth: 7,
        /** Painted edge line width, each side. */
        lineWidth: 0.25,
    },

    /**
     * Speed ramp. Metres per second — multiply by 3.6 for the km/h readout.
     * 18 m/s ≈ 65 km/h, 55 m/s ≈ 200 km/h.
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
     * Phase 2's terrain streamer will reuse.
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
            count: 40,
            width: 0.22,
            length: 3.0,
        },
        /** Roadside posts — the strongest speed cue, because they pass close by. */
        post: {
            spacing: 10,
            count: 24,
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
        /** Placeholder flat ground extent (Phase 0 only — replaced by streamed chunks in Phase 2). */
        groundSize: 400,
        /** THREE.FogExp2 density. Tuned against `camera.far` to hide the far plane (§5.8). */
        fogDensity: 0.006,
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
