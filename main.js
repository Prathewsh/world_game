import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OSMCity } from './osm.js';
import { TerrainSystem } from './terrain.js';

const loaderEl = document.getElementById('loader');
const progressFillEl = document.getElementById('progress-bar-fill');
const loaderTextEl = document.getElementById('loader-text');
const loaderPercentEl = document.getElementById('loader-percentage');

function updateProgress(percent, message) {
    if (progressFillEl) progressFillEl.style.width = `${percent}%`;
    if (loaderTextEl) loaderTextEl.textContent = message;
    if (loaderPercentEl) loaderPercentEl.textContent = `${Math.round(percent)}%`;
    if (percent >= 100 && loaderEl) {
        setTimeout(() => {
            loaderEl.style.opacity = '0';
            setTimeout(() => { loaderEl.style.display = 'none'; }, 600);
        }, 500);
    }
}

THREE.DefaultLoadingManager.onLoad = function () {
    updateProgress(100, 'World Ready!');
};

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB);
scene.fog = new THREE.FogExp2(0x87CEEB, 0.002);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(0, 3, 5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// Lighting
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 2);
hemiLight.position.set(0, 20, 0);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 2);
dirLight.position.set(50, 100, 50);
dirLight.castShadow = true;
dirLight.shadow.camera.top = 50;
dirLight.shadow.camera.bottom = -50;
dirLight.shadow.camera.left = -50;
dirLight.shadow.camera.right = 50;
dirLight.shadow.camera.near = 0.1;
dirLight.shadow.camera.far = 300;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
scene.add(dirLight);
scene.add(dirLight.target);

// Center: Perinthalmanna, Malappuram, Kerala
const CENTER_LAT = 10.9764;
const CENTER_LNG = 76.2285;
const METERS_PER_DEG_LNG = 111320 * Math.cos(CENTER_LAT * Math.PI / 180);
const METERS_PER_DEG_LAT = 110540;

// Terrain
updateProgress(10, 'Loading Elevation Data...');
const terrain = new TerrainSystem(scene, CENTER_LAT, CENTER_LNG);
await terrain.init();
updateProgress(35, 'Terrain Heights Loaded');

// OSM City
updateProgress(40, 'Downloading Map Data...');
const osmCity = new OSMCity(scene, CENTER_LAT, CENTER_LNG, terrain);
const statusEl = document.getElementById('city-status');

osmCity.onProgress = (msg) => {
    if (typeof msg === 'string') {
        if (msg.includes('Downloading')) updateProgress(50, msg);
        else if (msg.includes('Ready')) updateProgress(85, msg);
        else updateProgress(70, msg);

        if (statusEl) {
            statusEl.textContent = msg;
            if (msg.includes('Ready')) setTimeout(() => { statusEl.style.opacity = '0'; }, 2000);
            else statusEl.style.opacity = '1';
        }
    }
};

await osmCity.init();

// Minimap (Leaflet)
const minimapEl = document.getElementById('minimap');
const map = L.map(minimapEl, {
    center: [CENTER_LAT, CENTER_LNG],
    zoom: 16,
    zoomControl: false,
    attributionControl: false
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19
}).addTo(map);

const playerIcon = L.divIcon({ className: 'player-icon', iconSize: [12, 12] });
const playerMarker = L.marker([CENTER_LAT, CENTER_LNG], { icon: playerIcon }).addTo(map);

// Teleport on map click
map.on('click', (e) => {
    if (!character) return;
    const { lat, lng } = e.latlng;
    const x = (lng - CENTER_LNG) * METERS_PER_DEG_LNG;
    const z = -(lat - CENTER_LAT) * METERS_PER_DEG_LAT;
    character.position.set(x, terrain.getElevation(x, z), z);

    // Immediately load chunks at new location
    osmCity.update(x, z);
    terrain.update(x, z);
    worldUpdateTimer = 0;

    if (statusEl) {
        statusEl.textContent = 'Teleporting...';
        statusEl.style.opacity = '1';
    }
});

// Character
let character;
let mixer;
const clock = new THREE.Clock();
const animations = {};
let currentAction;
let isJumping = false;
let activeAnimName = '';

