import { Node, Label, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import type { GameState } from '../game/GameState';

/**
 * Hud — distance, speed, and the steering hint.
 *
 * Plain 2D NoonEngine nodes in the same scene as the 3D content: the 3D pass
 * renders before the 2D pass, so these are drawn on top for free with no
 * compositing setup (ARCHITECTURE.md §3 item 1).
 *
 * Everything is centre-anchored on purpose. The resolution policy is
 * FIXED_HEIGHT, so the design WIDTH varies with device aspect ratio — anything
 * pinned near a left or right edge would need the Widget system, which the
 * build currently trims out.
 *
 * Node positions are Y-UP: y is measured from the bottom of the design space.
 * See the note on `hud.distanceY` in gameConfig.
 */
export class Hud {

    private _distance: Label;
    private _speed: Label;
    private _hint: Label;
    /** Only repaint the text when the displayed value actually changes. */
    private _lastMetres = -1;
    private _lastKph = -1;

    constructor(scene: Scene) {
        const cx = cfg.design.width / 2;
        // These two change every frame — hence `dynamic`. The hint doesn't.
        this._distance = this._makeLabel(scene, cx, cfg.hud.distanceY, cfg.hud.distanceFontSize, cfg.hud.textColor, true);
        this._speed = this._makeLabel(scene, cx, cfg.hud.speedY, cfg.hud.speedFontSize, cfg.hud.textColor, true);
        this._hint = this._makeLabel(scene, cx, cfg.hud.hintY, cfg.hud.hintFontSize, cfg.hud.hintColor);
        this._hint.text = cfg.hud.hintText;
    }

    /**
     * `dynamic` matters here and isn't cosmetic. A non-dynamic Label re-bakes
     * through a SHARED canvas into an async ImageBitmap whenever its text
     * changes; the distance and speed readouts change every frame, so that's an
     * ImageBitmap per label per frame. `dynamic` gives each one its own canvas
     * baked synchronously, which is what the engine documents it for
     * ("use for counters/timers").
     */
    private _makeLabel(scene: Scene, x: number, y: number, fontSize: number, color: string, dynamic = false): Label {
        const node = new Node(x, y);
        const label = node.addComponent(Label);
        label.fontSize = fontSize;
        label.color = color;
        label.dynamic = dynamic;
        label.text = '';
        scene.addChild(node);
        return label;
    }

    update(state: GameState, hasSteered: boolean): void {
        const metres = Math.floor(state.distance);
        if (metres !== this._lastMetres) {
            this._lastMetres = metres;
            this._distance.text = `${metres} m`;
        }

        const kph = Math.round(state.speed * 3.6);
        if (kph !== this._lastKph) {
            this._lastKph = kph;
            this._speed.text = `${kph} km/h`;
        }

        // The hint has done its job the moment the player steers once.
        if (hasSteered && this._hint.text !== '') this._hint.text = '';
    }
}
