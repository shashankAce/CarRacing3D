import { Node, Label, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';

/**
 * GameOverPanel — the run's result and the prompt to go again.
 *
 * Three labels, hidden by emptying their text rather than by toggling nodes:
 * the node lifecycle would tear down and rebuild the Label's baked texture each
 * time, and this panel appears and disappears on every run.
 *
 * No dimming backdrop. That would need a full-screen ColorRect and the
 * `graphics`/`color-rect` system, which auto-trim currently strips from the
 * build — not worth pulling a system in for one rectangle. Phase 7 can revisit
 * if the text doesn't read against a bright reskin.
 */
export class GameOverPanel {

    private _title: Label;
    private _summary: Label;
    private _prompt: Label;
    private _visible = false;

    constructor(scene: Scene) {
        const cx = cfg.design.width / 2;
        this._title = this._make(scene, cx, cfg.hud.gameOverY, cfg.hud.gameOverFontSize, cfg.hud.gameOverColor);
        this._summary = this._make(scene, cx, cfg.hud.summaryY, cfg.hud.summaryFontSize, cfg.hud.gameOverColor);
        this._prompt = this._make(scene, cx, cfg.hud.restartY, cfg.hud.restartFontSize, cfg.hud.restartColor);
    }

    private _make(scene: Scene, x: number, y: number, fontSize: number, color: string): Label {
        const node = new Node(x, y);
        const label = node.addComponent(Label);
        label.fontSize = fontSize;
        label.color = color;
        label.text = '';
        scene.addChild(node);
        return label;
    }

    get isVisible(): boolean { return this._visible; }

    /** @param title Why the run ended — a crash and an empty tank read differently. */
    show(title: string, distance: number, cuts: number, score: number): void {
        this._visible = true;
        this._title.text = title;
        this._summary.text = `${Math.floor(distance)} m   ${cuts} cut   ${score} pts`;
        this._prompt.text = cfg.hud.restartText;
    }

    hide(): void {
        if (!this._visible) return;
        this._visible = false;
        this._title.text = '';
        this._summary.text = '';
        this._prompt.text = '';
    }
}
