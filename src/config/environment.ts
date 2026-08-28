import { gameConfig as cfg } from './gameConfig';

export type EnvironmentId = 'forest' | 'desert';

let currentWorldZ = 0;
let fixedBlend = cfg.environment.default === 'desert' ? 1 : 0;
let phaseOffset = cfg.environment.default === 'desert'
    ? cfg.environment.cycle.forestLength + cfg.environment.cycle.transitionLength
    : 0;

function smoothstep01(value: number): number {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
}

/** 0 is pure forest, 1 is pure desert, and the values between are the blend zone. */
export function biomeBlendAt(worldZ: number): number {
    const cycle = cfg.environment.cycle;
    if (!cycle.enabled) return fixedBlend;

    const transition = Math.max(0.001, cycle.transitionLength);
    const period = cycle.forestLength + cycle.desertLength + transition * 2;
    let phase = ((worldZ + phaseOffset) % period + period) % period;

    if (phase < cycle.forestLength) return 0;
    phase -= cycle.forestLength;
    if (phase < transition) return smoothstep01(phase / transition);
    phase -= transition;
    if (phase < cycle.desertLength) return 1;
    phase -= cycle.desertLength;
    return 1 - smoothstep01(phase / transition);
}

/** Keeps sky/UI resolution tied to the player's absolute position. */
export function setEnvironmentPosition(worldZ: number): void {
    currentWorldZ = worldZ;
}

export function activeEnvironmentBlend(): number {
    return biomeBlendAt(currentWorldZ);
}

export function activeEnvironment(): EnvironmentId {
    return activeEnvironmentBlend() < 0.5 ? 'forest' : 'desert';
}

export function setActiveEnvironment(id: EnvironmentId): void {
    fixedBlend = id === 'desert' ? 1 : 0;
    const cycle = cfg.environment.cycle;
    const desiredPhase = id === 'forest'
        ? 0
        : cycle.forestLength + cycle.transitionLength;
    phaseOffset = desiredPhase - currentWorldZ;
}

/** Forest follows the time-of-day resolver; desert supplies its warmer authored sky. */
export function environmentSkyPreset(id: EnvironmentId = activeEnvironment()) {
    if (id === 'forest') {
        return {
            zenith: cfg.sky.zenithColor,
            zenithLow: cfg.sky.zenithLowColor,
            horizon: cfg.sky.horizonColor,
            horizonLow: cfg.sky.horizonLowColor,
            glow: cfg.sky.sunGlowColor,
        };
    }
    return cfg.environments.desert.sky;
}

/** Resolves the complete shape preset for the active biome. */
export function environmentTerrainPreset(id: EnvironmentId = activeEnvironment()) {
    return cfg.terrain.presets[id];
}

export function toggleEnvironment(): EnvironmentId {
    const next = activeEnvironment() === 'forest' ? 'desert' : 'forest';
    setActiveEnvironment(next);
    return next;
}
