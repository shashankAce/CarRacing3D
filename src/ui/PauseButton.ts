import { Graphics, Input, Label, Node, Scene, Widget } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';

/** Compact, always-reachable control that opens the pause modal. */
export class PauseButton {

    readonly node: Node;
    private readonly _icon: Label;
    private readonly _surface: Graphics;

    constructor(scene: Scene, private readonly _onPause: () => void) {
        const c = cfg.overlays.pauseButton;
        this.node = new Node();
        this.node.name = 'PauseButton';
        this.node.width = c.size;
        this.node.height = c.size;
        scene.addChild(this.node);

        const widget = this.node.addComponent(Widget);
        widget.top = c.edgeMargin;
        widget.left = c.edgeMargin;
        widget.alignToWindow = true;

        const surfaceNode = new Node();
        this._surface = surfaceNode.addComponent(Graphics);
        this._surface.setStroke(c.stroke, 2);
        this._surface.drawCircle(c.radius, c.background);
        this.node.addChild(surfaceNode);

        const iconNode = new Node();
        this._icon = iconNode.addComponent(Label);
        this._icon.text = c.glyph;
        this._icon.fontFamily = cfg.overlays.fontFamily;
        this._icon.fontWeight = 900;
        this._icon.fontSize = c.fontSize;
        this._icon.color = c.color;
        this.node.addChild(iconNode);
        this.node.on(Input.POINTER_DOWN, this._press, this);
    }

    setVisible(visible: boolean): void { this.node.active = visible; }

    private _press(): void {
        const c = cfg.overlays.pauseButton;
        this._icon.color = c.pressed;
        this._surface.fillColor = c.pressed;
        this._onPause();
        this._icon.color = c.color;
        this._surface.fillColor = c.background;
    }
}
