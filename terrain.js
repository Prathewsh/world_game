import * as THREE from 'three';

const TERRAIN_SEGMENTS = 64;
const ELEVATION_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const SATELLITE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile';

export class TerrainSystem {
    constructor(scene, centerLat, centerLng) {
        this.scene = scene;
        this.centerLat = centerLat;
        this.centerLng = centerLng;
        this.zoom = 14;
        this.metersPerDegreeLng = 111320 * Math.cos(centerLat * Math.PI / 180);
        this.metersPerDegreeLat = 110540;
        this.tiles = new Map();
        this.terrainGroup = new THREE.Group();
        this.centerElevation = 0;
        this.ready = false;
        scene.add(this.terrainGroup);
    }

    latLngToTile(lat, lng) {
        const n = Math.pow(2, this.zoom);
        const x = Math.floor((lng + 180) / 360 * n);
        const latRad = lat * Math.PI / 180;
        const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
        return { x, y };
    }

    tileToBounds(tx, ty) {
        const n = Math.pow(2, this.zoom);
        const west = tx / n * 360 - 180;
        const east = (tx + 1) / n * 360 - 180;
        const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI;
        const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / n))) * 180 / Math.PI;
        return { north, south, east, west };
    }

    latLngToScene(lat, lng) {
        return {
            x: (lng - this.centerLng) * this.metersPerDegreeLng,
            z: -(lat - this.centerLat) * this.metersPerDegreeLat
        };
    }

    async init() {
        const ct = this.latLngToTile(this.centerLat, this.centerLng);
        const hd = await this.fetchHeightData(ct.x, ct.y);
        if (hd) {
            const bounds = this.tileToBounds(ct.x, ct.y);
            const u = (this.centerLng - bounds.west) / (bounds.east - bounds.west);
            const v = (bounds.north - this.centerLat) / (bounds.north - bounds.south);
            const px = Math.min(Math.floor(u * (hd.width - 1)), hd.width - 1);
            const py = Math.min(Math.floor(v * (hd.height - 1)), hd.height - 1);
            this.centerElevation = hd.data[py * hd.width + px];

            const satTex = await this.loadSatelliteTexture(ct.x, ct.y);
            const mesh = this.createTerrainMesh(ct.x, ct.y, hd, satTex);
            this.terrainGroup.add(mesh);
            this.tiles.set(`${ct.x}_${ct.y}`, { state: 'loaded', mesh, heightData: hd, tx: ct.x, ty: ct.y });
        }
        this.ready = true;
    }

    async fetchHeightData(tx, ty) {
        try {
            const url = `${ELEVATION_URL}/${this.zoom}/${tx}/${ty}.png`;
            const response = await fetch(url);
            if (!response.ok) return null;
            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob);

            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0);
            const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
            const d = imageData.data;

            const heights = new Float32Array(bitmap.width * bitmap.height);
            for (let i = 0; i < heights.length; i++) {
                heights[i] = (d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256) - 32768;
            }

            return { width: bitmap.width, height: bitmap.height, data: heights };
        } catch (e) {
            console.warn('Elevation fetch failed:', tx, ty, e);
            return null;
        }
    }

    loadSatelliteTexture(tx, ty) {
        const urls = [
            `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${this.zoom}/${ty}/${tx}`,
            `https://tile.openstreetmap.org/${this.zoom}/${tx}/${ty}.png`
        ];
        return new Promise((resolve) => {
            const loader = new THREE.TextureLoader();
            loader.setCrossOrigin('anonymous');
            let tried = 0;
            const tryNext = () => {
                if (tried >= urls.length) { resolve(null); return; }
                loader.load(urls[tried++], (tex) => {
                    tex.colorSpace = THREE.SRGBColorSpace;
                    resolve(tex);
                }, undefined, tryNext);
            };
            tryNext();
        });
    }

    createTerrainMesh(tx, ty, heightData, satTexture) {
        const bounds = this.tileToBounds(tx, ty);
        const nw = this.latLngToScene(bounds.north, bounds.west);
        const se = this.latLngToScene(bounds.south, bounds.east);

        const w = Math.abs(se.x - nw.x);
        const d = Math.abs(se.z - nw.z);
        const seg = TERRAIN_SEGMENTS;

        const geometry = new THREE.PlaneGeometry(w, d, seg, seg);
        geometry.rotateX(-Math.PI / 2);

        const pos = geometry.attributes.position;

        for (let i = 0; i < pos.count; i++) {
            const col = i % (seg + 1);
            const row = Math.floor(i / (seg + 1));
            const u = col / seg;
            const v = row / seg;

            const px = Math.min(Math.floor(u * (heightData.width - 1)), heightData.width - 1);
            const py = Math.min(Math.floor(v * (heightData.height - 1)), heightData.height - 1);
            const elev = heightData.data[py * heightData.width + px] - this.centerElevation;

            pos.setY(i, elev);
        }

        geometry.computeVertexNormals();

        let material;
        if (satTexture) {
            material = new THREE.MeshPhongMaterial({
                map: satTexture,
                side: THREE.DoubleSide
            });
        } else {
            // Fallback: vertex colors
            const colors = new Float32Array(pos.count * 3);
            const color = new THREE.Color();
            for (let i = 0; i < pos.count; i++) {
                const elev = pos.getY(i);
                if (elev < 5) color.setHSL(0.32, 0.55, 0.30);
                else if (elev < 30) color.setHSL(0.28, 0.45, 0.34);
                else if (elev < 80) color.setHSL(0.18, 0.35, 0.42);
                else color.setHSL(0.08, 0.15, 0.55);
                colors[i * 3] = color.r;
                colors[i * 3 + 1] = color.g;
                colors[i * 3 + 2] = color.b;
            }
            geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            material = new THREE.MeshPhongMaterial({ vertexColors: true, side: THREE.DoubleSide });
        }

        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set((nw.x + se.x) / 2, 0, (nw.z + se.z) / 2);
        mesh.receiveShadow = true;
        return mesh;
    }

    update(playerX, playerZ) {
        if (!this.ready) return;

        const playerLat = this.centerLat - playerZ / this.metersPerDegreeLat;
        const playerLng = this.centerLng + playerX / this.metersPerDegreeLng;
        const ct = this.latLngToTile(playerLat, playerLng);

        const radius = 2;
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                const tx = ct.x + dx;
                const ty = ct.y + dy;
                const key = `${tx}_${ty}`;
                if (!this.tiles.has(key)) {
                    this.tiles.set(key, { state: 'loading', mesh: null, heightData: null });
                    this.loadTile(tx, ty, key);
                }
            }
        }

        for (const [key, tile] of this.tiles) {
            if (tile.tx === undefined) continue;
            if (Math.abs(tile.tx - ct.x) > 4 || Math.abs(tile.ty - ct.y) > 4) {
                if (tile.mesh) {
                    this.terrainGroup.remove(tile.mesh);
                    tile.mesh.geometry.dispose();
                    tile.mesh.material.dispose();
                    if (tile.mesh.material.map) tile.mesh.material.map.dispose();
                }
                this.tiles.delete(key);
            }
        }
    }

    async loadTile(tx, ty, key) {
        const [hd, satTex] = await Promise.all([
            this.fetchHeightData(tx, ty),
            this.loadSatelliteTexture(tx, ty)
        ]);
        const entry = this.tiles.get(key);
        if (!entry) return;

        if (hd) {
            const mesh = this.createTerrainMesh(tx, ty, hd, satTex);
            this.terrainGroup.add(mesh);
            entry.mesh = mesh;
            entry.heightData = hd;
            entry.tx = tx;
            entry.ty = ty;
            entry.state = 'loaded';
        } else {
            entry.state = 'error';
        }
    }

    getElevation(sceneX, sceneZ) {
        if (!this.ready) return 0;

        const lat = this.centerLat - sceneZ / this.metersPerDegreeLat;
        const lng = this.centerLng + sceneX / this.metersPerDegreeLng;
        const tile = this.latLngToTile(lat, lng);
        const key = `${tile.x}_${tile.y}`;
        const td = this.tiles.get(key);

        if (!td || !td.heightData) return 0;

        const bounds = this.tileToBounds(tile.x, tile.y);
        const u = Math.max(0, Math.min(1, (lng - bounds.west) / (bounds.east - bounds.west)));
        const v = Math.max(0, Math.min(1, (bounds.north - lat) / (bounds.north - bounds.south)));

        const w = td.heightData.width;
        const h = td.heightData.height;
        const fx = u * (w - 1);
        const fy = v * (h - 1);
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const dx = fx - ix;
        const dy = fy - iy;

        const d = td.heightData.data;
        const ix1 = Math.min(ix + 1, w - 1);
        const iy1 = Math.min(iy + 1, h - 1);

        const h00 = d[iy * w + ix];
        const h10 = d[iy * w + ix1];
        const h01 = d[iy1 * w + ix];
        const h11 = d[iy1 * w + ix1];

        return (h00 * (1 - dx) * (1 - dy) + h10 * dx * (1 - dy) +
                h01 * (1 - dx) * dy + h11 * dx * dy) - this.centerElevation;
    }
}
