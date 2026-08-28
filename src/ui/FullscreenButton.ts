import { Graphics, Input, Label, Node, Scene, Widget } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';

interface VendorFullscreenDocument extends Document {
    webkitFullscreenElement?: Element | null;
    webkitExitFullscreen?: () => Promise<void> | void;
}

interface VendorFullscreenElement extends HTMLElement {
    webkitRequestFullscreen?: () => Promise<void> | void;
}

/** User-gesture fullscreen toggle, required by mobile browser security rules. */
export class FullscreenButton {

    readonly node: Node;

    private _glyph: Label;
    private _background: Graphics;

    constructor(scene: Scene) {
        const c = cfg.fullscreenButton;

        this.node = new Node();
        this.node.name = 'FullscreenButton';
        this.node.width = c.size;
        this.node.height = c.size;
        scene.addChild(this.node);

        const widget = this.node.addComponent(Widget);
        widget.top = c.edgeMargin;
        widget.right = c.edgeMargin;
        widget.alignToWindow = true;

        const backgroundNode = new Node();
        this._background = backgroundNode.addComponent(Graphics);
        this._background.tessellate = true;
        this._background.setStroke(c.strokeColor, c.strokeWidth);
        this._background.drawCircle(c.backgroundRadius, c.backgroundColor);
        this.node.addChild(backgroundNode);

        const glyphNode = new Node();
        this._glyph = glyphNode.addComponent(Label);
        this._glyph.fontSize = c.fontSize;
        this._glyph.color = c.color;
        this.node.addChild(glyphNode);

        this.node.on(Input.POINTER_DOWN, this._toggle, this);
        document.addEventListener('fullscreenchange', this._sync);
        document.addEventListener('webkitfullscreenchange', this._sync as EventListener);

        const root = document.documentElement as VendorFullscreenElement;
        this.node.active = Boolean(root.requestFullscreen || root.webkitRequestFullscreen);
        this._sync();
    }

    detach(): void {
        this.node.off(Input.POINTER_DOWN, this._toggle, this);
        document.removeEventListener('fullscreenchange', this._sync);
        document.removeEventListener('webkitfullscreenchange', this._sync as EventListener);
    }

    private _toggle(): void {
        const c = cfg.fullscreenButton;
        const doc = document as VendorFullscreenDocument;
        const root = document.documentElement as VendorFullscreenElement;
        const fullscreenElement = doc.fullscreenElement ?? doc.webkitFullscreenElement;

        this._glyph.color = c.pressedColor;
        this._background.fillColor = c.pressedBackgroundColor;

        if (fullscreenElement) {
            const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
            if (exit) {
                try {
                    void Promise.resolve(exit.call(doc)).catch(this._sync);
                } catch {
                    this._sync();
                }
            }
            return;
        }

        const request = root.requestFullscreen ?? root.webkitRequestFullscreen;
        if (request) {
            try {
                void Promise.resolve(request.call(root)).catch(this._sync);
            } catch {
                this._sync();
            }
        }
    }

    private _sync = (): void => {
        const c = cfg.fullscreenButton;
        const doc = document as VendorFullscreenDocument;
        const isFullscreen = Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement);
        this._glyph.text = isFullscreen ? c.exitGlyph : c.enterGlyph;
        this._glyph.color = c.color;
        this._background.fillColor = c.backgroundColor;
    };
}
