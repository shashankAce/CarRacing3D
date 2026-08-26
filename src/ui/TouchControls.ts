import { Node, Label, ColorRect, Scene, Input, inputListener } from 'noonengine';
import type { PointerInputEvent } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';

/** The remaining hold-to-act buttons. Steering is a continuous slider. */
export const enum Control {
    GAS = 0,
    BRAKE = 1,
}

interface Button {
    control: Control;
    hit: Node;
    glyph: Label;
    /** Pointer ids currently holding this button — multi-touch aware. */
    held: Set<number>;
}

/**
 * TouchControls — continuous steering slider plus gas and brake buttons.
 *
 * The slider owns one pointer at a time and uses implicit pointer capture, so
 * steering keeps updating even if the thumb leaves the track. Gas and brake
 * retain their own pointer sets; lifting the throttle thumb therefore cannot
 * release steering, and vice versa.
 *
 * Visual rectangles are children of a taller invisible hit node. This makes
 * the slim track easy to grab without drawing a large opaque UI panel over the
 * road. All positions in config are bottom-left corners in design space.
 */
export class TouchControls {

    private _buttons: Button[] = [];
    /** Which button each live non-steering pointer is holding. */
    private _byPointer = new Map<number, Button>();

    private _steerAxis = 0;
    private _steerPointerId: number | null = null;
    private _steerHit: Node;
    private _steerThumb: Node;
    private _steerThumbRect: ColorRect;
    private _steerLocal = { x: 0, y: 0 };

    /** Continuous steering request consumed by InputController. */
    get steerAxis(): number { return this._steerAxis; }

    constructor(scene: Scene) {
        const c = cfg.controls;

        // Anchor to the live design width. FIXED_HEIGHT changes it with device
        // aspect ratio, so cfg.design.width is only a fallback during startup.
        const width = inputListener.engine?.display?.designWidth ?? cfg.design.width;
        const left = c.edgeMargin;
        const right = width - c.edgeMargin - c.size;

        this._buildSteeringSlider(scene, left);

        const layout: Array<[Control, number, number, string]> = [
            [Control.GAS, right, c.gasY, '▲'],
            [Control.BRAKE, right, c.brakeY, '▼'],
        ];

        for (const [control, x, y, glyphText] of layout) {
            // Config stores the bottom-left; Node positions use their anchor.
            const hit = new Node(x + c.size / 2, y + c.size / 2);
            hit.width = c.size;
            hit.height = c.size;

            const glyphNode = new Node(0, 0);
            const glyph = glyphNode.addComponent(Label);
            glyph.fontSize = c.glyphSize;
            glyph.color = c.color;
            glyph.text = glyphText;
            hit.addChild(glyphNode);

            const button: Button = { control, hit, glyph, held: new Set() };
            hit.on(Input.POINTER_DOWN, (e: PointerInputEvent) =>
                this._press(button, e.pointer.id), this);
            this._buttons.push(button);
            scene.addChild(hit);
        }

        inputListener.on(Input.POINTER_UP, this._release, null, this);
        inputListener.on(Input.POINTER_CANCEL, this._release, null, this);
    }

    detach(): void {
        inputListener.off(Input.POINTER_UP, this._release, null);
        inputListener.off(Input.POINTER_CANCEL, this._release, null);
    }

    isHeld(control: Control): boolean {
        return this._buttons[control].held.size > 0;
    }

    /** Drops every hold and returns steering to neutral after a restart. */
    clear(): void {
        for (const b of this._buttons) {
            b.held.clear();
            b.glyph.color = cfg.controls.color;
        }
        this._byPointer.clear();
        this._steerPointerId = null;
        this._steerThumbRect.color = cfg.controls.steeringSlider.thumbColor;
        this._setSteerAxis(0);
    }

    private _buildSteeringSlider(scene: Scene, left: number): void {
        const s = cfg.controls.steeringSlider;
        const centreX = left + s.width / 2;
        const centreY = s.y + s.touchHeight / 2;

        const hit = new Node(centreX, centreY);
        hit.width = s.width;
        hit.height = s.touchHeight;

        const track = new Node(0, 0);
        track.width = s.width;
        track.height = s.trackHeight;
        track.addComponent(ColorRect).color = s.trackColor;
        hit.addChild(track);

        const centre = new Node(0, 0);
        centre.width = s.centerWidth;
        centre.height = s.centerHeight;
        centre.addComponent(ColorRect).color = s.centerColor;
        hit.addChild(centre);

        const thumb = new Node(0, 0);
        thumb.width = s.thumbWidth;
        thumb.height = s.thumbHeight;
        const thumbRect = thumb.addComponent(ColorRect);
        thumbRect.color = s.thumbColor;
        hit.addChild(thumb);

        hit.on(Input.POINTER_DOWN, this._steerDown, this);
        hit.on(Input.POINTER_MOVE, this._steerMove, this);
        scene.addChild(hit);

        this._steerHit = hit;
        this._steerThumb = thumb;
        this._steerThumbRect = thumbRect;
    }

    private _steerDown(e: PointerInputEvent): void {
        // A second steering finger does not steal the active finger's control.
        if (this._steerPointerId !== null && this._steerPointerId !== e.pointer.id) return;
        this._steerPointerId = e.pointer.id;
        this._steerThumbRect.color = cfg.controls.steeringSlider.activeThumbColor;
        this._setSteerFromWorld(e.x, e.y);
    }

    private _steerMove(e: PointerInputEvent): void {
        if (this._steerPointerId !== e.pointer.id) return;
        this._setSteerFromWorld(e.x, e.y);
    }

    private _setSteerFromWorld(worldX: number, worldY: number): void {
        const local = this._steerHit.worldToLocal(worldX, worldY, this._steerLocal);
        const raw = Math.max(-1, Math.min(1, local.x / this._steerHit.width * 2 - 1));
        const deadZone = Math.max(0, Math.min(0.99, cfg.controls.steeringSlider.deadZone));
        const magnitude = Math.abs(raw);
        const axis = magnitude <= deadZone
            ? 0
            : Math.sign(raw) * (magnitude - deadZone) / (1 - deadZone);
        this._setSteerAxis(axis);
    }

    private _setSteerAxis(axis: number): void {
        this._steerAxis = Math.max(-1, Math.min(1, axis));
        const s = cfg.controls.steeringSlider;
        const travel = Math.max(0, s.width - s.thumbWidth);
        this._steerThumb.x = this._steerAxis * travel / 2;
    }

    private _press(button: Button, pointerId: number): void {
        const previous = this._byPointer.get(pointerId);
        if (previous && previous !== button) this._letGo(previous, pointerId);

        button.held.add(pointerId);
        this._byPointer.set(pointerId, button);
        button.glyph.color = cfg.controls.pressedColor;
    }

    private _release(e: PointerInputEvent): void {
        const pointerId = e.pointer.id;
        if (this._steerPointerId === pointerId) {
            this._steerPointerId = null;
            this._steerThumbRect.color = cfg.controls.steeringSlider.thumbColor;
            if (cfg.controls.steeringSlider.recenterOnRelease) this._setSteerAxis(0);
        }

        const button = this._byPointer.get(pointerId);
        if (button) this._letGo(button, pointerId);
        this._byPointer.delete(pointerId);
    }

    private _letGo(button: Button, pointerId: number): void {
        button.held.delete(pointerId);
        if (button.held.size === 0) button.glyph.color = cfg.controls.color;
    }
}
