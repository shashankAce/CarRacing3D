import {
    BitmapText,
    ColorRect,
    Input,
    Label,
    Node,
    Scene,
    Sprite,
    Widget,
    assetCache,
    inputListener,
} from 'noonengine';
import { gameConfig as cfg } from '../config/gameConfig';
import type { VehicleModelId } from '../assets/VehicleModels';

type VehicleSpec = typeof cfg.vehicles.models[number];

const CHEVRON_ALIAS = 'car-select:chevron';
const STAT_ICON_ALIASES = [
    'car-select:top-speed',
    'car-select:acceleration',
    'car-select:braking',
] as const;

interface StatRow {
    fill: Node;
    track: Node;
    valueNode: Node;
    value: Label;
    maximum: number;
    read: (spec: VehicleSpec) => number;
    format: (value: number) => string;
    normalizedValue: number;
}

/** Reference-matched showroom navigation and responsive performance readout. */
export class CarSelectPanel {

    private readonly _root = new Node();
    private readonly _statsContainer: Node;
    private readonly _statsWidget: Widget;
    private readonly _name: Label;
    private readonly _description: Label;
    private readonly _stats: StatRow[] = [];
    private readonly _statIcons: Sprite[] = [];
    private readonly _arrowSprites: Sprite[] = [];
    private readonly _interactiveNodes: Node[] = [];
    private readonly _driveButton: Node;
    private _dragZone!: Node;
    private _index = 0;
    private _visible = false;
    private _dragPointerId: number | null = null;
    private _lastDragX = 0;
    private _lastDesignWidth = -1;

    constructor(
        scene: Scene,
        private readonly _onPreview: (id: VehicleModelId, direction: number) => boolean,
        private readonly _onDrive: (id: VehicleModelId) => void,
        private readonly _onRotate: (screenDeltaX: number) => void,
        private readonly _onDragState: (dragging: boolean) => void,
    ) {
        const c = cfg.carSelect;
        this._root.name = 'CarShowroomUI';
        scene.addChild(this._root);

        this._makeHeader();

        this._statsContainer = new Node();
        this._statsContainer.name = 'ResponsiveCarStats';
        this._statsContainer.anchorX = 0;
        this._statsContainer.anchorY = 1;
        this._statsContainer.width = c.statsPanelWidth;
        this._statsContainer.height = c.statsPanelHeight;
        this._statsWidget = this._statsContainer.addComponent(Widget);
        this._statsWidget.alignToWindow = true;
        this._statsWidget.left = c.statsPanelLeft;
        this._statsWidget.right = c.statsPanelRight;
        this._statsWidget.top = c.statsPanelTop;
        this._root.addChild(this._statsContainer);

        this._makeNameAccent();
        this._name = this._makeLabel(
            this._statsContainer,
            c.carNameX,
            c.carNameY,
            c.carNameFontSize,
            c.titleColor,
            true,
            Label.TextAlign.LEFT,
            0,
        );
        this._name.fontWeight = 800;
        this._name.fontFamily = 'rajdhani_bold';
        this._name.fontStyle = 'italic';
        this._name.letterSpacing = 5;

        this._description = this._makeLabel(
            this._statsContainer,
            c.descriptionX,
            c.descriptionY,
            c.descriptionFontSize,
            c.descriptionColor,
            true,
            Label.TextAlign.LEFT,
            0,
        );
        this._description.lineHeight = c.descriptionLineHeight;

        this._makeDragZone();
        this._makeArrow(-1);
        this._makeArrow(1);

        const statConfig = c.stats;
        this._stats.push(
            this._makeStatRow(0, statConfig.speedLabel, statConfig.maxSpeedKph,
                (spec) => spec.speed.max * 3.6, (value) => `${Math.round(value)} KM/H`),
            this._makeStatRow(1, statConfig.accelerationLabel, statConfig.maxAcceleration,
                (spec) => spec.speed.accelerate, (value) => `${value.toFixed(1)} M/S²`),
            this._makeStatRow(2, statConfig.brakingLabel, statConfig.maxBraking,
                (spec) => spec.speed.brake, (value) => `${value.toFixed(0)} M/S²`),
        );

        this._driveButton = this._makeDriveButton();
        this._layoutResponsive(true);
        inputListener.on(Input.POINTER_MOVE, this._onDragMove, null, this);
        inputListener.on(Input.POINTER_UP, this._onDragRelease, null, this);
        inputListener.on(Input.POINTER_CANCEL, this._onDragRelease, null, this);
        inputListener.on(Input.DRAG_END, this._onDragRelease, null, this);
        this.setLoading();
    }