const loader = new FBXLoader();
loader.load('animations/Idle.fbx', function (fbx) {
    character = fbx;
    character.scale.set(0.01, 0.01, 0.01);
    character.traverse(function (object) {
        if (object.isMesh) {
            object.castShadow = true;
            object.receiveShadow = true;
        }
    });
    scene.add(character);

    mixer = new THREE.AnimationMixer(character);

    if (fbx.animations.length > 0) {
        animations.idle = mixer.clipAction(fbx.animations[0]);
        currentAction = animations.idle;
        currentAction.play();
        activeAnimName = 'idle';
    }

    const animLoader = new FBXLoader();

    animLoader.load('animations/Idle.fbx', (anim) => {
        if (anim.animations.length > 0) {
            animations.idle = mixer.clipAction(anim.animations[0]);
            if (!currentAction) {
                currentAction = animations.idle;
                currentAction.play();
                activeAnimName = 'idle';
            }
        }
    });

    animLoader.load('animations/Walking.fbx', (anim) => {
        animations.walk = mixer.clipAction(anim.animations[0]);
    });

    animLoader.load('animations/Walking Backward.fbx', (anim) => {
        animations.walkBack = mixer.clipAction(anim.animations[0]);
    });

    animLoader.load('animations/Running.fbx', (anim) => {
        animations.run = mixer.clipAction(anim.animations[0]);
    });

    animLoader.load('animations/Jump.fbx', (anim) => {
        animations.jump = mixer.clipAction(anim.animations[0]);
        animations.jump.setLoop(THREE.LoopOnce, 1);
        animations.jump.clampWhenFinished = true;
    });

    mixer.addEventListener('finished', (e) => {
        if (e.action === animations.jump) isJumping = false;
    });

}, undefined, console.error);

// Controls
const keys = { w: false, a: false, s: false, d: false, ArrowUp: false, ArrowLeft: false, ArrowDown: false, ArrowRight: false, Shift: false, ' ': false };

window.addEventListener('keydown', (e) => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (keys.hasOwnProperty(key)) {
        keys[key] = true;
        e.preventDefault();
    }
});

window.addEventListener('keyup', (e) => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (keys.hasOwnProperty(key)) {
        keys[key] = false;
        e.preventDefault();
    }
});

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Game loop
const speed = 5;
const rotationSpeed = 3;
let worldUpdateTimer = 0;
let minimapTimer = 0;

function fadeToAction(name, duration) {
    if (activeAnimName === name) return;
    const nextAction = animations[name];
    if (nextAction) nextAction.reset().fadeIn(duration).play();
    if (currentAction) currentAction.fadeOut(duration);
    currentAction = nextAction;
    activeAnimName = name;
}

function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    if (mixer) mixer.update(delta);

    if (character) {
        let moveZ = 0;
        let movingForward = false;
        let movingBackward = false;
        let isRunning = false;

        if (keys.w || keys.ArrowUp) { moveZ = 1; movingForward = true; }
        if (keys.s || keys.ArrowDown) { moveZ = -1; movingBackward = true; }
        if (movingForward && keys.Shift) isRunning = true;

        if (keys[' '] && isRunning && !isJumping && animations.jump) {
            isJumping = true;
            fadeToAction('jump', 0.1);
        }

        let rotateY = 0;
        if (keys.a || keys.ArrowLeft) rotateY = 1;
        if (keys.d || keys.ArrowRight) rotateY = -1;

        const currentSpeed = isRunning ? speed * 2 : speed;
        character.rotation.y += rotateY * rotationSpeed * delta;
        character.translateZ(moveZ * currentSpeed * delta);

        // Terrain following
        const terrainY = terrain.getElevation(character.position.x, character.position.z);
        character.position.y = THREE.MathUtils.lerp(character.position.y, terrainY, 0.3);

        if (mixer && !isJumping) {
            if (isRunning) fadeToAction('run', 0.2);
            else if (movingForward) fadeToAction('walk', 0.2);
            else if (movingBackward) fadeToAction('walkBack', 0.2);
            else fadeToAction('idle', 0.2);
        }

        // Light follows player
        dirLight.position.set(character.position.x + 50, character.position.y + 100, character.position.z + 50);
        dirLight.target.position.copy(character.position);

        // World chunk updates (throttled)
        worldUpdateTimer += delta;
        if (worldUpdateTimer > 2) {
            worldUpdateTimer = 0;
            osmCity.update(character.position.x, character.position.z);
            terrain.update(character.position.x, character.position.z);
        }

        // Minimap update (throttled)
        minimapTimer += delta;
        if (minimapTimer > 0.5) {
            minimapTimer = 0;
            const pLat = CENTER_LAT - character.position.z / METERS_PER_DEG_LAT;
            const pLng = CENTER_LNG + character.position.x / METERS_PER_DEG_LNG;
            playerMarker.setLatLng([pLat, pLng]);
            map.panTo([pLat, pLng], { animate: false });
        }

        // Camera
        const cameraOffset = new THREE.Vector3(0, 2, -5);
        cameraOffset.applyQuaternion(character.quaternion);
        cameraOffset.add(character.position);
        camera.position.lerp(cameraOffset, 0.1);
        camera.lookAt(character.position.x, character.position.y + 1.5, character.position.z);
    }

    renderer.render(scene, camera);
}

// Initial world load
osmCity.update(0, 0);
terrain.update(0, 0);
updateProgress(100, 'World Ready!');
animate();
