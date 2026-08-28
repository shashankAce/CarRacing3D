import * as THREE from 'three';
import { gameConfig as cfg } from '../config/gameConfig';
import { mergeGeometries, paintGeometry } from './mergeGeometry';
import { mulberry32 } from './random';

export interface DesertPropVariant {
    geometry: THREE.BufferGeometry;
    height: number;
    rock: boolean;
}

function indexedPainted(geometry: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
    const part = paintGeometry(geometry.toNonIndexed(), color);
    const count = part.attributes.position.count;
    const index = new Uint16Array(count);
    for (let i = 0; i < count; i++) index[i] = i;
    part.setIndex(new THREE.BufferAttribute(index, 1));
    return part;
}

function cactus(seed: number): DesertPropVariant {
    const rand = mulberry32(seed);
    const height = 5.2 + rand() * 3.6;
    const radius = height * (0.075 + rand() * 0.018);
    const base = new THREE.Color(cfg.desertProps.cactusColor);
    const tip = new THREE.Color(cfg.desertProps.cactusHighlight);
    const parts: THREE.BufferGeometry[] = [];

    const trunk = new THREE.CylinderGeometry(radius * 0.82, radius, height, 7, 3, false);
    trunk.translate(0, height * 0.5, 0);
    parts.push(indexedPainted(trunk, base));

    const side = rand() > 0.5 ? 1 : -1;
    const armY = height * (0.42 + rand() * 0.18);
    const armLength = height * (0.22 + rand() * 0.08);
    const armRadius = radius * 0.72;
    const horizontal = new THREE.CylinderGeometry(armRadius, armRadius, armLength, 6, 1, false);
    horizontal.rotateZ(Math.PI / 2);
    horizontal.translate(side * armLength * 0.5, armY, 0);
    parts.push(indexedPainted(horizontal, base));

    const raised = height * (0.23 + rand() * 0.12);
    const upright = new THREE.CylinderGeometry(armRadius * 0.84, armRadius, raised, 6, 1, false);
    upright.translate(side * armLength, armY + raised * 0.5, 0);
    parts.push(indexedPainted(upright, tip));

    const merged = mergeGeometries(parts);
    merged.computeBoundingSphere();
    return { geometry: merged, height, rock: false };
}

function rock(seed: number): DesertPropVariant {
    const rand = mulberry32(seed);
    const height = 1.8 + rand() * 2.1;
    const geometry = new THREE.DodecahedronGeometry(1, 0);
    geometry.scale(1.1 + rand() * 0.7, height * 0.5, 0.85 + rand() * 0.55);
    geometry.rotateY(rand() * Math.PI);
    geometry.translate(0, height * 0.45, 0);
    const color = new THREE.Color(cfg.desertProps.rockLowColor)
        .lerp(new THREE.Color(cfg.desertProps.rockHighColor), rand());
    const painted = indexedPainted(geometry, color);
    painted.computeBoundingSphere();
    return { geometry: painted, height, rock: true };
}

export function createDesertProp(seed: number, index: number): DesertPropVariant {
    return index < 2 ? cactus(seed) : rock(seed);
}

export function createDesertPropMaterial(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.88,
        flatShading: true,
    });
}