    get interactiveNodes(): readonly Node[] { return this._interactiveNodes; }

    get selectedId(): VehicleModelId { return cfg.vehicles.models[this._index].id; }

    /** Loads only file-backed showroom UI art; procedural gradients need no preload. */
    async loadAssets(): Promise<void> {
        await assetCache.preloadAssets([
            { src: 'res/right-chevron.png', type: 'image', alias: CHEVRON_ALIAS },
            { src: 'res/speedometer.png', type: 'image', alias: STAT_ICON_ALIASES[0] },
            { src: 'res/acceleration.png', type: 'image', alias: STAT_ICON_ALIASES[1] },
            { src: 'res/disc-brake.png', type: 'image', alias: STAT_ICON_ALIASES[2] },
            { src: 'res/fontTTF/rajdhani-bold.ttf', type: 'font', fontName: 'rajdhani_bold', alias: 'rajdhani_bold' },
            { src: 'res/fontTTF/rajdhani-light.ttf', type: 'font', fontName: 'rajdhani_light', alias: 'rajdhani_light' },
            { src: 'res/fontTTF/rajdhani-semibold.ttf', type: 'font', fontName: 'rajdhani_semibold', alias: 'rajdhani_semibold' },
        ]);
        const chevron = assetCache.getAsset(CHEVRON_ALIAS);
        for (const sprite of this._arrowSprites) sprite.texture = chevron;
        for (let i = 0; i < this._statIcons.length; i++) {
            this._statIcons[i].texture = assetCache.getAsset(STAT_ICON_ALIASES[i]);
        }
    }

    setLoading(): void {
        this._visible = false;
        this._root.active = false;
    }

    show(initialId: VehicleModelId = cfg.vehicles.playerDefault): void {
        const index = cfg.vehicles.models.findIndex((model) => model.id === initialId);
        this._index = index >= 0 ? index : 0;
        this._visible = true;
        this._root.active = true;
        this._layoutResponsive(true);
        this._refresh();
    }

    update(): void {
        if (this._visible) this._layoutResponsive();
    }

    hide(): void {
        this._visible = false;
        if (this._dragPointerId !== null) this._onDragState(false);
        this._dragPointerId = null;
        this._root.active = false;
    }

    detach(): void {
        inputListener.off(Input.POINTER_MOVE, this._onDragMove, null);
        inputListener.off(Input.POINTER_UP, this._onDragRelease, null);
        inputListener.off(Input.POINTER_CANCEL, this._onDragRelease, null);
        inputListener.off(Input.DRAG_END, this._onDragRelease, null);
    }

