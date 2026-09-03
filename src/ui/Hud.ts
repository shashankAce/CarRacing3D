import { Node, Label, Scene, Graphics, Widget } from 'noonengine';
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

    private readonly _root = new Node();
    private _distance: Label;
    private _speed: Label;
    private _hint: Label;
    private _cuts: Label;
    private _fuel: Label;
    /** Only repaint the text when the displayed value actually changes. */
    private _lastMetres = -1;
    private _lastKph = -1;
    private _lastCuts = -1;
    private _lastFuelCells = -1;
    private _visible = true;

    constructor(scene: Scene) {
        const cx = cfg.design.width / 2;
        this._root.name = 'Hud';
        scene.addChild(this._root);
        // These two change every frame — hence `dynamic`. The hint doesn't.


        let distNode = new Node(0, 0);
        let distPanel = distNode.addComponent(Graphics);
        let distW = distNode.addComponent(Widget);
        distW.top = 90;
        distW.left = 50;
        distW.alignToWindow = true;
        this._root.addChild(distNode);
        distPanel.drawRoundedRectangle(150, 50, 10, '#0000006e');

        this._distance = this._makeLabel(0, -3, cfg.hud.distanceFontSize, cfg.hud.textColor, true);
        this._distance.fontFamily = 'rajdhani_bold';
        this._distance.overflow = Label.Overflow.SHRINK;
        this._distance.node.width = 150;
        this._distance.node.height = 50;
        distNode.addChild(this._distance.node);


        let speedNode = new Node(0, 0);
        let speedPanel = speedNode.addComponent(Graphics);
        let speedW = speedNode.addComponent(Widget);
        speedW.bottom = 40;
        speedW.left = 50;
        speedW.alignToWindow = true;
        this._root.addChild(speedNode);
        speedPanel.drawRoundedRectangle(150, 50, 10, '#0000006e');

        this._speed = this._makeLabel(0, -4, cfg.hud.speedFontSize, cfg.hud.textColor, true);
        this._speed.fontFamily = 'rajdhani_bold';
        // this._speed.fontStyle = 'italic';
        speedNode.addChild(this._speed.node);

        this._hint = this._makeLabel(cx, cfg.hud.hintY, cfg.hud.hintFontSize, cfg.hud.hintColor);
        this._hint.text = cfg.hud.hintText;
        this._root.addChild(this._hint.node);



        let cutNode = new Node(0, 0);
        this._root.addChild(cutNode);
        let cutPanel = cutNode.addComponent(Graphics);
        cutPanel.drawRoundedRectangle(150, 50, 10, '#0000006e');
        let cutW = cutNode.addComponent(Widget);
        cutW.top = 90;
        cutW.right = 50;
        cutW.alignToWindow = true;
        this._cuts = this._makeLabel(0, -3, cfg.hud.cutsFontSize, cfg.hud.cutsColor, true);
        this._cuts.fontFamily = 'rajdhani_bold';
        cutNode.addChild(this._cuts.node);

        this._fuel = this._makeLabel(cx, cfg.hud.fuelY, cfg.hud.fuelFontSize, cfg.hud.fuelColor, true);
        this._fuel.node.name = 'FuelNode';
        this._fuel.setShadow(0, 2, 15, '#000000cc');
        this._root.addChild(this._fuel.node);
        // Monospace, or the gauge's width changes as cells flip and it jitters.
        this._fuel.fontFamily = 'monospace';
        this._fuel.fontStyle = 'bold';
    }

    /**
     * `dynamic` matters here and isn't cosmetic. A non-dynamic Label re-bakes
     * through a SHARED canvas into an async ImageBitmap whenever its text
     * changes; the distance and speed readouts change every frame, so that's an
     * ImageBitmap per label per frame. `dynamic` gives each one its own canvas
     * baked synchronously, which is what the engine documents it for
     * ("use for counters/timers").
     */
    private _makeLabel(x: number, y: number, fontSize: number, color: string, dynamic = false): Label {
        const node = new Node(x, y);
        const label = node.addComponent(Label);
        label.fontSize = fontSize;
        label.color = color;
        label.dynamic = dynamic;
        label.text = '';
        return label;
    }

    update(state: GameState, hasSteered: boolean, cuts: number): void {
        if (!this._visible) return;
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

        // Only repaint when a whole cell flips — the gauge changes continuously
        // but only ever shows `fuelCells` distinct states.
        const cells = Math.ceil(state.fuelT * cfg.hud.fuelCells);
        if (cells !== this._lastFuelCells) {
            this._lastFuelCells = cells;
            this._fuel.text = 'FUEL ' + '\u2593'.repeat(cells)
                + '\u2591'.repeat(cfg.hud.fuelCells - cells);
            this._fuel.color = state.fuelT <= cfg.fuel.warnAt
                ? cfg.hud.fuelWarnColor : cfg.hud.fuelColor;
        }

        if (cuts !== this._lastCuts) {
            this._lastCuts = cuts;
            this._cuts.text = `${cuts} CUT`;
        }

        // The hint has done its job the moment the player steers once.
        if (hasSteered && this._hint.text !== '') this._hint.text = '';
    }

    /**
     * Hides gameplay readouts while the pause/car-selection/game-over screens own
     * the UI. Deactivates the whole node tree — rather than just blanking each
     * label's text — because a dynamic, fixed-width, word-wrapping label (like
     * `_distance`, which uses `Overflow.SHRINK`) never actually re-bakes for an
     * emptied string: the wrap pass drops the trailing empty line, `_lines` comes
     * back length 0, and the engine's bake step treats "0 lines and empty text" as
     * "nothing changed, skip" — leaving the last rendered digits on the label's
     * canvas and stuck on screen instead of clearing it.
     */
    setVisible(visible: boolean): void {
        this._visible = visible;
        this._root.active = visible;
        if (!visible) {
            this._distance.text = '';
            this._speed.text = '';
            this._hint.text = '';
            this._cuts.text = '';
            this._fuel.text = '';
            return;
        }
        this._lastMetres = -1;
        this._lastKph = -1;
        this._lastCuts = -1;
        this._lastFuelCells = -1;
        this._hint.text = cfg.hud.hintText;
    }
}
