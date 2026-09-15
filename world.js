import * as THREE from 'three';
import { WORLD_CONFIG, generateWorld, elevation, canOccupy, streetSurfaces, walkableHeight, TERRAIN_SEGMENTS, BENCHES, supportHeight } from './world-data.js';

export class ProceduralWorld {
    constructor(scene) {
        this.data = generateWorld();
        this.scene = scene;
        this.batches = new Map();
        const ground = new THREE.PlaneGeometry(WORLD_CONFIG.size, WORLD_CONFIG.size, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
        ground.rotateX(-Math.PI / 2);
        const vertices = ground.attributes.position;
        const colors = [];
        for (let i = 0; i < vertices.count; i++) {
            const x = vertices.getX(i), z = vertices.getZ(i), y = this.getElevation(x, z);
            vertices.setY(i, y);
            const color = new THREE.Color(y < 2 ? '#c5b88d' : '#648653');
            color.multiplyScalar(.9 + .1 * Math.sin(x * .2) * Math.cos(z * .17));
            colors.push(color.r, color.g, color.b);
        }
        ground.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        ground.computeVertexNormals();
        const terrain = new THREE.Mesh(ground, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
        terrain.receiveShadow = true;
        scene.add(terrain);
        const water = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.MeshStandardMaterial({ color: '#458e9c', roughness: .25, metalness: .3 }));
        water.rotation.x = -Math.PI / 2;
        water.position.y = .2;
        scene.add(water);
        this.surfaces = streetSurfaces(this.data.roads);
        for (const surface of this.surfaces) {
            this.box(surface.kind, surface.kind === 'road' ? '#666c6b' : '#b9b7a5',
                surface.x, (surface.bottom + surface.top) / 2, surface.z,
                surface.width, surface.top - surface.bottom, surface.depth);
        }
        for (let z = -102; z <= 102; z += 10) {
            if (this.data.roads.every(r => Math.abs(z - r) > 6)) this.box('stripe', '#ddd8b6', 0, 3.09, z, .14, .02, 3);
        }
        const walls = ['#d6c6a8', '#a7b8aa', '#b7c0ca', '#c88f72', '#e4d9b9'];
        const roofs = ['#795448', '#5a656b', '#9a6650'];
        for (const b of this.data.buildings) {
            this.box(`wall${b.color}`, walls[b.color], b.x, 3 + b.height / 2, b.z, b.width, b.height, b.depth);
            this.box('foundation', '#8b8b7e', b.x, 3.2, b.z, b.width + .5, .4, b.depth + .5);
            const roof = new THREE.ConeGeometry(1, 1, 4);
            roof.rotateY(Math.PI / 4);
            const mesh = new THREE.Mesh(roof, new THREE.MeshStandardMaterial({ color: roofs[b.roof], roughness: .95 }));
            mesh.position.set(b.x, 3 + b.height + 1.5, b.z);
            mesh.scale.set((b.width + 2) / Math.SQRT2, 3, (b.depth + 2) / Math.SQRT2);
            mesh.castShadow = true;
            scene.add(mesh);
            for (const side of [-1, 1]) {
                const faceZ = b.z + side * (b.depth / 2 + .04);
                this.box('door', '#57463b', b.x, 4.25, faceZ, 1.3, 2.5, .12);
                for (let floor = 0; floor < Math.floor(b.height / 3); floor++) {
                    for (const offset of [-b.width / 3, b.width / 3]) {
                        this.box('frame', '#e8e0ca', b.x + offset, 5 + floor * 3, faceZ, 1.9, 1.8, .15);
                        this.box('glass', '#345764', b.x + offset, 5 + floor * 3, faceZ + side * .1, 1.5, 1.4, .08);
                    }
                }
            }
        }
        for (const t of this.data.trees) {
            const y = this.getElevation(t.x, t.z);
            this.instance('trunk', new THREE.CylinderGeometry(.22, .34, 1, 6), '#66513a', t.x, y + 2 * t.size, t.z, t.size, 4 * t.size, t.size);
            this.instance('canopy', new THREE.IcosahedronGeometry(1, 1), '#426b40', t.x, y + 5 * t.size, t.z, 2.4 * t.size, 3 * t.size, 2.4 * t.size);
        }
        // Benches mark the shared spawn plaza without blocking the spawn itself.
        for (const bench of BENCHES) {
            const { x } = bench;
            this.box('bench', '#865e40', x, bench.top - bench.thickness / 2, bench.z, bench.width, bench.thickness, bench.depth);
            for (const dx of [-1.5, 1.5]) this.box('legs', '#414d47', x + dx, 3.3, 12, .2, .6, 1);
        }
        for (const batch of this.batches.values()) {
            const mesh = new THREE.InstancedMesh(batch.geometry, new THREE.MeshStandardMaterial({ color: batch.color, roughness: .85 }), batch.transforms.length);
            batch.transforms.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            scene.add(mesh);
        }
        this.batches.clear();
        this.drawMap();
    }
    instance(key, geometry, color, x, y, z, sx, sy, sz) {
        if (!this.batches.has(key)) this.batches.set(key, { geometry, color, transforms: [] });
        else geometry.dispose();
        const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
        this.batches.get(key).transforms.push(matrix);
    }
    box(key, color, x, y, z, sx, sy, sz) { this.instance(key, new THREE.BoxGeometry(1, 1, 1), color, x, y, z, sx, sy, sz); }
    getElevation(x, z) { return elevation(x, z); }
    getWalkableHeight(x, z) { return walkableHeight(x, z, this.surfaces); }
    getSupportHeight(x, z, feetY) { return supportHeight(x, z, this.surfaces, feetY); }
    canOccupy(x, z, feetY) { return canOccupy(this.data, x, z, .45, feetY); }
    drawMap() {
        this.map = document.getElementById('minimap');
        const ctx = this.map.getContext('2d');
        this.map.width = this.map.height = 240;
        ctx.fillStyle = '#458e9c'; ctx.fillRect(0, 0, 240, 240);
        ctx.fillStyle = '#648653'; ctx.beginPath(); ctx.arc(120, 120, 103, 0, Math.PI * 2); ctx.fill();
        const scale = 240 / WORLD_CONFIG.size;
        ctx.strokeStyle = '#b9b7a5'; ctx.lineWidth = 2;
        for (const r of this.data.roads) {
            ctx.beginPath(); ctx.moveTo(120 + r * scale, 120 - 107 * scale); ctx.lineTo(120 + r * scale, 120 + 107 * scale); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(120 - 107 * scale, 120 + r * scale); ctx.lineTo(120 + 107 * scale, 120 + r * scale); ctx.stroke();
        }
        ctx.fillStyle = '#e4d9b9';
        for (const b of this.data.buildings) ctx.fillRect(120 + (b.x - b.width / 2) * scale, 120 + (b.z - b.depth / 2) * scale, b.width * scale, b.depth * scale);
        this.mapBackground = ctx.getImageData(0, 0, 240, 240);
        this.updateMap(0, 0, 0);
    }
    updateMap(x, z, heading) {
        const ctx = this.map.getContext('2d');
        ctx.putImageData(this.mapBackground, 0, 0);
        ctx.save(); ctx.translate(120 + x * .3, 120 + z * .3); ctx.rotate(-heading);
        ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#16362b'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, 7); ctx.lineTo(-5, -5); ctx.lineTo(5, -5); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
    }
}
