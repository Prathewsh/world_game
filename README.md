# Haven

A third-person procedural island with a town, woodland, hills, coastline, collision checks, and a local minimap.

Run a static server from this directory, for example `python3 -m http.server 8000`, and open `http://localhost:8000`. Three.js loads from its pinned CDN version; character animations are local. No map service, geographic dataset, API key, or satellite download is used.

## Stable world

`world-data.js` is the shared, renderer-independent world definition. Every client uses seed **731942** and generator version **1**. Terrain, object IDs, building dimensions, tree positions, collision boundaries, and the spawn are deterministic. There is no random seed on refresh and no browser storage dependency.

Treat the seed and generator version as part of a saved world's identity. Preserve this generator for existing worlds; increment the version when changing layout generation. A future server should provide the seed/version, reject incompatible clients, and use the same module for world generation and collision validation.

## Multiplayer status

This is currently local play. Identical map generation is implemented; networking, remote players, server-authoritative movement, and persistence of player-made world changes are not implemented. Shared edits need to be stored and synchronized by the server, independently of the base seed.

## Controls and checks

W/S move, A/D turn, Shift+W runs, and Space jumps, including from a standstill. Jump onto a bench to stand on its seat. The minimap follows your position. Buildings, tree trunks, benches, and the island boundary block movement. Bench seats support landing and standing; stepping off restores gravity.

Run `node --test tests/world.test.mjs` to verify separate-client determinism, valid terrain, stable object IDs, spawn clearance, and collision boundaries.
