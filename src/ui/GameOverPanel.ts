import { ColorRect, Graphics, Input, Label, Node, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';

/** End-of-run card styled as the game's high-energy, replay-focused end screen. */
export class GameOverPanel {

    readonly interactiveNodes: readonly Node[];
    private readonly _root = new Node();
    private readonly _reason: Label;
    private readonly _stats: Label;
    private _visible = false;

    constructor(scene: Scene, private readonly _onReplay: () => void) {
        const c = cfg.overlays;
        const e = c.gameEnd;
        const cx = cfg.design.width / 2;
        this._root.name = 'GameEndOverlay';
        scene.addChild(this._root);

        const backdrop = new Node(cx, cfg.design.height / 2);
        backdrop.width = cfg.design.width;
        backdrop.height = cfg.design.height;
        backdrop.addComponent(ColorRect).color = c.backdropColor;
        this._root.addChild(backdrop);

        this._label(cx, e.eyebrowY, e.eyebrow, e.eyebrowFontSize, c.mutedColor, 700);
        const headline = this._label(cx, e.headlineY, e.headline, e.headlineFontSize, c.surfaceColor, 900);
        headline.lineHeight = e.headlineFontSize * 0.94;
        headline.setShadow(0, -5, 12, '#00000099');

        this._surface(cx + 8, e.panelY - 12, c.panelWidth, e.panelHeight, c.panelRadius, c.panelShadow);
        this._surface(cx, e.panelY, c.panelWidth, e.panelHeight, c.panelRadius, c.panelColor, c.panelStroke);
        this._reason = this._label(cx, e.titleY, '', e.titleFontSize, c.orange, 900);
        this._stats = this._label(cx, e.statsY, '', e.statsFontSize, c.surfaceColor, 700);
        this._label(cx, e.brandY, e.brand, e.brandFontSize, c.orange, 900);

        const replay = new Node(cx, e.buttonY);
        replay.name = 'RaceAgainButton';
        replay.width = c.panelWidth - 72;
        replay.height = c.buttonHeight;
        const shelfNode = new Node(0, -c.buttonShelf / 2);
        shelfNode.addComponent(Graphics).drawRoundedRectangle(replay.width, c.buttonHeight, c.buttonRadius, c.orangeShelf);
        replay.addChild(shelfNode);
        const faceNode = new Node(0, c.buttonShelf / 2);
        faceNode.addComponent(Graphics).drawRoundedRectangle(replay.width, c.buttonHeight - c.buttonShelf, c.buttonRadius, c.orange);
        replay.addChild(faceNode);
        const label = this._label(0, c.buttonShelf / 2, e.replayText, e.buttonFontSize, c.buttonText, 900);
        this._root.removeChild(label.node);
        replay.addChild(label.node);
        replay.on(Input.POINTER_DOWN, () => {
            faceNode.y = -c.buttonShelf / 2;
            label.node.y = -c.buttonShelf / 2;
            this._onReplay();
        }, this);
        this._root.addChild(replay);
        this.interactiveNodes = [replay];
        this._root.active = false;
    }

    get isVisible(): boolean { return this._visible; }

    show(title: string, distance: number, cuts: number, score: number): void {
        this._visible = true;
        this._reason.text = title;
        this._stats.text = `${Math.floor(distance)} m   •   ${cuts} CUTS   •   ${score} PTS`;
        this._root.active = true;
    }

    hide(): void {
        this._visible = false;
        this._root.active = false;
    }

    private _surface(x: number, y: number, width: number, height: number, radius: number, fill: string, stroke?: string): void {
        const node = new Node(x, y);
        const graphic = node.addComponent(Graphics);
        if (stroke) graphic.setStroke(stroke, 2);
        graphic.drawRoundedRectangle(width, height, radius, fill);
        this._root.addChild(node);
    }

    private _label(x: number, y: number, text: string, size: number, color: string, weight: number): Label {
        const node = new Node(x, y);
        const label = node.addComponent(Label);
        label.text = text;
        label.fontFamily = cfg.overlays.fontFamily;
        label.fontWeight = weight;
        label.fontSize = size;
        label.color = color;
        label.textAlign = Label.TextAlign.CENTER;
        this._root.addChild(node);
        return label;
    }
}
