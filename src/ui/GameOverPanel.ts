import { ColorRect, Graphics, Input, Label, Node, Scene } from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';

/** All-time best run distance, persisted across sessions. */
const BEST_DISTANCE_KEY = 'carRacing3D.bestDistance';

/**
 * End-of-run card. Layout mirrors reference/design/gameover/code.html: a flat
 * card (no tactile-gradient fill) floating over a darkened backdrop, with a
 * crash-reason header, a distance/score stat grid, a best-distance/cuts
 * strip, and a single "play again" action.
 */
export class GameOverPanel {

    readonly interactiveNodes: readonly Node[];
    private readonly _root = new Node();
    private readonly _reason: Label;
    private readonly _distanceValue: Label;
    private readonly _scoreValue: Label;
    private readonly _bestValue: Label;
    private readonly _cutsValue: Label;

    constructor(scene: Scene, private readonly _onReplay: () => void) {
        const c = cfg.overlays;
        const e = c.gameEnd;
        const cx = cfg.design.width / 2;
        const contentWidth = c.panelWidth - e.framePad * 2;
        this._root.name = 'GameEndOverlay';
        scene.addChild(this._root);

        const backdrop = new Node(cx, cfg.design.height / 2);
        backdrop.width = cfg.design.width;
        backdrop.height = cfg.design.height;
        backdrop.addComponent(ColorRect).color = c.backdropColor;
        this._root.addChild(backdrop);

        // Card — a flat surface (no tactile-gradient), matching the pause modal.
        this._surface(cx + 6, e.panelY - 10, c.panelWidth, e.panelHeight, c.panelRadius, c.panelShadow);
        this._surface(cx, e.panelY, c.panelWidth, e.panelHeight, c.panelRadius, c.panelColor, c.panelStroke);

        // Header — the crash reason ("CRASHED" / "OUT OF FUEL") stands in for the
        // reference's static "GAME OVER" headline.
        this._reason = this._label(cx, e.reasonY, '', e.reasonFontSize, e.reasonColor, 'rajdhani_bold');
        this._reason.fontStyle = 'italic';
        this._reason.node.width = contentWidth;
        this._reason.overflow = Label.Overflow.SHRINK;
        this._reason.setShadow(0, 4, 14, '#000000b3');

        const divider = new Node(cx, e.dividerY);
        divider.width = contentWidth;
        divider.height = 2;
        divider.addComponent(ColorRect).color = e.dividerColor;
        this._root.addChild(divider);

        // Stat grid — distance (left) / score (right).
        const statBoxWidth = (contentWidth - e.statBoxGap) / 2;
        const boxOffset = statBoxWidth / 2 + e.statBoxGap / 2;
        this._statBox(cx - boxOffset, e.statBoxY, statBoxWidth, 'DISTANCE');
        this._statBox(cx + boxOffset, e.statBoxY, statBoxWidth, 'SCORE');
        this._distanceValue = this._statValue(cx - boxOffset, e.statBoxY, statBoxWidth, e.distanceColor);
        this._scoreValue = this._statValue(cx + boxOffset, e.statBoxY, statBoxWidth, e.scoreColor);

        // Secondary strip — best distance (left) / cuts (right), recessed within the card.
        this._surface(cx, e.secondaryY, contentWidth, e.secondaryHeight, 14, '#00000033', c.neutral);
        const vDivider = new Node(cx, e.secondaryY);
        vDivider.width = 2;
        vDivider.height = e.secondaryHeight - 24;
        vDivider.addComponent(ColorRect).color = c.neutral;
        this._root.addChild(vDivider);

        // Each column is a fixed-width box anchored at its own centre, with text
        // aligned to the box's inner edge — textAlign only takes effect within a
        // fixed node.width; an auto-sized box always centres on its node regardless
        // of alignment, which is what pushed this text outside the strip before.
        const columnInset = 24;
        const columnWidth = contentWidth / 2 - columnInset;
        const leftColumnX = cx - contentWidth / 4;
        const rightColumnX = cx + contentWidth / 4;

        this._secondaryLabel(leftColumnX, e.secondaryY + 16, columnWidth, 'BEST DISTANCE', e.secondaryLabelFontSize, c.mutedColor, Label.TextAlign.LEFT);
        this._bestValue = this._secondaryLabel(leftColumnX, e.secondaryY - 14, columnWidth, '', e.secondaryValueFontSize, c.surfaceColor, Label.TextAlign.LEFT, 'rajdhani_bold');

        this._secondaryLabel(rightColumnX, e.secondaryY + 16, columnWidth, 'CUTS', e.secondaryLabelFontSize, c.mutedColor, Label.TextAlign.RIGHT);
        this._cutsValue = this._secondaryLabel(rightColumnX, e.secondaryY - 14, columnWidth, '', e.secondaryValueFontSize, c.orange, Label.TextAlign.RIGHT, 'rajdhani_bold');

        // Action — "PLAY AGAIN" (the reference's "MAIN MENU" button is dropped).
        const playAgain = new Node(cx, e.buttonY);
        playAgain.name = 'PlayAgainButton';
        playAgain.width = c.panelWidth - 72;
        playAgain.height = c.buttonHeight;
        const shelfNode = new Node(0, -c.buttonShelf / 2);
        shelfNode.addComponent(Graphics).drawRoundedRectangle(playAgain.width, c.buttonHeight, c.buttonRadius, c.orangeShelf);
        playAgain.addChild(shelfNode);
        const faceNode = new Node(0, c.buttonShelf / 2);
        faceNode.addComponent(Graphics).drawRoundedRectangle(playAgain.width, c.buttonHeight - c.buttonShelf, c.buttonRadius, c.orange);
        playAgain.addChild(faceNode);
        // Inner top-edge highlight — the "physical, pressable" glow called out in DESIGN.md.
        const highlight = new Node(0, c.buttonHeight / 2 - c.buttonShelf - 1);
        highlight.width = playAgain.width - c.buttonRadius;
        highlight.height = 2;
        highlight.addComponent(ColorRect).color = '#ffffff4d';
        faceNode.addChild(highlight);
        const label = this._label(0, c.buttonShelf / 2, e.playAgainText, e.buttonFontSize, c.buttonText, 'rajdhani_bold');
        this._root.removeChild(label.node);
        playAgain.addChild(label.node);
        playAgain.on(Input.POINTER_DOWN, () => {
            faceNode.y = -c.buttonShelf / 2;
            label.node.y = -c.buttonShelf / 2;
            this._onReplay();
        }, this);
        this._root.addChild(playAgain);
        this.interactiveNodes = [playAgain];

        this._root.active = false;
    }

