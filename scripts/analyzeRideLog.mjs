/**
 * analyzeRideLog — offline reader for `ride-telemetry-*.ndjson`.
 *
 * Usage: node scripts/analyzeRideLog.mjs <file.ndjson>
 *
 * Digs into the per-frame rows beyond the in-game summary: startup transient,
 * maxGroundGap ceiling riding, pitch tracking by speed bucket, per-tyre
 * cross-track asymmetry vs yaw/road edge, and the frames around the crash.
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
    console.error('usage: node scripts/analyzeRideLog.mjs <file.ndjson>');
    process.exit(1);
}

const rows = [];
let meta = null;
let summary = null;
const episodes = [];
for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (obj.type === 'meta') meta = obj;
    else if (obj.type === 'summary') summary = obj.summary;
    else if (obj.type === 'episode') episodes.push(obj.episode);
    else if (obj.t !== undefined) rows.push(obj);
}
if (!rows.length) { console.error('no samples'); process.exit(1); }

const cfg = meta?.config ?? {};
const p = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };
const stats = (arr) => arr.length ? {
    min: Math.min(...arr), mean: arr.reduce((a, b) => a + b, 0) / arr.length,
    p95: p(arr, 0.95), max: Math.max(...arr),
} : null;
const f = (v, d = 3) => v.toFixed(d);
const rowStats = (key) => stats(rows.map((r) => r[key]));

const first = rows[0];
const last = rows[rows.length - 1];
const dt = last.t - first.t;

console.log('== run ==');
console.log(`  samples ${rows.length}  duration ${f(dt, 2)}s  ${first.t}s → ${last.t}s`);
console.log(`  speed  ${f(rowStats('v').min, 1)} … ${f(rowStats('v').max, 1)} m/s (mean ${f(rowStats('v').mean, 1)})`);
console.log(`  tz     ${f(first.tz, 1)} → ${f(last.tz, 1)} m   wheelBottomOffset ${meta?.wheelBottomOffset ?? '?'}`);

const warmupCut = rows.find((r) => r.vis <= 0.06);
console.log('\n== startup transient ==');
console.log(`  first frame: vis ${f(first.vis)} gapC ${f(first.gapC)} pitchT ${f(first.pitchT * 57.3, 1)}deg pitch ${f(first.pitch * 57.3, 1)}deg`);
console.log(`  vis <= 6cm first reached at t=${f(warmupCut?.t ?? -1)}s (tz ${f(warmupCut?.tz ?? -1, 1)})`);

const steady = rows.filter((r) => r.t > 1.0);
const vis = steady.map((r) => r.vis);
const gapC = steady.map((r) => r.gapC);
const absPitchErr = steady.map((r) => Math.abs((r.pitchT - r.pitch) * 57.2958));
console.log(`\n== steady state (t > 1s, ${steady.length} frames) ==`);
console.log(`  vis      mean ${f(stats(vis).mean)}  p95 ${f(stats(vis).p95)}  max ${f(stats(vis).max)}  min ${f(stats(vis).min)}`);
console.log(`  gapC     mean ${f(stats(gapC).mean)}  p95 ${f(stats(gapC).p95)}  max ${f(stats(gapC).max)}`);
console.log(`  |pitchErr| deg  mean ${f(stats(absPitchErr).mean, 2)}  p95 ${f(stats(absPitchErr).p95, 2)}  max ${f(stats(absPitchErr).max, 2)}`);
console.log(`  rib      max |${f(stats(steady.map((r) => Math.abs(r.rib))).max)}|   sMax max ${f(stats(steady.map((r) => r.sMax)).max)}`);

const ceiling = cfg.maxGroundGap ?? 0.04;
const atCeiling = steady.filter((r) => r.gapC >= ceiling - 0.003);
const descents = steady.filter((r) => r.pitchT < -0.005);
const ascents = steady.filter((r) => r.pitchT > 0.005);
const atCeilingDesc = descents.filter((r) => r.gapC >= ceiling - 0.003);
console.log(`\n== ceiling riding (maxGroundGap ${ceiling}m) ==`);
console.log(`  frames with gapC >= ${f(ceiling - 0.003)}: ${atCeiling.length}/${steady.length} (${f(100 * atCeiling.length / steady.length, 1)}%)`);
console.log(`  descents: ${descents.length} frames, at ceiling ${atCeilingDesc.length} (${descents.length ? f(100 * atCeilingDesc.length / descents.length, 1) : 0}%)`);
console.log(`  gapC descents mean ${descents.length ? f(stats(descents.map((r) => r.gapC)).mean) : 'n/a'}   ascents mean ${ascents.length ? f(stats(ascents.map((r) => r.gapC)).mean) : 'n/a'}`);

console.log('\n== by speed bucket (steady) ==');
console.log('  bucket      n   visMean  visP95  |pitchErr|p95  gapCmean');
for (const [lo, hi] of [[0, 25], [25, 35], [35, 45], [45, 55], [55, 99]]) {
    const bin = steady.filter((r) => r.v >= lo && r.v < hi);
    if (!bin.length) continue;
    const bv = bin.map((r) => r.vis);
    const bp = bin.map((r) => Math.abs((r.pitchT - r.pitch) * 57.2958));
    console.log(
        `  ${String(lo).padStart(3)}-${String(hi).padStart(3)}  ${String(bin.length).padStart(5)}`
        + `  ${f(stats(bv).mean)}   ${f(stats(bv).p95)}    ${f(stats(bp).p95, 2)}        ${f(stats(bin.map((r) => r.gapC)).mean)}`,
    );
}

// Right track mean minus left track mean — 0 on a flat-lateral road; grows
// only when yaw × grade or an edge drop leaks into the contacts.
const cross = rows.map((r) => (r.gFR + r.gRR) / 2 - (r.gFL + r.gRL) / 2);
const absCross = cross.map(Math.abs);
const worstIdx = absCross.indexOf(Math.max(...absCross));
console.log('\n== cross-track asymmetry (right - left tyre gap) ==');
console.log(`  mean ${f(stats(cross).mean)}  p95 |${f(p(absCross, 0.95))}|  max |${f(absCross[worstIdx])}| @ t=${f(rows[worstIdx].t)}s tz=${f(rows[worstIdx].tz, 1)} off=${f(rows[worstIdx].off, 2)} yaw=${f(rows[worstIdx].yaw)}`);
const bigCross = rows.filter((r, i) => absCross[i] > 0.05);
console.log(`  frames |cross| > 5cm: ${bigCross.length}`
    + (bigCross.length
        ? `  (|yaw| mean ${f(stats(bigCross.map((r) => Math.abs(r.yaw))).mean)}  |off| mean ${f(stats(bigCross.map((r) => Math.abs(r.off))).mean)})`
        : ''));
for (const k of ['gFL', 'gFR', 'gRL', 'gRR']) {
    const neg = rows.filter((r) => r[k] < -0.002).length;
    console.log(`  ${k} below -2mm: ${neg} frames  (min ${f(rowStats(k).min)})`);
}

console.log('\n== road position ==');
console.log(`  off  mean ${f(stats(rows.map((r) => r.off)).mean, 2)}  min ${f(stats(rows.map((r) => r.off)).min, 2)}  max ${f(stats(rows.map((r) => r.off)).max, 2)}`);
console.log(`  |off| > 5m frames: ${rows.filter((r) => Math.abs(r.off) > 5).length}`);

console.log('\n== episodes ==');
for (const e of episodes) {
    console.log(`  ${e.kind}  t ${f(e.t0, 2)}-${f(e.t1, 2)}s (${f(e.t1 - e.t0, 2)}s)  max ${f(e.vMax)}  @ tz ${f(e.tzAtMax, 1)}`);
}

console.log('\n== last frames (crash context) ==');
console.log('  t      tz     v     off    yaw    gapC   vis    gFL    gFR    gRL    gRR');
for (const r of rows.slice(-12)) {
    console.log(
        `  ${f(r.t, 2).padStart(5)} ${f(r.tz, 1).padStart(6)} ${f(r.v, 1).padStart(5)} ${f(r.off, 2).padStart(6)}`
        + ` ${f(r.yaw).padStart(6)} ${f(r.gapC).padStart(6)} ${f(r.vis).padStart(6)}`
        + ` ${f(r.gFL).padStart(6)} ${f(r.gFR).padStart(6)} ${f(r.gRL).padStart(6)} ${f(r.gRR).padStart(6)}`,
    );
}

if (summary) {
    console.log('\n== in-game summary echo ==');
    console.log(`  episodes ${JSON.stringify(summary.episodeCounts)}  wheelBottomOffset ${summary.wheelBottomOffset}`);
    const s = summary.stats;
    console.log(`  vis p95 ${s.vis.p95} max ${s.vis.max} | gapC p95 ${s.gapC.p95} | pitchErrDeg p95 ${s.pitchErrDeg.p95} max ${s.pitchErrDeg.max} | sMax ${s.sMax.max}`);
}
