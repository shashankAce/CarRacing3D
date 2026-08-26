import * as THREE from 'three';
import { gameConfig as cfg } from '../config/gameConfig';
import { effectiveHorizonColor, sunHeight } from './sky/SkyDome';

/**
 * skyEnv — a tiny equirectangular image of the sky, for materials that need
 * something to reflect.
 *
 * ## Why this has to exist before anything can be "metallic"
 *
 * `metalness` on a MeshStandardMaterial is not a gloss slider. It drives the
 * diffuse term toward ZERO and makes the surface reflect its environment
 * instead. With no environment there is nothing to reflect, so a metallic
 * surface in this scene renders nearly BLACK — the opposite of the intent. That
 * is why the trees were given roughness instead, and why the road gets this.
 *
 * ## Why it is 64x32 and generated
 *
 * It reflects a procedural sky, so it can be derived from the same numbers the
 * dome uses rather than shipped: zero bundle bytes against a 2MB budget, and it
 * cannot drift out of agreement with the sky the way a baked cubemap would. It
 * is deliberately not PMREM-processed — that exists to prefilter an environment
 * for varying roughness, and a smooth two-colour gradient has no detail to
 * prefilter. At this size the whole thing is 8KB of VRAM.
 *
 * Applied per-material, NOT as `scene.environment`. Setting it scene-wide would
 * add image-based light to every surface in the game and shift the whole palette
 * that was just matched to the reference.
 */
export function createSkyEnvTexture(width = 64, height = 32): THREE.DataTexture {
    const horizon = effectiveHorizonColor();
    const sh = sunHeight();
    // Same blend the dome's shader does, so a reflection agrees with the sky
    // actually overhead at this time of day.
    const zenith = new THREE.Color(cfg.sky.zenithLowColor)
        .lerp(new THREE.Color(cfg.sky.zenithColor), sh);

    const toSrgbByte = (v: number) => {
        const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
        return Math.max(0, Math.min(255, Math.round(s * 255)));
    };
    const smoothstep = (e: number, x: number) => {
        const t = Math.max(0, Math.min(1, x / e));
        return t * t * (3 - 2 * t);
    };

    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        // v = 0 at the top of the sphere; elevation runs +90 to -90.
        const elev = (0.5 - (y + 0.5) / height) * Math.PI;
        const h = Math.sin(elev);
        const t = Math.pow(smoothstep(cfg.sky.skyTopHeight, Math.max(h, 0)), cfg.sky.horizonHold);
        const r = horizon.r + (zenith.r - horizon.r) * t;
        const g = horizon.g + (zenith.g - horizon.g) * t;
        const b = horizon.b + (zenith.b - horizon.b) * t;
        const R = toSrgbByte(r), G = toSrgbByte(g), B = toSrgbByte(b);
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            data[i] = R; data[i + 1] = G; data[i + 2] = B; data[i + 3] = 255;
        }
    }

    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
}