    private _makeHeader(): void {
        const c = cfg.carSelect;
        const header = new Node(cfg.design.width * 0.5, cfg.design.height - c.headerHeight * 0.5);
        header.name = 'SelectYourRideHeader';
        header.width = cfg.design.width;
        header.height = c.headerHeight;
        const widget = header.addComponent(Widget);
        widget.alignToWindow = true;
        widget.left = 0;
        // widget.right = 0;
        // widget.top = 0;

        const background = header.addComponent(Sprite);
        background.sizeMode = Sprite.SizeMode.CUSTOM;
        background.texture = this._makeGradientTexture(
            c.headerGradientLeft,
            c.headerGradientCenter,
            c.headerGradientRight,
        );
        this._root.addChild(header);

        const lowerEdge = new Node(0, -c.headerHeight * 0.5 + 1);
        lowerEdge.width = cfg.design.width;
        lowerEdge.height = 2;
        lowerEdge.addComponent(ColorRect).color = c.headerEdgeColor;
        const edgeWidget = lowerEdge.addComponent(Widget);
        edgeWidget.left = 0;
        edgeWidget.right = 0;
        header.addChild(lowerEdge);

        const title = this._makeLabel(
            header,
            c.titleMainX,
            c.titleBaselineY,
            c.titleFontSize,
            c.titleColor,
        );
        title.text = c.title;
        title.fontFamily = 'rajdhani_bold';
        title.fontStyle = 'italic';
        title.letterSpacing = 5;

        const accent = this._makeLabel(
            header,
            c.titleAccentX,
            c.titleBaselineY,
            c.titleFontSize,
            c.titleAccentColor,
        );
        accent.text = c.titleAccent;
        accent.fontFamily = 'rajdhani_bold';
        accent.fontStyle = 'italic';
        accent.letterSpacing = 5;

    }

    private _makeNameAccent(): void {
        const c = cfg.carSelect;
        const accentNode = new Node(c.carNameAccentX, c.carNameY + 2);
        const accent = accentNode.addComponent(ColorRect);
        accent.color = c.titleAccentColor;
        accentNode.width = c.carNameAccentWidth;
        accentNode.height = c.carNameFontSize - 6;
        accentNode.rotation = c.carNameAccentRotation;
        this._statsContainer.addChild(accentNode);
    }

    private _makeDragZone(): void {
        const c = cfg.carSelect.showroom.drag;
        const node = new Node(cfg.design.width / 2, c.centerY);
        node.name = 'ShowroomCarDragZone';
        node.width = c.width;
        node.height = c.height;
        node.on(Input.POINTER_DOWN, this._onDragStart, this);
        this._root.addChild(node);
        this._interactiveNodes.push(node);
        this._dragZone = node;
    }

    private _onDragStart(e: any): void {
        if (!this._visible || this._dragPointerId !== null) return;
        this._dragPointerId = e.pointer.id;
        this._lastDragX = e.x;
        this._onDragState(true);
    }

    private _onDragMove(e: any): void {
        if (e.pointer.id !== this._dragPointerId) return;
        const deltaX = e.x - this._lastDragX;
        this._lastDragX = e.x;
        this._onRotate(deltaX);
    }

    private _onDragRelease(e: any): void {
        if (this._dragPointerId === null || e.pointer.id !== this._dragPointerId) return;
        this._dragPointerId = null;
        this._onDragState(false);
    }

    private _makeArrow(direction: -1 | 1): void {
        const c = cfg.carSelect;
        const node = new Node(0, c.arrowY);
        node.name = direction < 0 ? 'PreviousCarButton' : 'NextCarButton';
        node.width = c.arrowSize;
        node.height = c.arrowSize;
        const widget = node.addComponent(Widget);
        widget.alignToWindow = true;
        if (direction < 0) widget.left = c.arrowEdge;
        else widget.right = c.arrowEdge;

        const artNode = new Node();
        artNode.width = c.arrowSize;
        artNode.height = c.arrowSize;
        artNode.scaleX = direction;
        const art = artNode.addComponent(Sprite);
        art.sizeMode = Sprite.SizeMode.CUSTOM;
        node.addChild(artNode);
        this._arrowSprites.push(art);

        node.on(Input.POINTER_DOWN, () => this._navigate(direction), this);
        this._root.addChild(node);
        this._interactiveNodes.push(node);
    }

