import * as THREE from 'three';
import { gameConfig as cfg } from '../config/gameConfig';
import { skyColorAt } from './sky/skyModel';

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
    const toSrgbByte = (v: number) => {
        const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
        return Math.max(0, Math.min(255, Math.round(c * 255)));
    };

    const scratch = new THREE.Color();
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        // v = 0 at the top of the sphere; elevation runs +90 to -90.
        const elev = (0.5 - (y + 0.5) / height) * Math.PI;
        const cosEl = Math.cos(elev), sinEl = Math.sin(elev);
        for (let x = 0; x < width; x++) {
            // Full azimuth sweep, so a reflection is correct in any direction
            // rather than assuming the sky is the same all the way round — which
            // it is not once the sun's glow is in it.
            const az = ((x + 0.5) / width) * Math.PI * 2;
            skyColorAt([Math.sin(az) * cosEl, sinEl, Math.cos(az) * cosEl], scratch);
            const i = (y * width + x) * 4;
            data[i] = toSrgbByte(scratch.r);
            data[i + 1] = toSrgbByte(scratch.g);
            data[i + 2] = toSrgbByte(scratch.b);
            data[i + 3] = 255;
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
