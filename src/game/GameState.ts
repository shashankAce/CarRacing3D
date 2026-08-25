import { gameConfig as cfg } from '../config/gameConfig';
import { WorldScroll } from '../world/WorldScroll';

/** What the run is currently doing. */
export const enum RunPhase {
    RUNNING = 0,
    CRASHED = 1,
}

/**
 * GameState — the run's speed ramp, distance and phase.
 *
 * Speed climbs at a constant rate to a hard cap, which is what makes an
 * infinite runner get harder without ever becoming unplayable. Distance is
 * just the integral of speed, and the base of the score.
 */
export class GameState {

    /** Current forward speed, m/s. */
    speed = cfg.speed.start;

    phase: RunPhase = RunPhase.RUNNING;

    readonly scroll = new WorldScroll();

    /** 0 at the start of the run, 1 once `speed.max` is reached. */
    get speedT(): number {
        const range = cfg.speed.max - cfg.speed.start;
        return range <= 0 ? 1 : (this.speed - cfg.speed.start) / range;
    }

    /** Metres travelled — the score. */
    get distance(): number {
        return this.scroll.travelled;
    }

    get isRunning(): boolean { return this.phase === RunPhase.RUNNING; }

    update(dt: number): void {
        this.speed = Math.min(cfg.speed.max, this.speed + cfg.speed.acceleration * dt);
        this.scroll.advance(this.speed * dt);
    }

    /**
     * Ends the run. The world stops dead rather than coasting: a crash that
     * keeps scrolling reads as a bug, and the player's attention is on the
     * result, not on the deceleration.
     */
    crash(): void {
        this.phase = RunPhase.CRASHED;
        this.speed = 0;
    }

    reset(): void {
        this.speed = cfg.speed.start;
        this.phase = RunPhase.RUNNING;
        this.scroll.reset();
    }
}
