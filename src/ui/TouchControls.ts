import { Graphics, Input, Node, Scene, inputListener } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';

/**
 * TouchControls — one PUBG-style virtual joystick for every mobile driving input.
 *
 * Dragging up/down produces gas/brake, dragging left/right steers, and diagonal
 * drags combine both axes. The knob is clamped to the circular gate while the
 * exposed values use a dead zone on each axis, so a mostly-horizontal drag
 * does not accidentally brake and a mostly-vertical drag does not steer.
 * Releasing the pointer returns both values to
 * zero; GameState already interprets zero throttle as automatic braking.
 *
 * The large bare parent is the hit target. The rendered base and knob are
 * children so Graphics' measured bounds never shrink the usable touch area.
 * One pointer owns the joystick until it is released or cancelled.
 */
export class TouchControls {

    /** -1 full left … +1 full right. */
    axis = 0;

    /** +1 gas, -1 brake, 0 released/automatic brake. */
    throttle = 0;

    private _hit: Node;
    private _knobNode: Node;
    private _base: Graphics;
    private _knob: Graphics;
    private _pointerId: number | null = null;
    private _enabled = false;

    constructor(scene: Scene) {
        const c = cfg.controls;
        const screenWidth = inputListener.engine?.display?.designWidth ?? cfg.design.width;

        // The hit target is intentionally larger than the visible gate so a
        // moving thumb can acquire the control without pixel-perfect aiming.
        this._hit = new Node(screenWidth * 0.8, c.centerY);
        this._hit.width = c.touchRadius * 2;
        this._hit.height = c.touchRadius * 2;
        this._hit.name = 'VirtualJoystickHit';
        scene.addChild(this._hit);

        const baseNode = new Node();
        baseNode.name = 'VirtualJoystickBase';
        this._base = baseNode.addComponent(Graphics);
        this._base.tessellate = true;
        this._base.setStroke(c.baseStrokeColor, c.strokeWidth);
        this._base.drawCircle(c.baseRadius, c.baseColor);
        this._hit.addChild(baseNode);

        this._knobNode = new Node();
        this._knobNode.name = 'VirtualJoystickKnob';
        this._knob = this._knobNode.addComponent(Graphics);
        this._knob.tessellate = true;
        this._knob.setStroke(c.knobStrokeColor, c.strokeWidth);
        this._knob.drawCircle(c.knobRadius, c.knobColor);
        this._hit.addChild(this._knobNode);

        this._hit.on(Input.POINTER_DOWN, this._onDown, this);
        inputListener.on(Input.POINTER_MOVE, this._onMove, null, this);
        inputListener.on(Input.POINTER_UP, this._onRelease, null, this);
        inputListener.on(Input.POINTER_CANCEL, this._onRelease, null, this);
    }

    detach(): void {
        this._hit.off(Input.POINTER_DOWN, this._onDown, this);
        inputListener.off(Input.POINTER_MOVE, this._onMove, null);
        inputListener.off(Input.POINTER_UP, this._onRelease, null);
        inputListener.off(Input.POINTER_CANCEL, this._onRelease, null);
    }

    /** Enables or hides the joystick, e.g. while the car-selection menu owns UI. */
    setEnabled(enabled: boolean): void {
        this._enabled = enabled;
        this._hit.active = enabled;
        if (!enabled) this.clear();
    }

    /** Drops the active gesture and returns the knob and both axes to rest. */
    clear(): void {
        this._pointerId = null;
        this.axis = 0;
        this.throttle = 0;
        this._knobNode.x = 0;
        this._knobNode.y = 0;
        this._base.strokeColor = cfg.controls.baseStrokeColor;
        this._knob.fillColor = cfg.controls.knobColor;
    }

    private _onDown(e: any): void {
        if (!this._enabled || this._pointerId !== null) return;
        this._pointerId = e.pointer.id;
        this._base.strokeColor = cfg.controls.pressedColor;
        this._knob.fillColor = cfg.controls.knobPressedColor;
        this._update(e.x, e.y);
    }

    private _onMove(e: any): void {
        if (e.pointer.id !== this._pointerId) return;
        this._update(e.x, e.y);
    }

    private _onRelease(e: any): void {
        if (e.pointer.id !== this._pointerId) return;
        this.clear();
    }

    private _update(x: number, y: number): void {
        const c = cfg.controls;
        const dx = x - this._hit.x;
        const dy = y - this._hit.y;
        const distance = Math.hypot(dx, dy);
        const clampedDistance = Math.min(distance, c.travelRadius);
        const directionX = distance > 0 ? dx / distance : 0;
        const directionY = distance > 0 ? dy / distance : 0;

        this._knobNode.x = directionX * clampedDistance;
        this._knobNode.y = directionY * clampedDistance;

        const rawMagnitude = clampedDistance / c.travelRadius;
        this.axis = TouchControls._applyDeadZone(directionX * rawMagnitude, c.deadZone);
        this.throttle = TouchControls._applyDeadZone(directionY * rawMagnitude, c.deadZone);
    }

    private static _applyDeadZone(value: number, deadZone: number): number {
        const magnitude = Math.abs(value);
        if (magnitude <= deadZone) return 0;
        return Math.sign(value) * Math.min(1, (magnitude - deadZone) / (1 - deadZone));
    }
}
