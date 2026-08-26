import { gameConfig as cfg } from './gameConfig';

/**
 * resolveTimeOfDay — turns an hour into the scene's lighting, once, at boot.
 *
 * This exists because the sky work left exactly one input driving the whole
 * look: `lighting.sunDirection`. The dome's gradient reads it, the scene's fog
 * and background are DERIVED from it via `effectiveHorizonColor()`, and the
 * light and its shadow frustum are placed along it. So a time of day is just a
 * vector, and everything downstream follows with no other wiring.
 *
 * It writes back into `gameConfig` rather than threading a resolved object
 * through four call sites. That keeps the reskin contract honest — everything
 * still lives in one config — at the cost of those three fields being
 * boot-resolved rather than literal. They are flagged as such where they are
 * declared. Nothing mutates them after this runs.
 *
 * ## Two things it must not get wrong
 *
 * **Night.** Clamped to `minElevation`, so 3am renders as dusk, never as
 * darkness. A playable has to sell in the first two seconds at whatever hour it
 * opens, and an ad network may review it at any of them.
 *
 * **Dimming.** A low sun stops filling the scene: at 9 degrees an upward
 * terrain normal gets N.L ~ 0.16, so the sun's contribution drops from ~2.29 to
 * ~0.46 and everything goes muddy. Measured on a sunset test, not estimated.
 * Ambient lerps up to compensate — normalised so that solar noon lands on
 * exactly the tuned daylight values rather than near them.
 */

export interface ResolvedTimeOfDay {
    /** Hour actually used, 0-24. */
    hour: number;
    /** Sun elevation above the horizon, degrees, after the night clamp. */
    elevation: number;
    /** True if the night clamp raised the sun above where the curve put it. */
    clamped: boolean;
    source: 'fixed' | 'local';
}

let resolved: ResolvedTimeOfDay | null = null;

/** What the last `resolveTimeOfDay()` decided. Null before boot. */
export function resolvedTimeOfDay(): ResolvedTimeOfDay | null {
    return resolved;
}

export function resolveTimeOfDay(): ResolvedTimeOfDay {
    const t = cfg.lighting.timeOfDay;

    // Narrowed here rather than asserted in the config, so `mode` can be written
    // as a plain string in a file people hand-edit. Anything that is not exactly
    // 'local' falls back to the reproducible path.
    const source: 'fixed' | 'local' = t.mode === 'local' ? 'local' : 'fixed';
    const hour = source === 'local' ? localHour() : clamp(t.hour, 0, 24);

    // Day fraction: 0 at sunrise, 1 at sunset, clamped flat outside.
    const span = Math.max(1e-3, t.sunset - t.sunrise);
    const dayT = clamp((hour - t.sunrise) / span, 0, 1);

    // sin gives 0 at both ends and a smooth peak at midday, which is close
    // enough to a solar arc for a stylised sky and has no discontinuity at
    // either end of the clamp.
    const arc = Math.sin(Math.PI * dayT);
    const uncapped = t.maxElevation * arc;
    const elevation = Math.max(t.minElevation, uncapped);

    // Azimuth sweeps so morning and evening differ by shadow DIRECTION, not
    // only shadow length.
    //
    // This used to be clamped below 90 degrees to keep the sun BEHIND the camera
    // — past 90 the scene turns backlit and the sun enters frame. That is now
    // the intended look, so the clamp only keeps the sweep inside 0..180, i.e.
    // on the +X (screen-right) side. Crossing either end would swing the sun to
    // the left of frame mid-day, which no configuration wants.
    const swing = Math.min(t.azimuthSwing, Math.min(t.azimuthCenter, 180 - t.azimuthCenter));
    const azimuth = t.azimuthCenter + swing * (dayT * 2 - 1);

    const elevRad = elevation * Math.PI / 180;
    const azRad = azimuth * Math.PI / 180;
    const cosEl = Math.cos(elevRad);

    cfg.lighting.sunDirection = {
        x: Math.sin(azRad) * cosEl,
        y: Math.sin(elevRad),
        z: Math.cos(azRad) * cosEl,
    };

    // Which side of solar noon we are on. Sun HEIGHT alone cannot tell 4am from
    // 8pm -- both are a low sun -- so without this, pre-dawn renders as the same
    // warm orange as sunset, which reads as plainly wrong when you know the
    // time. Comparing against solar noon rather than the day fraction also gets
    // the small hours right: 2am is pre-dawn, 11pm is still dusk.
    const solarNoon = (t.sunrise + t.sunset) * 0.5;
    const morning = hour < solarNoon;
    cfg.sky.horizonLowColor = morning ? cfg.sky.horizonDawnColor : cfg.sky.horizonSunsetColor;
    cfg.sky.zenithLowColor = morning ? cfg.sky.zenithDawnColor : cfg.sky.zenithSunsetColor;
    cfg.sky.clouds.lowColor = morning ? cfg.sky.clouds.dawnColor : cfg.sky.clouds.sunsetColor;

    // Ambient compensation, normalised against the arc's own peak so solar noon
    // reproduces the tuned daylight values EXACTLY rather than approximately.
    const peak = Math.sin(t.maxElevation * Math.PI / 180) || 1;
    const k = clamp(Math.sin(elevRad) / peak, 0, 1);
    const ambientLow = morning ? cfg.lighting.ambientColorLowDawn : cfg.lighting.ambientColorLow;
    cfg.lighting.ambientIntensity = lerp(cfg.lighting.ambientIntensityLow, cfg.lighting.ambientIntensity, k);
    cfg.lighting.ambientColor = lerpHex(ambientLow, cfg.lighting.ambientColor, k);

    resolved = { hour, elevation, clamped: uncapped < t.minElevation, source };
    return resolved;
}

/** Device-local hour, fractional. The ONLY place real time enters the game. */
function localHour(): number {
    const now = new Date();
    return now.getHours() + now.getMinutes() / 60;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Blends two packed hex colours. Channel-wise in sRGB space on purpose: these
 * are authored colours being mixed to pick another authored colour, not light
 * being combined, so the gamma-space result is the one that matches what the
 * two endpoints look like.
 */
function lerpHex(a: number, b: number, t: number): number {
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    return (Math.round(lerp(ar, br, t)) << 16)
        | (Math.round(lerp(ag, bg, t)) << 8)
        | Math.round(lerp(ab, bb, t));
}
