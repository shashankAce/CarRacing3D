import { ColorRect, Graphics, Input, Label, Node, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';

/** Tactile pause modal. It owns input while visible, leaving the 3D scene intact behind it. */
export class PausePanel {

    readonly interactiveNodes: readonly Node[];
    private readonly _root = new Node();
    private _visible = false;

    constructor(scene: Scene, onResume: () => void, onRestart: () => void, onChangeCar: () => void) {
        const c = cfg.overlays;
        const p = c.pause;
        const cx = cfg.design.width / 2;
        this._root.name = 'PauseOverlay';
        scene.addChild(this._root);

        const backdrop = new Node(cx, cfg.design.height / 2);
        backdrop.width = cfg.design.width;
        backdrop.height = cfg.design.height;
        backdrop.addComponent(ColorRect).color = c.backdropColor;
        this._root.addChild(backdrop);

        const shadow = this._surface(cx + 8, p.panelY - 12, c.panelWidth, p.panelHeight, c.panelRadius, c.panelShadow);
        const panel = this._surface(cx, p.panelY, c.panelWidth, p.panelHeight, c.panelRadius, c.panelColor, c.panelStroke);
        void shadow;
        void panel;

        const iconY = p.titleY + 80;
        const ring = new Node(cx, iconY);
        ring.addComponent(Graphics).setStroke(c.mutedColor, p.iconStrokeWidth).setFill(c.mutedColor).drawCircle(p.iconRadius);
        this._root.addChild(ring);
        this._label(cx, iconY - 5, p.icon, p.iconFontSize, '#2a2a2a', 900);
        this._label(cx, p.titleY, p.title, p.titleFontSize, c.surfaceColor, 900);

        const resume = this._button(cx, p.resumeY, p.resumeText, c.orange, c.orangeShelf, c.buttonText, p.buttonFontSize, onResume);
        const restart = this._button(cx, p.restartY, p.restartText, c.green, c.greenShelf, c.surfaceColor, p.buttonFontSize, onRestart);
        const menu = this._button(cx, p.menuY, p.mainMenuText, c.neutral, c.neutralShelf, c.surfaceColor, p.buttonFontSize, onChangeCar);
        this.interactiveNodes = [resume, restart, menu];
        this._root.active = false;
    }

    get isVisible(): boolean { return this._visible; }

    show(): void { this._visible = true; this._root.active = true; }
    hide(): void { this._visible = false; this._root.active = false; }

    private _surface(x: number, y: number, width: number, height: number, radius: number, fill: string, stroke?: string): Node {
        const node = new Node(x, y);
        const graphic = node.addComponent(Graphics);
        if (stroke) graphic.setStroke(stroke, 2);
        graphic.drawRoundedRectangle(width, height, radius, fill);
        this._root.addChild(node);
        return node;
    }

    private _label(x: number, y: number, text: string, size: number, color: string, weight = 700): Label {
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

    private _button(x: number, y: number, text: string, fill: string, shelf: string, color: string, fontSize: number, action: () => void): Node {
        const c = cfg.overlays;
        const node = new Node(x, y);
        node.name = `PauseAction:${text}`;
        node.width = c.panelWidth - 72;
        node.height = c.buttonHeight;
        const shelfNode = new Node(0, -c.buttonShelf / 2);
        shelfNode.addComponent(Graphics).drawRoundedRectangle(node.width, c.buttonHeight, c.buttonRadius, shelf);
        node.addChild(shelfNode);
        const faceNode = new Node(0, c.buttonShelf / 2);
        const face = faceNode.addComponent(Graphics);
        face.drawRoundedRectangle(node.width, c.buttonHeight - c.buttonShelf, c.buttonRadius, fill);
        node.addChild(faceNode);
        const labelNode = new Node(0, c.buttonShelf / 2);
        const label = labelNode.addComponent(Label);
        label.text = text;
        label.fontFamily = cfg.overlays.fontFamily;
        label.fontWeight = 800;
        label.fontSize = fontSize;
        label.color = color;
        node.addChild(labelNode);
        node.on(Input.POINTER_DOWN, () => {
            faceNode.y = -c.buttonShelf / 2;
            labelNode.y = -c.buttonShelf / 2;
            action();
        }, this);
        this._root.addChild(node);
        return node;
    }
}
