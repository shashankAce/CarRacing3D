import { gameConfig as cfg } from './gameConfig';

/**
 * resolveTimeOfDay — turns an hour into the scene's lighting, once, at boot.
 *
 * This exists because the sky work left exactly one input driving the whole
 * look: a light direction. The dome's gradient reads it, the scene's fog and
 * background are DERIVED from it, and the light and its shadow frustum are
 * placed along it. So a time of day is a pair of vectors — sun and moon — and
 * everything downstream follows.
 *
 * It writes back into `gameConfig` rather than threading a resolved object
 * through a dozen call sites. That keeps the reskin contract honest — everything
 * still lives in one config — at the cost of the fields marked RESOLVED AT BOOT
 * being derived rather than literal. Nothing mutates them after this runs.
 *
 * ## A real solar path, not a stylised arc
 *
 * The first version swept a sine between a configured sunrise and sunset with a
 * hand-picked azimuth range. It could not produce a correct day: a sweep that
 * does not straddle the view direction puts the sun on the SAME SIDE morning and
 * evening, and no width of sweep fixes that.
 *
 * This computes the actual solar position from `latitude`, `declination` and the
 * hour angle, so sunrise and sunset are on opposite horizons by construction and
 * the sun's height and speed follow from where on Earth you claim to be. The one
 * artistic input is `sunsetOffsetDegrees`, which rotates the whole sky so the day
 * ENDS at a chosen angle to the camera — that single rotation is what fixes the
 * car's compass heading, and everything else is then physics.
 *
 * ## Night
 *
 * The moon is the sun's antipode, which is where a full moon is: opposite
 * azimuth, mirrored elevation. So it rises as the sun sets and follows the same
 * arc twelve hours out of phase, for free, with no second model.
 *
 * Below the horizon the moon takes over as the light source. Two things must NOT
 * be driven off the light direction once that happens:
 *
 *  - **The sky palette.** Blending it off the light's height would brighten the
 *    sky toward the DAY colours at midnight, because the moon is then high. The
 *    sky blends off `sky.dayFactor`, computed from the SUN's height regardless of
 *    what is lighting the scene.
 *  - **The sun glow.** The dome gets `sky.sunDirection` and `sky.moonDirection`
 *    separately from the lighting direction, so it can gate the glow off and draw
 *    the moon instead.
 *
 * Because the hour is resolved ONCE at boot, the sun/moon handover never happens
 * mid-session and needs no crossfade — only the palette blends, across the
 * twilight band, so a dusk hour still looks like dusk rather than snapping.
 */

const DEG = Math.PI / 180;

export interface ResolvedTimeOfDay {
    /** Hour actually used, 0-24. */
    hour: number;
    /** Sun elevation above the horizon, degrees. Negative at night. */
    sunElevation: number;
    /** Compass azimuth of the sun, degrees from north, eastward. */
    sunAzimuth: number;
    /** Which body is currently lighting the scene. */
    light: 'sun' | 'moon';
    /** 0 at night through 1 at solar noon — what the sky palette blends on. */
    dayFactor: number;
    source: 'fixed' | 'local';
}

let resolved: ResolvedTimeOfDay | null = null;

/** What the last `resolveTimeOfDay()` decided. Null before boot. */
export function resolvedTimeOfDay(): ResolvedTimeOfDay | null {
    return resolved;
}

/**
 * Standard solar position. `azimuth` is a compass bearing: 0 north, 90 east,
 * 180 south, 270 west — so at an equinox the sun rises at 90 and sets at 270,
 * which is what pins the rest of the model to something checkable.
 */
function solarPosition(hour: number, latDeg: number, decDeg: number) {
    // Hour angle: 0 at solar noon, +15 degrees per hour after it.
    const H = (hour - 12) * 15 * DEG;
    const phi = latDeg * DEG;
    const dec = decDeg * DEG;

    const sinElev = clamp(
        Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H),
        -1, 1,
    );
    const elev = Math.asin(sinElev);
    const cosElev = Math.cos(elev);

    let azimuth = 180;
    if (Math.abs(cosElev) > 1e-6 && Math.abs(Math.cos(phi)) > 1e-6) {
        const sinAz = -Math.cos(dec) * Math.sin(H) / cosElev;
        const cosAz = (Math.sin(dec) - Math.sin(phi) * sinElev) / (Math.cos(phi) * cosElev);
        azimuth = Math.atan2(sinAz, cosAz) / DEG;
    }
    return { elevation: elev / DEG, azimuth: (azimuth + 360) % 360 };
}

/**
 * Compass azimuth of the sun at sunset, i.e. where its elevation crosses zero
 * descending. Solved rather than assumed, so `sunsetOffsetDegrees` still means
 * what it says at any declination — it is only 270 at an equinox.
 */
function sunsetAzimuth(latDeg: number, decDeg: number): number {
    const phi = latDeg * DEG;
    const dec = decDeg * DEG;
    // cos(H) at elevation 0. Outside [-1,1] means the sun never sets (polar
    // summer) or never rises; fall back to due west so the scene stays lit.
    const cosH = -Math.tan(phi) * Math.tan(dec);
    if (cosH < -1 || cosH > 1) return 270;
    const H = Math.acos(cosH);
    const sinAz = -Math.cos(dec) * Math.sin(H);
    const cosAz = Math.sin(dec) / Math.cos(phi);
    return ((Math.atan2(sinAz, cosAz) / DEG) + 360) % 360;
}

