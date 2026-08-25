import { gameConfig as cfg } from '../config/gameConfig';
import { WorldScroll } from '../world/WorldScroll';

/** What the run is currently doing. */
export const enum RunPhase {
    RUNNING = 0,
    CRASHED = 1,
    OUT_OF_FUEL = 2,
}

/**
 * GameState — the run's speed, fuel, distance and phase.
 *
 * Speed is driven by the player's throttle rather than ramping on its own, and
 * the pressure that used to come from an automatic ramp now comes from two
 * places: fuel burns whether or not you're moving, and the sharpest bends can't
 * be held at full speed. Distance is the integral of speed and the score's base.
 */
export class GameState {

    /** Current forward speed, m/s. */
    speed = cfg.speed.start;

    /** Seconds of fuel remaining. */
    fuel = cfg.fuel.capacity;

    phase: RunPhase = RunPhase.RUNNING;

    readonly scroll = new WorldScroll();

    /** 0 at the slowest the car can go, 1 at its top speed. */
    get speedT(): number {
        const range = cfg.speed.max - cfg.speed.min;
        return range <= 0 ? 1 : (this.speed - cfg.speed.min) / range;
    }

    /** 1 on a full tank, 0 empty. */
    get fuelT(): number {
        return Math.max(0, this.fuel / cfg.fuel.capacity);
    }

    /** Metres travelled — the score. */
    get distance(): number {
        return this.scroll.travelled;
    }

    get isRunning(): boolean { return this.phase === RunPhase.RUNNING; }

    /**
     * @param throttle +1 gas, -1 brake, 0 coasting.
     */
    update(dt: number, throttle: number): void {
        const s = cfg.speed;
        const rate = throttle > 0 ? s.accelerate
            : throttle < 0 ? -s.brake
            : -s.coastDrag;
        this.speed = Math.max(s.min, Math.min(s.max, this.speed + rate * dt));
        this.scroll.advance(this.speed * dt);

        // Burns on time, not distance — that's what makes speed worth having.
        this.fuel -= dt;
        if (this.fuel <= 0) {
            this.fuel = 0;
            this.phase = RunPhase.OUT_OF_FUEL;
        }
    }

    /**
     * Ends the run. The world stops dead rather than coasting: a crash that
     * keeps scrolling reads as a bug, and the player's attention is on the
     * result, not on the deceleration.
     *
     * An already-terminal phase is preserved. `update` sets `OUT_OF_FUEL` itself
     * when the tank empties, and calling this afterwards must not relabel that
     * run as a crash.
     */
    end(phase: RunPhase = RunPhase.CRASHED): void {
        if (this.phase === RunPhase.RUNNING) this.phase = phase;
        this.speed = 0;
    }

    reset(): void {
        this.speed = cfg.speed.start;
        this.fuel = cfg.fuel.capacity;
        this.phase = RunPhase.RUNNING;
        this.scroll.reset();
    }
}
