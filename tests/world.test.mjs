import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { WORLD_CONFIG, generateWorld, elevation, canOccupy } from '../world-data.js';

const digest = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
test('separate clients generate identical worlds without stored state', () => {
    const script = `import { generateWorld } from './world-data.js'; console.log(JSON.stringify(generateWorld()));`;
    const secondClient = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }));
    assert.equal(digest(generateWorld()), digest(secondClient));
    assert.notEqual(digest(generateWorld()), digest(generateWorld({ ...WORLD_CONFIG, seed: 42 })));
});
test('spawn and town roads remain walkable; buildings and world edge block movement', () => {
    const world = generateWorld();
    assert.ok(canOccupy(world, WORLD_CONFIG.spawn.x, WORLD_CONFIG.spawn.z));
    for (let z = -105; z <= 105; z++) assert.ok(canOccupy(world, 0, z));
    for (const b of world.buildings) assert.equal(canOccupy(world, b.x, b.z), false);
    for (const t of world.trees) assert.equal(canOccupy(world, t.x, t.z), false);
    assert.equal(canOccupy(world, 500, 0), false);
    assert.equal(canOccupy(world, NaN, 0), false);
});
test('terrain is finite, town is flat, and sampling order does not change heights', () => {
    const samples = [];
    for (let z = -400; z <= 400; z += 5) for (let x = -400; x <= 400; x += 5) {
        const y = elevation(x, z);
        assert.ok(Number.isFinite(y) && y >= -33 && y <= 31);
        samples.push([x, z, y]);
    }
    for (const [x, z, y] of samples.reverse()) assert.equal(elevation(x, z), y);
    assert.equal(elevation(0, 0), 3);
    assert.equal(elevation(100, 100), 3);
});
test('all generated objects have unique stable IDs', () => {
    const world = generateWorld();
    const ids = [...world.buildings, ...world.trees].map(object => object.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(world.buildings.length > 0 && world.trees.length > 0);
});

test('grounding matches raised pavement and road intersections', async () => {
    const { streetSurfaces, walkableHeight, terrainSurfaceHeight } = await import('../world-data.js');
    const surfaces = streetSurfaces(generateWorld().roads);
    assert.equal(walkableHeight(19, -4, surfaces), 3.24); // Reported clipping location.
    assert.equal(walkableHeight(0, 0, surfaces), 3.08);
    assert.equal(walkableHeight(4.5, 0, surfaces), 3.24); // Sidewalk over crossing road.
    assert.equal(walkableHeight(20, 20, surfaces), 3);
    assert.equal(walkableHeight(4.5, 107.7, surfaces), 3); // Beyond pavement end.
    assert.equal(walkableHeight(160.2, 141.3, surfaces), terrainSurfaceHeight(160.2, 141.3));
    assert.equal(terrainSurfaceHeight(150, 150), Math.fround(elevation(150, 150)));
});

test('benches block walking but allow jumping onto and standing on the seat', async () => {
    const { BENCHES, streetSurfaces, supportHeight, verticalStep } = await import('../world-data.js');
    const world = generateWorld(), surfaces = streetSurfaces(world.roads);
    for (const bench of BENCHES) {
        assert.equal(canOccupy(world, bench.x, bench.z, .45, 3.02), false);
        assert.equal(canOccupy(world, bench.x, bench.z, .45, bench.top + .02), true);
        assert.equal(supportHeight(bench.x, bench.z, surfaces, 3.02), 3); // No snap from underneath.
        let y = 3.02, velocity = 7, landed = false, clearedSeat = false;
        for (let i = 0; i < 100; i++) {
            if (y > bench.top) clearedSeat = true;
            const step = verticalStep(y, velocity, supportHeight(bench.x, bench.z, surfaces, y), 1 / 60);
            y = step.y; velocity = step.velocity;
            if (step.grounded) { landed = true; break; }
        }
        assert.ok(clearedSeat && landed);
        assert.equal(y, bench.top + .02);
        assert.equal(verticalStep(y, 0, bench.top, .05).y, y);
        const ground = supportHeight(bench.x + 5, bench.z, surfaces, y);
        assert.equal(ground, 3);
        assert.ok(verticalStep(y, 0, ground, .05).y < y); // Falls when walking off.
    }
});
