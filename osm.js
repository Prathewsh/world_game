import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const CHUNK_SIZE = 400;
const LOAD_RADIUS = 2;
const UNLOAD_RADIUS = 4;
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

const ROAD_WIDTHS = {
    motorway: 12, trunk: 10, primary: 8, secondary: 7,
    tertiary: 6, residential: 5, unclassified: 5,
    service: 3, footway: 1.5, path: 1, cycleway: 2,
    track: 3, pedestrian: 4
};

export class OSMCity {
    constructor(scene, lat, lng, terrain) {
        this.scene = scene;
        this.centerLat = lat;
        this.centerLng = lng;
        this.terrain = terrain;
        this.metersPerDegreeLng = 111320 * Math.cos(lat * Math.PI / 180);
        this.metersPerDegreeLat = 110540;
        
        this.chunks = new Map();
        this.chunkData = new Map();
        this.requestQueue = [];
        this.isProcessingQueue = false;
        
        this.buildingGroup = new THREE.Group();
        this.roadGroup = new THREE.Group();
        scene.add(this.buildingGroup);
        scene.add(this.roadGroup);
        
        this.onProgress = null;
        this.ready = false;
    }

    latLngToScene(lat, lng) {
        return {
            x: (lng - this.centerLng) * this.metersPerDegreeLng,
            z: -(lat - this.centerLat) * this.metersPerDegreeLat
        };
    }

    sceneToLatLng(x, z) {
        return {
            lat: this.centerLat - z / this.metersPerDegreeLat,
            lng: this.centerLng + x / this.metersPerDegreeLng
        };
    }

    getChunkBBox(key) {
        const [cx, cz] = key.split('_').map(Number);
        const c1 = this.sceneToLatLng(cx * CHUNK_SIZE, cz * CHUNK_SIZE);
        const c2 = this.sceneToLatLng((cx + 1) * CHUNK_SIZE, (cz + 1) * CHUNK_SIZE);
        return {
            south: Math.min(c1.lat, c2.lat),
            west: Math.min(c1.lng, c2.lng),
            north: Math.max(c1.lat, c2.lat),
            east: Math.max(c1.lng, c2.lng)
        };
    }