export function resolveTimeOfDay(): ResolvedTimeOfDay {
    const t = cfg.lighting.timeOfDay;

    // Narrowed here rather than asserted in the config, so `mode` can be written
    // as a plain string in a file people hand-edit.
    const source: 'fixed' | 'local' = t.mode === 'local' ? 'local' : 'fixed';
    const hour = source === 'local' ? localHour() : clamp(t.hour, 0, 24);

    const sun = solarPosition(hour, t.latitude, t.declination);

    // Rotate the whole sky so sunset lands at the requested angle to the camera.
    // Engine azimuth 180 is dead ahead (the camera looks down -Z) and x =
    // sin(azimuth), so BELOW 180 is screen right and above it screen left.
    const rotation = sunsetAzimuth(t.latitude, t.declination) - (180 - t.sunsetOffsetDegrees);
    const sunEngineAz = sun.azimuth - rotation;

    // The moon is the sun's antipode — a full moon's actual place.
    const moonEngineAz = sunEngineAz + 180;
    const moonElevation = -sun.elevation;

    cfg.sky.sunDirection = direction(sunEngineAz, sun.elevation);
    cfg.sky.moonDirection = direction(moonEngineAz, moonElevation);

    // How far into night we are: 0 while the sun is up, 1 once it is past
    // `twilightEndDegrees`. Everything nocturnal blends on this.
    const night = clamp(sun.elevation / Math.min(-0.001, t.twilightEndDegrees), 0, 1);
    const light: 'sun' | 'moon' = night >= 1 ? 'moon' : 'sun';

    // The scene's light: the sun while it is up, the moon once it is not. The
    // handover is safe without a crossfade only because the hour is fixed at
    // boot and never advances mid-session.
    if (light === 'moon') {
        cfg.lighting.sunDirection = cfg.sky.moonDirection;
        cfg.lighting.sunColor = cfg.lighting.moonColor;
        cfg.lighting.sunIntensity = cfg.lighting.sunIntensity * cfg.lighting.moonIntensity;
    } else {
        cfg.lighting.sunDirection = cfg.sky.sunDirection;
    }

    // Sky blend factor, from the SUN's height and never the light's. Normalised
    // against the day's own peak so solar noon lands on exactly the tuned
    // daylight palette rather than near it.
    const peakElev = 90 - Math.abs(t.latitude - t.declination);
    const peak = Math.sin(Math.max(1, peakElev) * DEG);
    const dayFactor = clamp(Math.sin(Math.max(0, sun.elevation) * DEG) / peak, 0, 1);
    cfg.sky.dayFactor = dayFactor;

    // Which side of solar noon we are on. Sun HEIGHT alone cannot tell 4am from
    // 8pm — both are a low sun — so without this, pre-dawn renders as the same
    // warm orange as sunset, which reads as plainly wrong when you know the time.
    const morning = Math.sin((hour - 12) * 15 * DEG) < 0;
    const lowHorizon = morning ? cfg.sky.horizonDawnColor : cfg.sky.horizonSunsetColor;
    const lowZenith = morning ? cfg.sky.zenithDawnColor : cfg.sky.zenithSunsetColor;
    const lowCloud = morning ? cfg.sky.clouds.dawnColor : cfg.sky.clouds.sunsetColor;

    // Twilight: the low-sun palette gives way to the night one across the band,
    // so an hour just after sunset still reads as dusk.
    cfg.sky.horizonLowColor = lerpHex(lowHorizon, cfg.sky.horizonNightColor, night);
    cfg.sky.zenithLowColor = lerpHex(lowZenith, cfg.sky.zenithNightColor, night);
    cfg.sky.clouds.lowColor = lerpHex(lowCloud, cfg.sky.clouds.nightColor, night);

    // Ambient: low-sun value up to the tuned daylight one by dayFactor, then
    // toward the night pair as the sun goes under. Ambient is the floor under
    // every shadowed face, so it is what stops night being unreadably dark.
    const ambientLow = morning ? cfg.lighting.ambientColorLowDawn : cfg.lighting.ambientColorLow;
    const dayIntensity = lerp(cfg.lighting.ambientIntensityLow, cfg.lighting.ambientIntensity, dayFactor);
    const dayColor = lerpHex(ambientLow, cfg.lighting.ambientColor, dayFactor);
    cfg.lighting.ambientIntensity = lerp(dayIntensity, cfg.lighting.ambientIntensityNight, night);
    cfg.lighting.ambientColor = lerpHex(dayColor, cfg.lighting.ambientColorNight, night);

    resolved = {
        hour,
        sunElevation: sun.elevation,
        sunAzimuth: sun.azimuth,
        light,
        dayFactor,
        source,
    };
    return resolved;
}

/** Engine-space unit vector from an engine azimuth and an elevation, degrees. */
function direction(azimuthDeg: number, elevationDeg: number) {
    const el = elevationDeg * DEG;
    const az = azimuthDeg * DEG;
    const cosEl = Math.cos(el);
    return { x: Math.sin(az) * cosEl, y: Math.sin(el), z: Math.cos(az) * cosEl };
}

/** Device-local hour, fractional. The ONLY place real time enters the game. */
function localHour(): number {
    const now = new Date();
    return now.getHours() + now.getMinutes() / 60;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Blends two packed hex colours, channel-wise in sRGB space on purpose: these
 * are authored colours being mixed to pick another authored colour, not light
 * being combined, so the gamma-space result is the one that matches what the two
 * endpoints look like.
 */
function lerpHex(a: number, b: number, t: number): number {
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    return (Math.round(lerp(ar, br, t)) << 16)
        | (Math.round(lerp(ag, bg, t)) << 8)
        | Math.round(lerp(ab, bb, t));
}