    private _makeStatRow(
        index: number,
        title: string,
        maximum: number,
        read: (spec: VehicleSpec) => number,
        format: (value: number) => string,
    ): StatRow {
        const c = cfg.carSelect;
        const y = c.statsFirstY - index * c.statsGap;

        const iconNode = new Node(c.statIconX, y);
        iconNode.width = c.statIconSize;
        iconNode.height = c.statIconSize;
        const icon = iconNode.addComponent(Sprite);
        icon.sizeMode = Sprite.SizeMode.CUSTOM;
        this._statsContainer.addChild(iconNode);
        this._statIcons.push(icon);

        const label = this._makeLabel(
            this._statsContainer,
            c.statLabelX,
            y + c.statLabelOffsetY,
            c.statFontSize,
            c.statLabelColor,
            false,
            Label.TextAlign.LEFT,
            0,
        );
        label.fontFamily = 'rajdhani_semibold';
        label.fontWeight = 700;
        label.text = title;

        const track = new Node(c.statBarX, y + c.statBarOffsetY);
        track.anchorX = 0;
        track.width = c.statBarWidth;
        track.height = c.statBarHeight;
        track.addComponent(ColorRect).color = c.statTrackColor;
        this._statsContainer.addChild(track);

        const fill = new Node(c.statBarX, y + c.statBarOffsetY);
        fill.anchorX = 0;
        fill.width = 0;
        fill.height = c.statBarHeight;
        fill.addComponent(ColorRect).color = c.statFillColor;
        this._statsContainer.addChild(fill);

        const valueNode = new Node(c.statsPanelWidth, y + c.statBarOffsetY);
        valueNode.anchorX = 0;
        const value = valueNode.addComponent(Label);
        value.fontSize = c.statValueFontSize;
        value.color = c.statValueColor;
        value.dynamic = true;
        value.fontWeight = 700;
        value.fontFamily = 'rajdhani_semibold';
        value.textAlign = Label.TextAlign.LEFT;
        this._statsContainer.addChild(valueNode);
        return { fill, track, valueNode, value, maximum, read, format, normalizedValue: 0 };
    }

    private _makeDriveButton(): Node {
        const c = cfg.carSelect;
        const node = new Node(cfg.design.width / 2, c.driveY);
        node.name = 'DriveThisCarButton';
        node.width = c.driveWidth;
        node.height = c.driveHeight;

        // const shadowNode = new Node(0, -c.driveShadowOffset);
        // shadowNode.width = c.driveWidth + c.driveShadowSpread;
        // shadowNode.height = c.driveHeight + c.driveShadowSpread;
        // const shadow = shadowNode.addComponent(Sprite);
        // shadow.sizeMode = Sprite.SizeMode.CUSTOM;
        // shadow.texture = this._makeButtonTexture(c.driveShadowColor, c.driveShadowColor, 'transparent');
        // node.addChild(shadowNode);

        const background = node.addComponent(Sprite);
        background.sizeMode = Sprite.SizeMode.CUSTOM;
        background.texture = this._makeButtonTexture(
            c.driveGradientTop,
            c.driveGradientBottom,
            c.driveStroke,
        );

        const labelNode = new Node();
        const label = labelNode.addComponent(Label);
        label.fontSize = c.driveFontSize;
        label.fontFamily = cfg.loading.fontFamily;
        label.color = c.driveColor;
        label.textAlign = 'center';
        label.text = c.driveText;
        label.fontFamily = 'rajdhani_bold';
        // label.fontStyle = 'italic';
        node.addChild(labelNode);

        node.on(Input.POINTER_DOWN, () => {
            if (this._visible) this._onDrive(this.selectedId);
        }, this);
        this._root.addChild(node);
        this._interactiveNodes.push(node);
        return node;
    }

    private _navigate(direction: -1 | 1): void {
        if (!this._visible) return;
        const count = cfg.vehicles.models.length;
        const next = (this._index + direction + count) % count;
        const id = cfg.vehicles.models[next].id;
        if (!this._onPreview(id, direction)) return;
        this._index = next;
        this._refresh();
    }

