import { gameConfig as cfg } from '../config/gameConfig';
import { WorldScroll } from '../world/WorldScroll';

type PlayerSpeedProfile = Readonly<{
    start: number;
    min: number;
    max: number;
    accelerate: number;
    brake: number;
    autoBrake: number;
}>;

const DEFAULT_SPEED_PROFILE = cfg.vehicles.models.find((model) => model.id === cfg.vehicles.playerDefault)?.speed
    ?? cfg.vehicles.models[0].speed;

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

    /** Active player vehicle's complete speed profile. */
    private _speedProfile: PlayerSpeedProfile = DEFAULT_SPEED_PROFILE;

    /** Current forward speed, m/s. */
    speed = this._speedProfile.start;

    /** Seconds of fuel remaining. */
    fuel = cfg.fuel.capacity;

    phase: RunPhase = RunPhase.RUNNING;

    readonly scroll = new WorldScroll();

    /** 0 at the slowest the car can go, 1 at its top speed. */
    get speedT(): number {
        const range = this._speedProfile.max - this._speedProfile.min;
        return range <= 0 ? 1 : (this.speed - this._speedProfile.min) / range;
    }

    /** Applies the selected player's config-driven speed profile. */
    setVehicleSpeedProfile(profile: PlayerSpeedProfile): void {
        this._speedProfile = profile;
        this.speed = Math.max(profile.min, Math.min(profile.max, this.speed));
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
     * @param throttle +1 gas/forward, -1 brake/reverse, 0 coast toward rest.
     */
    update(dt: number, throttle: number): void {
        const s = this._speedProfile;
        const rate = throttle > 0 ? s.accelerate
            : throttle < 0 ? -s.brake
            // Release always settles at zero. Applying a fixed negative rate
            // here made a reversed QA car keep accelerating backwards.
            : -Math.sign(this.speed) * s.autoBrake;
        let nextSpeed = this.speed + rate * dt;
        // Do not overshoot rest while coasting, or a small positive/negative
        // speed would flip signs every frame and make the world visibly jitter.
        if (throttle === 0 && this.speed * nextSpeed < 0) nextSpeed = 0;
        this.speed = Math.max(s.min, Math.min(s.max, nextSpeed));
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
        const s = this._speedProfile;
        this.speed = Math.max(s.min, Math.min(s.max, s.start));
        this.fuel = cfg.fuel.capacity;
        this.phase = RunPhase.RUNNING;
        this.scroll.reset();
    }
}
