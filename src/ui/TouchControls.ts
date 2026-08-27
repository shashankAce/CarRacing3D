import { Node, Label, Scene, Input } from 'noonengine';
import { inputListener } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';

/** The four on-screen controls, in a fixed order. */
export const enum Control {
    STEER_LEFT = 0,
    STEER_RIGHT = 1,
    GAS = 2,
    BRAKE = 3,
}

interface Button {
    control: Control;
    hit: Node;
    glyph: Label;
    /** Pointer ids currently holding this button — multi-touch aware. */
    held: Set<number>;
}

/**
 * TouchControls — four hold-to-act buttons: steer left/right, gas, brake.
 *
 * Structure per button: a bare parent node carrying the hit box, with the glyph
 * on a CHILD. The parent has no render component on purpose — `LabelSystem`
 * writes a label's measured text size back into its node
 * (`LabelSystem.js:512`), so putting the glyph on the hit node would shrink the
 * touch target to the size of one character.
 *
 * A node's position is the hit box's CORNER and y runs upward
 * (`InputListener._hitAABB` tests `0 <= local <= width/height`), so the
 * configured positions are bottom-left corners.
 *
 * Release is handled by a GLOBAL pointer-up listener keyed on pointer id, not by
 * a per-node up listener. Two reasons, both of which produce stuck buttons
 * otherwise: a finger that slides off a button never delivers an up event to
 * that node, and a global "release everything" handler would drop the steering
 * button the moment the player lifted their gas thumb.
 */
export class TouchControls {

    private _buttons: Button[] = [];
    /** Which button each live pointer is holding. */
    private _byPointer = new Map<number, Button>();

    constructor(scene: Scene) {
        const c = cfg.controls;

        // Anchor to the LIVE design width. Under FIXED_HEIGHT it varies with the
        // device's aspect ratio, so anything derived from `cfg.design.width`
        // drifts — and centre-relative offsets pushed the left button off-screen
        // entirely on a narrow phone.
        const width = inputListener.engine?.display?.designWidth ?? cfg.design.width;
        const left = c.edgeMargin;
        const right = width - c.edgeMargin - c.size;

        const layout: Array<[Control, number, number, string]> = [
            [Control.STEER_LEFT, left, c.steerY, '◀'],
            [Control.STEER_RIGHT, left + c.size + c.buttonGap, c.steerY, '▶'],
            [Control.GAS, right, c.gasY, '▲'],
            [Control.BRAKE, right, c.brakeY, '▼'],
        ];

        for (const [control, x, y, glyphText] of layout) {
            const hit = new Node(x, y);
            hit.width = c.size;
            hit.height = c.size;
            scene.addChild(hit);

            // Child, centred in the parent's box.
            const glyphNode = new Node(c.size / 2, c.size / 2);
            const glyph = glyphNode.addComponent(Label);
            glyph.fontSize = c.glyphSize;
            glyph.color = c.color;
            glyph.text = glyphText;
            hit.addChild(glyphNode);

            const button: Button = { control, hit, glyph, held: new Set() };
            // Registering a spatial listener is what makes the node hit-testable
            // at all — it auto-adds an Interactive component.
            hit.on(Input.POINTER_DOWN, (e: any) => this._press(button, e.pointer.id), this);
            this._buttons.push(button);
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

    /** Enables or hides the complete touch-control layer, e.g. for menus. */
    setEnabled(enabled: boolean): void {
        for (const button of this._buttons) button.hit.active = enabled;
        if (!enabled) this.clear();
    }

    /** Drops every hold — used on restart so a finger still down doesn't act. */
    clear(): void {
        for (const b of this._buttons) {
            b.held.clear();
            b.glyph.color = cfg.controls.color;
        }
        this._byPointer.clear();
    }

    private _press(button: Button, pointerId: number): void {
        // One pointer holds one button. If it somehow moved between boxes, the
        // old one must let go or it sticks.
        const previous = this._byPointer.get(pointerId);
        if (previous && previous !== button) this._letGo(previous, pointerId);

        button.held.add(pointerId);
        this._byPointer.set(pointerId, button);
        button.glyph.color = cfg.controls.pressedColor;
    }

    private _release(e: any): void {
        const pointerId = e.pointer.id;
        const button = this._byPointer.get(pointerId);
        if (button) this._letGo(button, pointerId);
        this._byPointer.delete(pointerId);
    }

    private _letGo(button: Button, pointerId: number): void {
        button.held.delete(pointerId);
        if (button.held.size === 0) button.glyph.color = cfg.controls.color;
    }
}
