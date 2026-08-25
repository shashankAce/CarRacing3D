import { inputListener, Input } from 'noonengine';

const LEFT_KEYS = ['ArrowLeft', 'KeyA'];
const RIGHT_KEYS = ['ArrowRight', 'KeyD'];

/**
 * InputController — collapses keyboard and touch into one steering axis.
 *
 * `axis` is -1 (full left) … 0 … +1 (full right), sampled by the car each
 * frame rather than pushed by events, so a held key and a held finger behave
 * identically and neither can miss a frame.
 *
 * Keyboard goes through the `inputListener` singleton because KEY_DOWN/KEY_UP
 * are NOT spatial events — `node.on(Input.KEY_DOWN, ...)` routes to the node's
 * own emitter and would never fire. See ARCHITECTURE.md §3 item 11.
 *
 * Touch uses global (target-less) pointer listeners rather than two hit-tested
 * button nodes: hold-to-steer wants the whole screen half live, including
 * whatever the finger slides over. Phase 6 can add visible button art on top
 * without changing any of this.
 */
export class InputController {

    /** -1 … +1. Read by PlayerCar every frame. */
    axis = 0;

    /** Set once the player has actually steered — used to hide the hint. */
    hasSteered = false;

    private _touchAxis = 0;
    private _pointerCount = 0;
    /** A press that hasn't been consumed yet — drives the restart prompt. */
    private _tapPending = false;

    attach(): void {
        inputListener.on(Input.POINTER_DOWN, this._onDown, null, this);
        inputListener.on(Input.POINTER_MOVE, this._onMove, null, this);
        inputListener.on(Input.POINTER_UP, this._onUp, null, this);
        inputListener.on(Input.POINTER_CANCEL, this._onUp, null, this);
    }

    detach(): void {
        // `off`'s third arg is the TARGET node, not the context — these were
        // registered target-less, so it stays null. Matching is by callback
        // reference, which prototype methods give us for free.
        inputListener.off(Input.POINTER_DOWN, this._onDown, null);
        inputListener.off(Input.POINTER_MOVE, this._onMove, null);
        inputListener.off(Input.POINTER_UP, this._onUp, null);
        inputListener.off(Input.POINTER_CANCEL, this._onUp, null);
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
     * Discards any in-progress hold, so a finger still down from the previous
     * screen doesn't immediately steer. The pointer count goes to zero while the
     * finger is physically down; the release clamps rather than going negative,
     * and steering resumes on the next real press.
     */
    clearHold(): void {
        this._touchAxis = 0;
        this._pointerCount = 0;
    }

    /** Call once per frame, before the car reads `axis`. */
    sample(): void {
        let keyAxis = 0;
        if (inputListener.isKeyDown('Space') || inputListener.isKeyDown('Enter')) this._tapPending = true;
        if (LEFT_KEYS.some(k => inputListener.isKeyDown(k))) keyAxis -= 1;
        if (RIGHT_KEYS.some(k => inputListener.isKeyDown(k))) keyAxis += 1;

        // Keyboard wins while a key is held; otherwise touch. Neither is
        // normally present at the same time, and this keeps a stuck touch from
        // fighting the keyboard during desktop testing.
        this.axis = keyAxis !== 0 ? keyAxis : this._touchAxis;
        if (this.axis !== 0) this.hasSteered = true;
    }

    /**
     * Which half of the screen a pointer is in. Compared against the LIVE
     * design width, not the configured 720: the policy is FIXED_HEIGHT, so the
     * real design width varies with the device's aspect ratio.
     */
    private _axisFor(x: number): number {
        const width = inputListener.engine?.display?.designWidth ?? 720;
        return x < width / 2 ? -1 : 1;
    }

    private _onDown(e: { x: number }): void {
        this._pointerCount++;
        this._touchAxis = this._axisFor(e.x);
        this._tapPending = true;
    }

    private _onMove(e: { x: number }): void {
        // Sliding across the midpoint switches direction without lifting.
        if (this._pointerCount > 0) this._touchAxis = this._axisFor(e.x);
    }

    private _onUp(): void {
        this._pointerCount = Math.max(0, this._pointerCount - 1);
        if (this._pointerCount === 0) this._touchAxis = 0;
    }
}
