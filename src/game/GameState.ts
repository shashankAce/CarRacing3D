import { gameConfig as cfg } from '../config/gameConfig';
import { WorldScroll } from '../world/WorldScroll';

/**
 * GameState — the run's speed ramp and distance.
 *
 * Speed climbs at a constant rate to a hard cap, which is what makes an
 * infinite runner get harder without ever becoming unplayable. Distance is
 * just the integral of speed, and is also the score.
 */
export class GameState {

    /** Current forward speed, m/s. */
    speed = cfg.speed.start;

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

    update(dt: number): void {
        this.speed = Math.min(cfg.speed.max, this.speed + cfg.speed.acceleration * dt);
        this.scroll.advance(this.speed * dt);
    }

    reset(): void {
        this.speed = cfg.speed.start;
        this.scroll.reset();
    }
}
