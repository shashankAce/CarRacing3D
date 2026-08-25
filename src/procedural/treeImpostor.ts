import * as THREE from 'three';
import { gameConfig as cfg } from '../config/gameConfig';
import type { TreeVariant } from './tree';

/**
 * Bakes a tree variant's own mesh into a texture, once, on the GPU.
 *
 * This is the accurate form of the impostor: the distant billboard carries a
 * picture of *this exact tree*, lit the same way, so the crossover from geometry
 * to quad changes only the triangle count and not the silhouette, proportions or
 * colour. Redrawing the tree procedurally on a canvas (the first attempt) got
 * close, but "close" is exactly what shows as a pop at the swap.
 *
 * Why it can't just happen in a constructor: the engine creates its WebGL
 * renderer lazily on the first frame, so there is nothing to render with until
 * `ThreeSceneSystem.onRendererReady` fires. Hence a separate bake step the scene
 * calls from there.
 *
 * The camera is orthographic and framed exactly to the variant's bounds, so the
 * quad that later shows this texture subtends the same angle as the mesh did.
 * Lights match the main scene's, or the impostor would read as a different
 * material at the crossover.
 */
export function bakeTreeImpostor(
    renderer: THREE.WebGLRenderer,
    variant: TreeVariant,
    material: THREE.Material,
    size: number,
): THREE.Texture {
    const target = new THREE.WebGLRenderTarget(size, size, {
        // Transparent background, and mipmaps because these quads are viewed at
        // small screen sizes where an unmipmapped texture aliases badly.
        format: THREE.RGBAFormat,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
    });

    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(variant.geometry, material);
    scene.add(mesh);

    const l = cfg.lighting;
    const ambient = new THREE.AmbientLight(l.ambientColor, l.ambientIntensity);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(l.sunColor, l.sunIntensity);
    const d = l.sunDirection;
    sun.position.set(d.x, d.y, d.z);
    scene.add(sun);

    // Framed to the variant's own bounds. A little margin so the widest tier
    // isn't clipped by half a pixel, which would show as a cut-off silhouette.
    const halfW = (variant.width * 0.5) * 1.06;
    const halfH = (variant.height * 0.5) * 1.03;
    // Square frame, so the baked aspect matches the quad's and nothing stretches.
    const half = Math.max(halfW, halfH);
    const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 1000);
    // Looking along -Z at the tree's mid-height, matching how the billboard is
    // later positioned (quad origin at its centre, geometry origin at its base).
    camera.position.set(0, variant.height * 0.5, 100);
    camera.lookAt(0, variant.height * 0.5, 0);

    // The renderer is shared with the live scene, so every piece of state this
    // touches has to go back exactly as it was.
    const previousTarget = renderer.getRenderTarget();
    const previousClear = new THREE.Color();
    renderer.getClearColor(previousClear);
    const previousAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClear, previousAlpha);

    // The geometry and material belong to the live scene — only the throwaway
    // wrappers are released.
    scene.remove(mesh, ambient, sun);
    ambient.dispose();
    sun.dispose();

    return target.texture;
}

/** Aspect the baked frame used, so the billboard quad can match it. */
export function impostorFrameSize(variant: TreeVariant): number {
    return Math.max((variant.width * 0.5) * 1.06, (variant.height * 0.5) * 1.03) * 2;
}
