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

    /** TPP follow camera. `followRate` feeds exponential damping (§5.6). */
    camera: {
        fov: 55,
        near: 0.5,
        far: 260,
        /** Offset from the car, in the car's own space. +Z is behind. */
        height: 6.5,
        distance: 10.5,
        /** Look-at target, relative to the car. */
        lookHeight: 1.6,
        lookAhead: 14,
        followRate: 7,
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
