/**
 * WorldScroll — the single source of truth for "how far have we come".
 *
 * The car never actually travels: it stays at the origin and the world moves
 * past it. See ARCHITECTURE.md §5.1 for why (no floating-origin rebase, no
 * precision drift in any render transform, no unbounded coordinates).
 *
 * `travelled` is metres since the run started. An object at absolute `worldZ`
 * renders at `travelled - worldZ` — so something ahead of the car (larger
 * worldZ) renders at negative z, which is forward. Terrain and scatter sample
 * noise at absolute `worldZ` so the landscape never repeats, while every mesh
 * position stays in a small window around the camera.
 */
export class WorldScroll {

    /** Metres travelled since the run started. */
    travelled = 0;

    advance(distance: number): void {
        this.travelled += distance;
    }

    reset(): void {
        this.travelled = 0;
    }

    /** Absolute world Z → render-space z. */
    renderZ(worldZ: number): number {
        return this.travelled - worldZ;
    }

    /** Render-space z → absolute world Z. The inverse of `renderZ`. */
    worldZ(renderZ: number): number {
        return this.travelled - renderZ;
    }

    /**
     * Render-space z for repeating prop `index` of a set that repeats every
     * `spacing` metres and wraps after `count` of them.
     *
     * Props march toward the camera and wrap back to the far distance without
     * any pooling bookkeeping — the modulo does it. `aheadFraction` splits the
     * wrap span into the part drawn ahead of the car and the part trailing
     * behind it (a little behind is needed, or props pop out of existence at
     * the exact moment they're still visible in the camera's periphery).
     */
    repeatingZ(index: number, spacing: number, count: number, aheadFraction: number): number {
        const span = spacing * count;
        const ahead = span * aheadFraction;
        // `% span` on a positive sum is always positive, so no wrap correction.
        return ((index * spacing + this.travelled) % span) - ahead;
    }
}
