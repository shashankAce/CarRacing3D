import * as THREE from 'three';
import { surfaceHeightAt } from '../procedural/heightField';

/** A rigid chassis supported by tyre bottoms in the normalized model frame. */
export class VehicleGrounding {
    pitch = 0;
    roll = 0;
    height = 0;
    private _euler = new THREE.Euler(0, 0, 0, 'YXZ');
    private _quaternion = new THREE.Quaternion();
    private _point = new THREE.Vector3();

    solve(
        contacts: readonly THREE.Vector3[], x: number, worldZ: number, yaw: number,
        heightAt = surfaceHeightAt,
    ): void {
        // Fit the residuals at the actual rotated contacts, refining the tilt
        // because pitching also moves the contacts horizontally. No per-frame
        // allocations, and no suspension lag that lifts the trailing axle.
        this.pitch = 0;
        this.roll = 0;
        for (let iteration = 0; iteration < 5; iteration++) {
            this._euler.set(this.pitch, yaw, this.roll, 'YXZ');
            this._quaternion.setFromEuler(this._euler);
            let sx = 0, sz = 0, sh = 0, sxx = 0, szz = 0, sxz = 0, sxh = 0, szh = 0;
            for (const contact of contacts) {
                this._point.copy(contact).applyQuaternion(this._quaternion);
                const h = heightAt(x + this._point.x, worldZ - this._point.z) - this._point.y;
                sx += contact.x; sz += contact.z; sh += h;
                sxx += contact.x * contact.x; szz += contact.z * contact.z;
                sxz += contact.x * contact.z; sxh += contact.x * h; szh += contact.z * h;
            }
            const n = contacts.length;
            const xx = sxx - sx * sx / n, zz = szz - sz * sz / n;
            const xz = sxz - sx * sz / n;
            const xh = sxh - sx * sh / n, zh = szh - sz * sh / n;
            const determinant = xx * zz - xz * xz;
            if (Math.abs(determinant) < 1e-8) break;
            this.roll += Math.atan((xh * zz - zh * xz) / determinant);
            this.pitch -= Math.atan((zh * xx - xh * xz) / determinant);
        }
        this._euler.set(this.pitch, yaw, this.roll, 'YXZ');
        this._quaternion.setFromEuler(this._euler);
        this.height = -Infinity;
        for (const contact of contacts) {
            this._point.copy(contact).applyQuaternion(this._quaternion);
            this.height = Math.max(this.height,
                heightAt(x + this._point.x, worldZ - this._point.z) - this._point.y);
        }
    }
}

/** Startup fallback until the selected model's measured tyres are loaded. */
export function fallbackTyreContacts(width: number, length: number): THREE.Vector3[] {
    return [-1, 1].flatMap(x => [-1, 1].map(z =>
        new THREE.Vector3(x * width * 0.42, 0, z * length * 0.31)));
}
