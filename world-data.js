// Shared world contract: keep seed AND generator version identical on every client/server.
export const WORLD_CONFIG = Object.freeze({ seed: 731942, version: 1, size: 800, spawn: Object.freeze({ x: 0, z: 0 }) });

export function randomSequence(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let n = Math.imul(state ^ (state >>> 15), 1 | state);
        n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
        return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
    };
}
const smooth = t => t * t * (3 - 2 * t);
function hash(x, z, seed) {
    let n = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ seed;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function noise(x, z, seed) {
    const ix = Math.floor(x), iz = Math.floor(z), u = smooth(x - ix), v = smooth(z - iz);
    const a = hash(ix, iz, seed) * (1 - u) + hash(ix + 1, iz, seed) * u;
    const b = hash(ix, iz + 1, seed) * (1 - u) + hash(ix + 1, iz + 1, seed) * u;
    return a * (1 - v) + b * v;
}
export function elevation(x, z, seed = WORLD_CONFIG.seed) {
    const radius = Math.hypot(x, z);
    const coast = Math.max(0, Math.min(1, (radius - 300) / 75));
    const hills = smooth(Math.max(0, Math.min(1, (Math.max(Math.abs(x), Math.abs(z)) - 110) / 90)));
    return 3 + hills * (noise(x / 95, z / 95, seed) * 24 + noise(x / 35, z / 35, seed + 1) * 4) - smooth(coast) * 36;
}
export function generateWorld(config = WORLD_CONFIG) {
    const random = randomSequence(config.seed);
    const buildings = [], trees = [];
    const roads = [-96, -48, 0, 48, 96];
    for (let row = -2; row < 2; row++) {
        for (let col = -2; col < 2; col++) {
            // The central square stays open for a common spawn and meeting area.
            if ((row === -1 || row === 0) && (col === -1 || col === 0)) continue;
            for (let lot = 0; lot < 2; lot++) {
                buildings.push({ id: `building:${row}:${col}:${lot}`, x: col * 48 + 13 + lot * 22, z: row * 48 + 24,
                    width: 12 + random() * 4, depth: 17 + random() * 5, height: 5 + Math.floor(random() * 3) * 3,
                    color: Math.floor(random() * 5), roof: Math.floor(random() * 3) });
            }
        }
    }
    for (let i = 0; i < 1300; i++) {
        const x = (random() - .5) * 690, z = (random() - .5) * 690;
        if (Math.max(Math.abs(x), Math.abs(z)) < 125 || Math.hypot(x, z) > 325 || elevation(x, z, config.seed) < 2) continue;
        trees.push({ id: `tree:${i}`, x, z, size: 0.8 + random() * 1.3 });
    }
    return { config, roads, buildings, trees };
}
export function canOccupy(world, x, z, radius = .45, feetY = -Infinity) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.hypot(x, z) > 330 || elevation(x, z, world.config.seed) < 1) return false;
    if (BENCHES.some(b => overlapsBench(b, x, z, radius) && feetY < b.top - .025)) return false;
    if (world.buildings.some(b => Math.abs(x - b.x) < b.width / 2 + radius && Math.abs(z - b.z) < b.depth / 2 + radius)) return false;
    return !world.trees.some(t => Math.hypot(x - t.x, z - t.z) < .28 * t.size + radius);
}

// Walkable geometry shared by rendering and character grounding.
export const TERRAIN_SEGMENTS = 256;
export function streetSurfaces(roads) {
    const surfaces = [];
    for (const offset of roads) {
        surfaces.push({ kind: 'road', x: offset, z: 0, width: 7, depth: 215, bottom: 3, top: 3.08 });
        surfaces.push({ kind: 'road', x: 0, z: offset, width: 215, depth: 7, bottom: 3, top: 3.08 });
        for (const side of [-1, 1]) {
            surfaces.push({ kind: 'pavement', x: offset + side * 4.5, z: 0, width: 2, depth: 215, bottom: 3, top: 3.24 });
            surfaces.push({ kind: 'pavement', x: 0, z: offset + side * 4.5, width: 215, depth: 2, bottom: 3, top: 3.24 });
        }
    }
    return surfaces;
}

export function terrainSurfaceHeight(x, z, config = WORLD_CONFIG) {
    // Interpolate the rendered PlaneGeometry triangles, rather than the smooth
    // noise function between vertices, which can pass above or below the mesh.
    const step = config.size / TERRAIN_SEGMENTS, half = config.size / 2;
    const gx = Math.max(0, Math.min(TERRAIN_SEGMENTS - 1e-9, (x + half) / step));
    const gz = Math.max(0, Math.min(TERRAIN_SEGMENTS - 1e-9, (z + half) / step));
    const ix = Math.floor(gx), iz = Math.floor(gz), u = gx - ix, v = gz - iz;
    const at = (dx, dz) => Math.fround(elevation((ix + dx) * step - half, (iz + dz) * step - half, config.seed));
    return u + v <= 1 ? at(0, 0) * (1 - u - v) + at(1, 0) * u + at(0, 1) * v
        : at(1, 1) * (u + v - 1) + at(1, 0) * (1 - v) + at(0, 1) * (1 - u);
}

export function walkableHeight(x, z, surfaces, config = WORLD_CONFIG) {
    let height = terrainSurfaceHeight(x, z, config);
    for (const surface of surfaces) {
        // Include the small foot footprint when straddling a curb.
        if (Math.abs(x - surface.x) <= surface.width / 2 + .15 && Math.abs(z - surface.z) <= surface.depth / 2 + .15) {
            height = Math.max(height, surface.top);
        }
    }
    return height;
}


export const BENCHES = Object.freeze([-12, 12].map(x => Object.freeze({
    x, z: 12, width: 4, depth: 1.2, top: 3.775, thickness: .25,
})));
function overlapsBench(bench, x, z, radius = .45) {
    const dx = Math.max(0, Math.abs(x - bench.x) - bench.width / 2);
    const dz = Math.max(0, Math.abs(z - bench.z) - bench.depth / 2);
    return dx * dx + dz * dz <= radius * radius;
}
export function supportHeight(x, z, surfaces, feetY) {
    let height = walkableHeight(x, z, surfaces);
    for (const bench of BENCHES) {
        if (overlapsBench(bench, x, z) && feetY >= bench.top - .025) height = Math.max(height, bench.top);
    }
    return height;
}
export function verticalStep(y, velocity, support, dt) {
    const nextVelocity = velocity - 20 * dt;
    const nextY = y + nextVelocity * dt;
    
    if (nextVelocity <= 0) {
        if (nextY <= support + .02) {
            // Normal landing or staying on ground
            return { y: support + .02, velocity: 0, grounded: true };
        } else if (velocity === 0 && (y - support) < 0.4) {
            // Walking down a slope: snap to ground to prevent jitter/falling
            return { y: support + .02, velocity: 0, grounded: true };
        }
    }
    
    return { y: nextY, velocity: nextVelocity, grounded: false };
}
