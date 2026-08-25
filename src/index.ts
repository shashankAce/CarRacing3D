import { GameEngine, Scene, Node, AssetItem, assetCache, Sprite, Label, createPlatform, ResolutionPolicy, RendererType } from 'noonengine';

const GAME_WIDTH: number = 720;
const GAME_HEIGHT: number = 1280;

// Host-platform wrapper — the same three calls (initialize / reportProgress /
// notifyReady) work for every target, so nothing below ever branches on which
// platform this is. With no platform targeted (a plain `npm run dev`/`npm run
// build`) this is a working no-op, so leave it in even if you only ship to the
// open web: it costs nothing, and it's what makes `noonengine pack
// --platform=facebook|telegram|youtube` work later without touching this file.
const platform = createPlatform();
await platform.initialize();  // must be awaited BEFORE constructing GameEngine

const engine = new GameEngine({
    renderType: RendererType.WEBGL,
    showStats: true,
});

class MainScene extends Scene {

    onLoad() {

        const list: AssetItem[] = [
            { src: 'res/bunny.jpg', type: 'image', alias: 'bunny' },
        ]

        // The progress callback drives the host's own loading bar (Facebook
        // shows one; a plain web build ignores it).
        assetCache.preloadAssets(list, p => platform.reportProgress(p))
            .then(() => this.updateUI());
    }

    updateUI() {
        const node = new Node(GAME_WIDTH / 2, GAME_HEIGHT / 2);
        const label: Label = node.addComponent(Label);
        label.text = 'Hello, NoonEngine!';
        label.fontSize = 32;
        label.color = '#ffffff';
        this.addChild(node);

        let buttonNode = new Node(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 100);
        buttonNode.name = 'button';
        let spr = buttonNode.addComponent(Sprite);
        const asset = assetCache.getAsset('button');
        spr.texture = asset;
        this.addChild(buttonNode);

        // Dismisses the host's loading screen. Move this to whenever YOUR game
        // is genuinely playable — too early and the player watches a blank
        // canvas behind a dismissed spinner; never, and some hosts eventually
        // time the game out.
        platform.notifyReady();
    }

    update(dt: number): void { }
}

engine.setDesignResolution(GAME_WIDTH, GAME_HEIGHT, ResolutionPolicy.FIXED_HEIGHT);
engine.runScene(new MainScene());
engine.start();