    async init() {
        if (this.onProgress) this.onProgress('Downloading City Map (3km radius)...');
        
        const s = this.centerLat - 1000 / this.metersPerDegreeLat;
        const n = this.centerLat + 1000 / this.metersPerDegreeLat;
        const w = this.centerLng - 1000 / this.metersPerDegreeLng;
        const e = this.centerLng + 1000 / this.metersPerDegreeLng;
        
        const query = `[out:json][timeout:90];(way["building"](${s},${w},${n},${e});way["highway"](${s},${w},${n},${e}););out geom;`;
        const encodedQuery = encodeURIComponent(query);

        const getUrls = [
            `https://overpass.private.coffee/api/interpreter?data=${encodedQuery}`,
            `https://maps.mail.ru/osm/tools/overpass/api/interpreter?data=${encodedQuery}`,
            `https://overpass.nchc.org.tw/api/interpreter?data=${encodedQuery}`,
            `https://overpass.kumi.systems/api/interpreter?data=${encodedQuery}`,
            `https://corsproxy.io/?${encodeURIComponent(`https://overpass-api.de/api/interpreter?data=${query}`)}`,
            `https://overpass-api.de/api/interpreter?data=${encodedQuery}`
        ];

        let data = null;

        for (const url of getUrls) {
            try {
                const response = await fetch(url);
                if (response.ok) {
                    data = await response.json();
                    if (data && data.elements) break;
                }
            } catch (err) {
                console.warn(`GET Endpoint failed: ${url}`, err);
            }
        }

        if (!data || !data.elements) {
            const postUrls = [
                'https://overpass.private.coffee/api/interpreter',
                'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
                'https://overpass-api.de/api/interpreter'
            ];
            for (const url of postUrls) {
                try {
                    const response = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: `data=${encodedQuery}`
                    });
                    if (response.ok) {
                        data = await response.json();
                        if (data && data.elements) break;
                    }
                } catch (err) {
                    console.warn(`POST Endpoint failed: ${url}`, err);
                }
            }
        }

        if (!data || !data.elements) {
            console.warn('All Overpass API servers unreachable. Loading fallback city layout...');
            data = this.generateFallbackData(s, w, n, e);
        }

        this.chunkData = new Map();
        for (const el of data.elements) {
            if (!el.geometry || el.geometry.length === 0) continue;
            let lat = 0, lon = 0;
            for (const pt of el.geometry) {
                lat += pt.lat;
                lon += pt.lon;
            }
            lat /= el.geometry.length;
            lon /= el.geometry.length;
            
            const scenePt = this.latLngToScene(lat, lon);
            const cx = Math.floor(scenePt.x / CHUNK_SIZE);
            const cz = Math.floor(scenePt.z / CHUNK_SIZE);
            const key = `${cx}_${cz}`;
            
            if (!this.chunkData.has(key)) this.chunkData.set(key, { buildings: [], roads: [] });
            if (el.tags && el.tags.building) this.chunkData.get(key).buildings.push(el);
            if (el.tags && el.tags.highway) this.chunkData.get(key).roads.push(el);
        }
        this.ready = true;
        if (this.onProgress) this.onProgress('City Map Ready!');
    }

    generateFallbackData(s, w, n, e) {
        const elements = [];
        const latStep = (n - s) / 10;
        const lngStep = (e - w) / 10;

        for (let i = 1; i < 10; i++) {
            elements.push({
                tags: { highway: 'primary' },
                geometry: [
                    { lat: s + i * latStep, lon: w },
                    { lat: s + i * latStep, lon: e }
                ]
            });
            elements.push({
                tags: { highway: 'secondary' },
                geometry: [
                    { lat: s, lon: w + i * lngStep },
                    { lat: n, lon: w + i * lngStep }
                ]
            });
        }

        for (let r = 0; r < 9; r++) {
            for (let c = 0; c < 9; c++) {
                const bLat = s + (r + 0.3) * latStep;
                const bLng = w + (c + 0.3) * lngStep;
                const hSizeLat = latStep * 0.4;
                const hSizeLng = lngStep * 0.4;

                elements.push({
                    tags: { building: 'yes', 'building:levels': Math.floor(2 + Math.random() * 4) },
                    geometry: [
                        { lat: bLat, lon: bLng },
                        { lat: bLat + hSizeLat, lon: bLng },
                        { lat: bLat + hSizeLat, lon: bLng + hSizeLng },
                        { lat: bLat, lon: bLng + hSizeLng },
                        { lat: bLat, lon: bLng }
                    ]
                });
            }
        }
        return { elements };
    }

    update(playerX, playerZ) {
        if (!this.ready) return;

        const pcx = Math.floor(playerX / CHUNK_SIZE);
        const pcz = Math.floor(playerZ / CHUNK_SIZE);

        const toLoad = [];
        for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
            for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
                const key = `${pcx + dx}_${pcz + dz}`;
                if (!this.chunks.has(key)) {
                    this.chunks.set(key, { buildings: null, roads: null, state: 'queued' });
                    toLoad.push({ key, dist: Math.abs(dx) + Math.abs(dz) });
                }
            }
        }
        
        toLoad.sort((a, b) => a.dist - b.dist);
        toLoad.forEach(t => this.requestQueue.push(t.key));

        for (const [key, chunk] of this.chunks) {
            const [cx, cz] = key.split('_').map(Number);
            if (Math.abs(cx - pcx) > UNLOAD_RADIUS || Math.abs(cz - pcz) > UNLOAD_RADIUS) {
                const removeMesh = (mesh, group) => {
                    if (!mesh) return;
                    group.remove(mesh);
                    mesh.geometry?.dispose();
                    mesh.material?.dispose();
                };
                removeMesh(chunk.buildingsWall, this.buildingGroup);
                removeMesh(chunk.buildingsRoof, this.buildingGroup);
                removeMesh(chunk.roads, this.roadGroup);
                removeMesh(chunk.props, this.buildingGroup);
                this.chunks.delete(key);
            }
        }

        this.processQueue();
    }

    async processQueue() {
        if (this.isProcessingQueue || this.requestQueue.length === 0) return;
        this.isProcessingQueue = true;

        while (this.requestQueue.length > 0) {
            const batch = [];
            for (let i = 0; i < 2 && this.requestQueue.length > 0; i++) {
                const key = this.requestQueue.shift();
                const chunk = this.chunks.get(key);
                if (chunk && chunk.state === 'queued') {
                    chunk.state = 'loading';
                    batch.push(this.loadChunk(key).then(() => {
                        chunk.state = 'loaded';
                    }).catch(e => {
                        console.warn('Chunk failed:', key, e);
                        chunk.state = 'error';
                    }));
                }
            }

            if (batch.length > 0) {
                await Promise.all(batch);
            }

            if (this.onProgress) {
                const total = this.chunks.size;
                const loaded = [...this.chunks.values()].filter(c => c.state === 'loaded').length;
                this.onProgress(`Building City... ${loaded}/${total} chunks`);
            }
        }

        this.isProcessingQueue = false;
    }

    async loadChunk(key) {
        const data = this.chunkData.get(key) || { buildings: [], roads: [] };
        const [cx, cz] = key.split('_').map(Number);
        const bbox = this.getChunkBBox(key);

        const imgUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${bbox.west},${bbox.south},${bbox.east},${bbox.north}&bboxSR=4326&imageSR=4326&size=1024,1024&format=jpg&f=image`;
        
        const satTexture = await new Promise((resolve) => {
            new THREE.TextureLoader().setCrossOrigin('anonymous').load(imgUrl, resolve, undefined, () => resolve(null));
        });
        if (satTexture) satTexture.colorSpace = THREE.SRGBColorSpace;

        const chunk = this.chunks.get(key);
        if (!chunk) return;

        this.createBuildingsMesh(data.buildings, satTexture, cx * CHUNK_SIZE, cz * CHUNK_SIZE, chunk);
        
        const roadMesh = this.createRoadsMesh(data.roads);
        if (roadMesh) {
            this.roadGroup.add(roadMesh);
            chunk.roads = roadMesh;
        }

        const propsMesh = this.createPropsMesh(data.roads);
        if (propsMesh) {
            this.buildingGroup.add(propsMesh);
            chunk.props = propsMesh;
        }
    }

    getFacadeTextures() {
        if (this.facadeTextures) return this.facadeTextures;
        
        const createTex = (drawFn) => {
            const canvas = document.createElement('canvas');
            canvas.width = 512; canvas.height = 512;
            const ctx = canvas.getContext('2d');
            drawFn(ctx);
            const tex = new THREE.CanvasTexture(canvas);
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.colorSpace = THREE.SRGBColorSpace;
            return tex;
        };

        const commercial = createTex(ctx => {
            ctx.fillStyle = '#e2d8c9'; ctx.fillRect(0, 0, 512, 512);
            ctx.fillStyle = '#1e293b'; ctx.fillRect(0, 360, 512, 152);
            ctx.fillStyle = '#38bdf8';
            ctx.fillRect(15, 380, 145, 110);
            ctx.fillRect(185, 380, 145, 110);
            ctx.fillRect(355, 380, 145, 110);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
            ctx.beginPath(); ctx.moveTo(15, 380); ctx.lineTo(90, 380); ctx.lineTo(15, 460); ctx.fill();
            ctx.beginPath(); ctx.moveTo(185, 380); ctx.lineTo(260, 380); ctx.lineTo(185, 460); ctx.fill();
            ctx.beginPath(); ctx.moveTo(355, 380); ctx.lineTo(430, 380); ctx.lineTo(355, 460); ctx.fill();
            ctx.fillStyle = '#ef4444'; ctx.fillRect(15, 365, 145, 12);
            ctx.fillStyle = '#3b82f6'; ctx.fillRect(185, 365, 145, 12);
            ctx.fillStyle = '#10b981'; ctx.fillRect(355, 365, 145, 12);
            for (let r = 0; r < 3; r++) {
                const y = 30 + r * 105;
                for (let c = 0; c < 4; c++) {
                    const x = 25 + c * 120;
                    ctx.fillStyle = '#475569'; ctx.fillRect(x, y, 70, 75);
                    ctx.fillStyle = '#0f172a'; ctx.fillRect(x + 4, y + 4, 62, 67);
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)'; ctx.fillRect(x + 6, y + 6, 25, 30);
                    ctx.fillStyle = '#94a3b8'; ctx.fillRect(x - 4, y + 75, 78, 7);
                }
            }
        });

        const residential = createTex(ctx => {
            ctx.fillStyle = '#f3f4f6'; ctx.fillRect(0, 0, 512, 512);
            ctx.fillStyle = '#9ca3af'; ctx.fillRect(0, 128, 512, 8); ctx.fillRect(0, 256, 512, 8); ctx.fillRect(0, 384, 512, 8);
            for (let r = 0; r < 4; r++) {
                const y = 20 + r * 120;
                for (let c = 0; c < 4; c++) {
                    const x = 30 + c * 120;
                    ctx.fillStyle = '#1f2937'; ctx.fillRect(x, y, 65, 75);
                    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.strokeRect(x, y, 65, 75);
                    ctx.fillStyle = '#374151'; ctx.fillRect(x - 8, y + 50, 81, 25);
                }
            }
        });

        const office = createTex(ctx => {
            ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, 512, 512);
            for (let r = 0; r < 8; r++) {
                for (let c = 0; c < 8; c++) {
                    const x = c * 64, y = r * 64;
                    ctx.fillStyle = (r + c) % 2 === 0 ? '#0284c7' : '#0369a1';
                    ctx.fillRect(x + 2, y + 2, 60, 60);
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
                    ctx.beginPath(); ctx.moveTo(x + 2, y + 2); ctx.lineTo(x + 35, y + 2); ctx.lineTo(x + 2, y + 35); ctx.fill();
                }
            }
            ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2;
            for (let i = 0; i <= 8; i++) {
                ctx.beginPath(); ctx.moveTo(i * 64, 0); ctx.lineTo(i * 64, 512); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(0, i * 64); ctx.lineTo(512, i * 64); ctx.stroke();
            }
        });

        this.facadeTextures = [commercial, residential, office];
        return this.facadeTextures;
    }

    createBuildingsMesh(elements, satTexture, chunkStartX, chunkStartZ, chunk) {
        if (elements.length === 0) return;

        const facadeTexs = this.getFacadeTextures();
        const wallGeometries = [];
        const roofGeometries = [];

        for (const el of elements) {
            if (!el.geometry || el.geometry.length < 4) continue;

            let height = 7 + Math.random() * 8;
            if (el.tags) {
                if (el.tags.height) height = parseFloat(el.tags.height) || height;
                else if (el.tags['building:levels']) height = (parseInt(el.tags['building:levels']) || 2) * 3.2;
            }

            try {
                const pts = el.geometry.map(p => this.latLngToScene(p.lat, p.lon));
                let cx = 0, cz = 0;
                pts.forEach(p => { cx += p.x; cz += p.z; });
                cx /= pts.length; cz /= pts.length;
                const baseY = this.terrain ? this.terrain.getElevation(cx, cz) : 0;
                const topY = baseY + height;

                // --- 1. WALL GEOMETRY (Quads along contour) ---
                const wallPositions = [];
                const wallNormals = [];
                const wallUVs = [];
                const wallIndices = [];
                let vi = 0;
                let accumulatedDist = 0;

                for (let i = 0; i < pts.length - 1; i++) {
                    const p1 = pts[i];
                    const p2 = pts[i + 1];
                    const dx = p2.x - p1.x;
                    const dz = p2.z - p1.z;
                    const len = Math.sqrt(dx * dx + dz * dz);
                    if (len < 0.1) continue;

                    const nx = dz / len;
                    const nz = -dx / len;
                    const u1 = accumulatedDist / 10.0;
                    accumulatedDist += len;
                    const u2 = accumulatedDist / 10.0;
                    const v1 = 0;
                    const v2 = height / 3.2;

                    wallPositions.push(
                        p1.x, baseY, p1.z,
                        p2.x, baseY, p2.z,
                        p2.x, topY, p2.z,
                        p1.x, topY, p1.z
                    );

                    for (let n = 0; n < 4; n++) wallNormals.push(nx, 0, nz);
                    wallUVs.push(u1, v1, u2, v1, u2, v2, u1, v2);
                    wallIndices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
                    vi += 4;
                }

                if (wallPositions.length > 0) {
                    const wallGeo = new THREE.BufferGeometry();
                    wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(wallPositions, 3));
                    wallGeo.setAttribute('normal', new THREE.Float32BufferAttribute(wallNormals, 3));
                    wallGeo.setAttribute('uv', new THREE.Float32BufferAttribute(wallUVs, 2));
                    wallGeo.setIndex(wallIndices);
                    wallGeometries.push(wallGeo);
                }

                // --- 2. ROOF GEOMETRY ---
                const shapePts = pts.map(p => new THREE.Vector2(p.x, -p.z));
                const triangles = THREE.ShapeUtils.triangulateShape(shapePts, []);

                const roofPositions = [];
                const roofNormals = [];
                const roofUVs = [];

                for (const tri of triangles) {
                    for (let k = 0; k < 3; k++) {
                        const idx = tri[k];
                        const pt = pts[idx];
                        roofPositions.push(pt.x, topY, pt.z);
                        roofNormals.push(0, 1, 0);
                        const u = (pt.x - chunkStartX) / CHUNK_SIZE;
                        const v = 1.0 - (pt.z - chunkStartZ) / CHUNK_SIZE;
                        roofUVs.push(u, v);
                    }
                }

                if (roofPositions.length > 0) {
                    const roofGeo = new THREE.BufferGeometry();
                    roofGeo.setAttribute('position', new THREE.Float32BufferAttribute(roofPositions, 3));
                    roofGeo.setAttribute('normal', new THREE.Float32BufferAttribute(roofNormals, 3));
                    roofGeo.setAttribute('uv', new THREE.Float32BufferAttribute(roofUVs, 2));
                    roofGeometries.push(roofGeo);
                }
            } catch (e) { /* skip invalid geometry */ }
        }

        if (wallGeometries.length > 0) {
            const mergedWall = mergeGeometries(wallGeometries);
            const texIdx = Math.floor(Math.abs(chunkStartX + chunkStartZ) % facadeTexs.length);
            const wallMat = new THREE.MeshPhongMaterial({
                map: facadeTexs[texIdx],
                bumpScale: 0.05
            });
            const wallMesh = new THREE.Mesh(mergedWall, wallMat);
            wallMesh.castShadow = true;
            wallMesh.receiveShadow = true;
            this.buildingGroup.add(wallMesh);
            chunk.buildingsWall = wallMesh;
            wallGeometries.forEach(g => g.dispose());
        }

        if (roofGeometries.length > 0) {
            const mergedRoof = mergeGeometries(roofGeometries);
            const roofMat = new THREE.MeshPhongMaterial({
                map: satTexture,
                color: satTexture ? 0xffffff : 0x888888
            });
            const roofMesh = new THREE.Mesh(mergedRoof, roofMat);
            roofMesh.castShadow = true;
            roofMesh.receiveShadow = true;
            this.buildingGroup.add(roofMesh);
            chunk.buildingsRoof = roofMesh;
            roofGeometries.forEach(g => g.dispose());
        }
    }

    createRoadsMesh(elements) {
        if (elements.length === 0) return null;
        
        const positions = [];
        const indices = [];
        let vi = 0;

        for (const el of elements) {
            if (!el.geometry || el.geometry.length < 2) continue;

            const type = el.tags.highway;
            const halfWidth = (ROAD_WIDTHS[type] || 4) / 2;
            const pts = el.geometry.map(p => this.latLngToScene(p.lat, p.lon));

            for (let i = 0; i < pts.length - 1; i++) {
                const dx = pts[i + 1].x - pts[i].x;
                const dz = pts[i + 1].z - pts[i].z;
                const len = Math.sqrt(dx * dx + dz * dz);
                if (len < 0.01) continue;

                const nx = (-dz / len) * halfWidth;
                const nz = (dx / len) * halfWidth;

                const y1 = this.terrain ? this.terrain.getElevation(pts[i].x, pts[i].z) + 0.08 : 0.04;
                const y2 = this.terrain ? this.terrain.getElevation(pts[i + 1].x, pts[i + 1].z) + 0.08 : 0.04;

                positions.push(
                    pts[i].x + nx, y1, pts[i].z + nz,
                    pts[i].x - nx, y1, pts[i].z - nz,
                    pts[i + 1].x + nx, y2, pts[i + 1].z + nz,
                    pts[i + 1].x - nx, y2, pts[i + 1].z - nz
                );

                indices.push(vi, vi + 1, vi + 2, vi + 1, vi + 3, vi + 2);
                vi += 4;
            }
        }

        if (positions.length === 0) return null;

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.setIndex(indices);
        geo.computeVertexNormals();

        return new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
            color: 0x1f2937,
            side: THREE.DoubleSide
        }));
    }

    createPropsMesh(elements) {
        if (elements.length === 0) return null;

        const treeGeometries = [];
        const trunkGeo = new THREE.CylinderGeometry(0.2, 0.3, 3, 6);
        const foliageGeo = new THREE.ConeGeometry(1.8, 4, 6);
        foliageGeo.translate(0, 3.5, 0);

        for (const el of elements) {
            if (!el.geometry || el.geometry.length < 2) continue;
            const pts = el.geometry.map(p => this.latLngToScene(p.lat, p.lon));

            for (let i = 0; i < pts.length - 1; i += 3) {
                const p = pts[i];
                const y = this.terrain ? this.terrain.getElevation(p.x, p.z) : 0;
                
                const tG = trunkGeo.clone();
                tG.translate(p.x + 5, y + 1.5, p.z + 5);
                treeGeometries.push(tG);

                const fG = foliageGeo.clone();
                fG.translate(p.x + 5, y, p.z + 5);
                treeGeometries.push(fG);
            }
        }

        if (treeGeometries.length === 0) return null;
        const merged = mergeGeometries(treeGeometries);
        const mesh = new THREE.Mesh(merged, new THREE.MeshPhongMaterial({
            color: 0x15803d,
            flatShading: true
        }));
        treeGeometries.forEach(g => g.dispose());
        return mesh;
    }

    clear() {
        this.chunks.clear();
        this.chunkData.clear();
    }
}