    get isVisible(): boolean { return this._root.active; }

    show(title: string, distance: number, cuts: number, score: number): void {
        this._reason.text = title;
        this._distanceValue.text = `${Math.floor(distance).toLocaleString()} m`;
        this._scoreValue.text = score.toLocaleString();
        this._cutsValue.text = `${cuts}`;
        this._bestValue.text = `${this._updateBestDistance(distance).toLocaleString()} m`;
        this._root.active = true;
    }

    hide(): void {
        this._root.active = false;
    }

    /** Reads/writes the persisted best run distance, returning the value to display. */
    private _updateBestDistance(distance: number): number {
        const current = Math.floor(distance);
        let best = 0;
        try {
            best = Math.floor(parseFloat(localStorage.getItem(BEST_DISTANCE_KEY) ?? '0')) || 0;
        } catch { /* localStorage unavailable (e.g. private browsing) */ }
        if (current > best) {
            best = current;
            try { localStorage.setItem(BEST_DISTANCE_KEY, String(best)); } catch { /* ignore */ }
        }
        return best;
    }

    private _surface(x: number, y: number, width: number, height: number, radius: number, fill: string, stroke?: string): Node {
        const node = new Node(x, y);
        const graphic = node.addComponent(Graphics);
        if (stroke) graphic.setStroke(stroke, 2);
        graphic.drawRoundedRectangle(width, height, radius, fill);
        this._root.addChild(node);
        return node;
    }

    private _statBox(x: number, y: number, width: number, caption: string): void {
        const e = cfg.overlays.gameEnd;
        const box = new Node(x, y);
        box.addComponent(Graphics).setStroke(e.statBoxStroke, 1.5).drawRoundedRectangle(width, e.statBoxHeight, 16, e.statBoxColor);
        this._root.addChild(box);
        const label = this._label(x, y + e.statBoxHeight / 2 - 26, caption, e.statLabelFontSize, cfg.overlays.mutedColor, 'rajdhani_light');
        label.letterSpacing = 1.5;
    }

    private _statValue(x: number, y: number, width: number, color: string): Label {
        const e = cfg.overlays.gameEnd;
        const value = this._label(x, y - e.statBoxHeight / 2 + 46, '', e.statNumberFontSize, color, 'rajdhani_bold');
        value.node.width = width - 20;
        value.overflow = Label.Overflow.SHRINK;
        return value;
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

    /** A `_label` fixed to a `width`-wide box, so LEFT/RIGHT `align` anchors to that box's inner edge instead of centring on `x`. */
    private _secondaryLabel(x: number, y: number, width: number, text: string, size: number, color: string, align: string, fontFamily = 'rajdhani_light'): Label {
        const label = this._label(x, y, text, size, color, fontFamily);
        label.node.width = width;
        label.textAlign = align;
        return label;
    }
}
