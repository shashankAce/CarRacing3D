import { ColorRect, Graphics, Input, Label, Node, Scene, Sprite } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';

/**
 * End-of-run card. Layout mirrors reference/design/gameend/gameend.html: a message
 * at the top, an empty middle that lets the crashed scene read through a gradient
 * scrim, then the CTA button and brand lockup anchored to the bottom.
 */
export class GameOverPanel {

    readonly interactiveNodes: readonly Node[];
    private readonly _root = new Node();
    private readonly _reason: Label;
    private readonly _stats: Label;

    constructor(scene: Scene, private readonly _onReplay: () => void) {
        const c = cfg.overlays;
        const e = c.gameEnd;
        const cx = cfg.design.width / 2;
        this._root.name = 'GameEndOverlay';
        scene.addChild(this._root);

        const backdrop = new Node(cx, cfg.design.height / 2);
        backdrop.width = cfg.design.width;
        backdrop.height = cfg.design.height;
        const backdropSprite = backdrop.addComponent(Sprite);
        backdropSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        backdropSprite.texture = this._makeVerticalGradientTexture(
            e.backdropTop, e.backdropMid, e.backdropBottom, e.backdropTopStop, e.backdropBottomStop,
        );
        this._root.addChild(backdrop);

        const headline = this._label(cx, e.headlineY, e.headline, e.headlineFontSize, c.surfaceColor, 'rajdhani_bold');
        headline.lineHeight = e.headlineFontSize * 0.94;
        headline.setShadow(0, 4, 14, '#000000b3');

        this._reason = this._label(cx, e.reasonY, '', e.reasonFontSize, c.orange, 'rajdhani_bold');
        this._reason.setShadow(0, 4, 14, '#000000b3');
        this._stats = this._label(cx, e.statsY, '', e.statsFontSize, c.mutedColor, 'rajdhani_semibold');
        this._stats.letterSpacing = e.statsLetterSpacing;

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
        // Inner top-edge highlight — the "physical, pressable" glow called out in DESIGN.md.
        const highlight = new Node(0, c.buttonHeight / 2 - c.buttonShelf - 1);
        highlight.width = replay.width - c.buttonRadius;
        highlight.height = 2;
        highlight.addComponent(ColorRect).color = '#ffffff4d';
        faceNode.addChild(highlight);
        const label = this._label(0, c.buttonShelf / 2, e.replayText, e.buttonFontSize, c.buttonText, 'rajdhani_bold');
        this._root.removeChild(label.node);
        replay.addChild(label.node);
        replay.on(Input.POINTER_DOWN, () => {
            faceNode.y = -c.buttonShelf / 2;
            label.node.y = -c.buttonShelf / 2;
            this._onReplay();
        }, this);
        this._root.addChild(replay);
        this.interactiveNodes = [replay];

        const brand = this._label(cx, e.brandY, e.brand, e.brandFontSize, c.orange, 'rajdhani_bold');
        brand.fontStyle = 'italic';
        brand.letterSpacing = e.brandLetterSpacing;
        const tagline = this._label(cx, e.taglineY, e.tagline, e.taglineFontSize, c.mutedColor, 'rajdhani_semibold');
        tagline.letterSpacing = e.taglineLetterSpacing;

        this._root.active = false;
    }

    get isVisible(): boolean { return this._root.active; }

    show(title: string, distance: number, cuts: number, score: number): void {
        this._reason.text = title;
        this._stats.text = `${Math.floor(distance)} m   •   ${cuts} CUTS   •   ${score} PTS`;
        this._root.active = true;
    }

    hide(): void {
        this._root.active = false;
    }

    /** Bakes a 3-stop vertical gradient (top → mid → bottom) into a stretchable sprite texture. */
    private _makeVerticalGradientTexture(
        top: string, mid: string, bottom: string, topStop: number, bottomStop: number,
    ): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.width = 8;
        canvas.height = 512;
        const context = canvas.getContext('2d');
        if (!context) return canvas;
        const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
        gradient.addColorStop(0, top);
        gradient.addColorStop(topStop, mid);
        gradient.addColorStop(bottomStop, mid);
        gradient.addColorStop(1, bottom);
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, canvas.height);
        return canvas;
    }

    private _label(x: number, y: number, text: string, size: number, color: string, fontFamily: string): Label {
        const node = new Node(x, y);
        const label = node.addComponent(Label);
        label.text = text;
        label.fontFamily = fontFamily;
        label.fontSize = size;
        label.color = color;
        label.textAlign = Label.TextAlign.CENTER;
        this._root.addChild(node);
        return label;
    }
}
