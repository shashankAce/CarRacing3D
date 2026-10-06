/**
 * Bundles scripts/rideDataCheck.ts to an ESM file Node can run. The game's
 * extensionless TS imports can't be fed to Node directly, so the check goes
 * through Vite once, then runs plain: `node scripts/.out/rideDataCheck.mjs`.
 */
import { build } from 'vite';

await build({
    configFile: false,
    logLevel: 'error',
    build: {
        target: 'node20',
        minify: false,
        sourcemap: false,
        outDir: 'scripts/.out',
        emptyOutDir: true,
        lib: {
            entry: 'scripts/rideDataCheck.ts',
            formats: ['es'],
            fileName: () => 'rideDataCheck.mjs',
        },
    },
});