    private _refresh(): void {
        const spec = cfg.vehicles.models[this._index];
        this._name.text = spec.label;
        this._description.text = spec.description;
        for (const row of this._stats) {
            const value = row.read(spec);
            row.normalizedValue = Math.min(1, Math.max(0, value / row.maximum));
            row.value.text = row.format(value);
        }
        this._layoutStatsBars();
    }

    private _layoutResponsive(force = false): void {
        const c = cfg.carSelect;
        const designWidth = inputListener.engine?.display?.designWidth ?? cfg.design.width;
        if (!force && Math.abs(designWidth - this._lastDesignWidth) < 0.5) return;
        this._lastDesignWidth = designWidth;

        const statsWidth = Math.min(
            c.statsPanelWidth,
            Math.max(c.statsPanelMinWidth, designWidth - c.statsPanelLeft - c.statsPanelMinimumRight),
        );
        this._statsContainer.width = statsWidth;
        this._statsWidget.right = Math.max(
            c.statsPanelMinimumRight,
            designWidth - c.statsPanelLeft - statsWidth,
        );
        this._driveButton.x = designWidth * 0.5;
        this._dragZone.x = designWidth * 0.5;
        this._layoutStatsBars();
    }

    private _layoutStatsBars(): void {
        const c = cfg.carSelect;
        const statsWidth = this._statsContainer.width;
        const valueX = statsWidth - c.statValueRight;
        const valueXX = statsWidth - c.statValueRight - 60;
        const barWidth = Math.max(
            c.statBarMinWidth,
            valueX - c.statValueGap - c.statBarX,
        );
        for (const row of this._stats) {
            row.track.width = barWidth;
            row.fill.width = barWidth * row.normalizedValue;
            row.valueNode.x = valueXX;
        }
    }

    private _makeGradientTexture(left: string, center: string, right: string): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 8;
        const context = canvas.getContext('2d');
        if (!context) return canvas;
        const gradient = context.createLinearGradient(0, 0, canvas.width, 0);
        gradient.addColorStop(0, left);
        gradient.addColorStop(0.5, center);
        gradient.addColorStop(1, right);
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, canvas.height);
        return canvas;
    }

    private _makeButtonTexture(top: string, bottom: string, stroke: string): HTMLCanvasElement {
        const c = cfg.carSelect;
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 128;
        const context = canvas.getContext('2d');
        if (!context) return canvas;
        const inset = 4;
        const radius = c.driveCornerRadius * canvas.height / c.driveHeight;
        context.beginPath();
        context.roundRect(inset, inset, canvas.width - inset * 2, canvas.height - inset * 2, radius);
        context.clip();
        const gradient = context.createLinearGradient(0, inset, 0, canvas.height - inset);
        gradient.addColorStop(0, top);
        gradient.addColorStop(1, bottom);
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, canvas.height);
        if (stroke !== 'transparent') {
            context.lineWidth = 3;
            context.strokeStyle = stroke;
            context.stroke();
        }
        return canvas;
    }

    private _makeBitmapLabel(
        parent: Node,
        x: number,
        y: number,
        fontSize: number,
        color: string,
    ): BitmapText {
        const node = new Node(x, y);
        const label = node.addComponent(BitmapText);
        label.fontSize = fontSize;
        label.fontFamily = cfg.loading.fontFamily;
        label.color = color;
        label.textAlign = 'center';
        parent.addChild(node);
        return label;
    }

    private _makeLabel(
        parent: Node,
        x: number,
        y: number,
        fontSize: number,
        color: string,
        dynamic = false,
        textAlign: (typeof Label.TextAlign)[keyof typeof Label.TextAlign] = Label.TextAlign.CENTER,
        anchorX = 0.5,
    ): Label {
        const node = new Node(x, y);
        node.anchorX = anchorX;
        const label = node.addComponent(Label);
        label.fontSize = fontSize;
        label.color = color;
        label.dynamic = dynamic;
        label.textAlign = textAlign;
        parent.addChild(node);
        return label;
    }
}
