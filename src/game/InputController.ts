import { inputListener, Input } from 'noonengine';
import { TouchControls, Control } from '../ui/TouchControls';

const GAS_KEYS = ['ArrowUp', 'KeyW'];
const BRAKE_KEYS = ['ArrowDown', 'KeyS'];
const TAP_KEYS = ['Space', 'Enter'];

/**
 * InputController — samples the steering slider and throttle controls.
 *
 * `axis` is -1 (full left) … +1 (full right); `throttle` is +1 gas, -1 brake, 0
 * coasting. Both are sampled each frame rather than pushed into gameplay from
 * pointer callbacks, so movement remains deterministic between render frames.
 *
 * Steering comes directly from the on-screen slider, so it retains the full
 * analogue range rather than collapsing to held/not-held buttons. Keyboard is
 * retained only for gas, brake and restart during desktop testing.
 *
 * Touch comes from `TouchControls`, which keeps steering and throttle pointers
 * independent for multi-touch play.
 */
export class InputController {

    /** -1 … +1 steering. Read by PlayerCar every frame. */
    axis = 0;

    /** +1 gas, -1 brake, 0 coasting. Read by GameState every frame. */
    throttle = 0;

    /** Set once the player has actually steered — used to hide the hint. */
    hasSteered = false;

    private _controls: TouchControls;
    /** A press that hasn't been consumed yet — drives the restart prompt. */
    private _tapPending = false;

    constructor(controls: TouchControls) {
        this._controls = controls;
    }

    attach(): void {
        // Target-less, so a press ANYWHERE counts as the restart tap. Steering
        // and throttle come from TouchControls, not from this.
        inputListener.on(Input.POINTER_DOWN, this._onDown, null, this);
    }

    detach(): void {
        // `off`'s third arg is the TARGET node, not the context — this was
        // registered target-less, so it stays null. Matching is by callback
        // reference, which prototype methods give us for free.
        inputListener.off(Input.POINTER_DOWN, this._onDown, null);
        this._controls.detach();
    }

    /**
     * A press has happened since the last call. Consumed, so one press can only
     * trigger one action — otherwise a held finger restarts the run every frame.
     */
    consumeTap(): boolean {
        const tapped = this._tapPending;
        this._tapPending = false;
        return tapped;
    }

    /**
     * Drops every hold, so a finger still down from the restart tap doesn't
     * immediately steer or accelerate. Buttons re-arm on the next real press.
     */
    clearHold(): void {
        this._controls.clear();
        this.axis = 0;
        this.throttle = 0;
    }

    /** Call once per frame, before anything reads `axis` or `throttle`. */
    sample(): void {
        if (TAP_KEYS.some(k => inputListener.isKeyDown(k))) this._tapPending = true;

        this.axis = this._controls.steerAxis;
        if (this.axis !== 0) this.hasSteered = true;

        this.throttle = InputController._pick(
            this._held(BRAKE_KEYS, GAS_KEYS),
            (this._controls.isHeld(Control.GAS) ? 1 : 0)
            - (this._controls.isHeld(Control.BRAKE) ? 1 : 0),
        );
    }

    /** -1 if any `negative` key is down, +1 for `positive`, 0 for neither/both. */
    private _held(negative: string[], positive: string[]): number {
        let v = 0;
        if (negative.some(k => inputListener.isKeyDown(k))) v -= 1;
        if (positive.some(k => inputListener.isKeyDown(k))) v += 1;
        return v;
    }

    private static _pick(keyboard: number, touch: number): number {
        return keyboard !== 0 ? keyboard : touch;
    }

    private _onDown(): void {
        this._tapPending = true;
    }
}
