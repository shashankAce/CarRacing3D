import { inputListener, Input, Node } from 'noonengine';
import { TouchControls } from '../ui/TouchControls';

const LEFT_KEYS = ['ArrowLeft', 'KeyA'];
const RIGHT_KEYS = ['ArrowRight', 'KeyD'];
const GAS_KEYS = ['ArrowUp', 'KeyW'];
const BRAKE_KEYS = ['ArrowDown', 'KeyS'];
const TAP_KEYS = ['Space', 'Enter'];

/**
 * InputController — collapses keyboard and the virtual joystick into two axes.
 *
 * `axis` is -1 (full left) … +1 (full right); `throttle` is +1 gas, -1 manual
 * brake, 0 released/automatic brake. Both are SAMPLED each frame, so a held
 * key and a held joystick behave identically and neither can miss a frame.
 *
 * Keyboard goes through the `inputListener` singleton because KEY_DOWN/KEY_UP
 * are NOT spatial events — `node.on(Input.KEY_DOWN, ...)` routes to the node's
 * own emitter and would never fire. See ARCHITECTURE.md §3 item 11.
 *
 * Touch comes from `TouchControls`: horizontal drag steers, vertical drag
 * controls gas/brake, and diagonal drag produces both at once.
 */
export class InputController {

    /** -1 … +1 steering. Read by PlayerCar every frame. */
    axis = 0;

    /** +1 gas, -1 manual brake, 0 automatic brake. */
    throttle = 0;

    /** Set once the player has actually steered — used to hide the hint. */
    hasSteered = false;

    private _controls: TouchControls;
    /** UI taps that perform their own action and must not restart a finished run. */
    private _ignoredTapTargets = new Set<Node>();
    /** A press that hasn't been consumed yet — drives the restart prompt. */
    private _tapPending = false;

    constructor(controls: TouchControls) {
        this._controls = controls;
    }

    attach(): void {
        // Target-less, so a press ANYWHERE counts as the restart tap. Steering
        // and throttle come from the joystick, not from this.
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

    ignoreTapTarget(node: Node): void {
        this._ignoredTapTargets.add(node);
    }

    /**
     * Drops every hold, so a finger still down from the restart tap doesn't
     * immediately steer or accelerate. The joystick re-arms on a new press.
     */
    clearHold(): void {
        this._controls.clear();
        this.axis = 0;
        this.throttle = 0;
        this._tapPending = false;
    }

    /** Call once per frame, before anything reads `axis` or `throttle`. */
    sample(): void {
        if (TAP_KEYS.some(k => inputListener.isKeyDown(k))) this._tapPending = true;

        // Keyboard wins while a key is held; otherwise the joystick. They're
        // rarely both present, and this keeps a stuck touch from fighting the
        // keyboard during desktop testing.
        this.axis = InputController._pick(
            this._held(LEFT_KEYS, RIGHT_KEYS),
            this._controls.axis,
        );
        if (this.axis !== 0) this.hasSteered = true;

        this.throttle = InputController._pick(
            this._held(BRAKE_KEYS, GAS_KEYS),
            this._controls.throttle,
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

    private _onDown(e: any): void {
        if (this._ignoredTapTargets.has(e.target)) return;
        this._tapPending = true;
    }
}
