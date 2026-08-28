import { gameConfig as cfg } from './gameConfig';

export type EnvironmentId = 'forest' | 'desert';

let active: EnvironmentId = cfg.environments.default as EnvironmentId;

export function activeEnvironment(): EnvironmentId {
    return active;
}

export function setActiveEnvironment(id: EnvironmentId): void {
    active = id;
}

export function environmentPreset(id: EnvironmentId = active) {
    return cfg.environments[id];
}

/** Forest follows the time-of-day resolver; desert supplies its warmer authored sky. */
export function environmentSkyPreset(id: EnvironmentId = active) {
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

export function toggleEnvironment(): EnvironmentId {
    active = active === 'forest' ? 'desert' : 'forest';
    return active;
}
