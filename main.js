import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { ProceduralWorld } from './world.js';
import { WORLD_CONFIG, verticalStep } from './world-data.js';

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

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB);
scene.fog = new THREE.FogExp2(0x87CEEB, 0.0018);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(0, 3, 5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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

updateProgress(20, 'Generating shared world…');
const terrain = new ProceduralWorld(scene);
document.getElementById('world-id').textContent = `Seed ${WORLD_CONFIG.seed} · Generator v${WORLD_CONFIG.version}`;
updateProgress(70, 'Loading character…');

// Character
let character;
let mixer;
const clock = new THREE.Clock();
const animations = {};
let currentAction;
let isJumping = false;
let verticalVelocity = 0;
let jumpHeld = false;
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
    character.position.set(WORLD_CONFIG.spawn.x, terrain.getWalkableHeight(WORLD_CONFIG.spawn.x, WORLD_CONFIG.spawn.z) + 0.02, WORLD_CONFIG.spawn.z);
    updateProgress(100, 'Character ready');

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



}, undefined, () => {
    loaderTextEl.textContent = 'Character could not load. Check your connection and reload.';
});

// Controls
const keys = { w: false, a: false, s: false, d: false, ArrowUp: false, ArrowLeft: false, ArrowDown: false, ArrowRight: false, Shift: false, ' ': false };

window.addEventListener('keydown', (e) => {
    if (e.target.closest('select, input, button')) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (keys.hasOwnProperty(key)) {
        keys[key] = true;
        e.preventDefault();
    }
});

window.addEventListener('keyup', (e) => {
    if (e.target.closest('select, input, button')) return;
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

window.addEventListener('blur', () => { for (const key of Object.keys(keys)) keys[key] = false; });

// Game loop
const speed = 5;
const rotationSpeed = 3;
let minimapTimer = 0;

function fadeToAction(name, duration) {
    if (activeAnimName === name) return;
    const nextAction = animations[name];
    if (!nextAction) return;
    nextAction.reset().fadeIn(duration).play();
    if (currentAction) currentAction.fadeOut(duration);
    currentAction = nextAction;
    activeAnimName = name;
}

function animate() {
    requestAnimationFrame(animate);
    const delta = Math.min(clock.getDelta(), 0.05);
    if (mixer) mixer.update(delta);

    if (character) {
        let moveZ = 0;
        let movingForward = false;
        let movingBackward = false;
        let isRunning = false;

        if (keys.w || keys.ArrowUp) { moveZ = 1; movingForward = true; }
        if (keys.s || keys.ArrowDown) { moveZ = -1; movingBackward = true; }
        if (movingForward && keys.Shift) isRunning = true;

        if (keys[' '] && !jumpHeld && !isJumping) {
            isJumping = true;
            verticalVelocity = 7;
            fadeToAction('jump', 0.1);
        }
        jumpHeld = keys[' '];

        let rotateY = 0;
        if (keys.a || keys.ArrowLeft) rotateY = 1;
        if (keys.d || keys.ArrowRight) rotateY = -1;

        const currentSpeed = isRunning ? speed * 2 : speed;
        character.rotation.y += rotateY * rotationSpeed * delta;
        const previous = character.position.clone();
        character.translateZ(moveZ * currentSpeed * delta);
        if (!terrain.canOccupy(character.position.x, character.position.z, character.position.y)) {
            character.position.copy(previous);
        }

        const support = terrain.getSupportHeight(character.position.x, character.position.z, previous.y);
        const vertical = verticalStep(previous.y, verticalVelocity, support, delta);
        character.position.y = vertical.y;
        verticalVelocity = vertical.velocity;
        isJumping = !vertical.grounded;

        if (mixer && !isJumping) {
            if (isRunning) fadeToAction('run', 0.2);
            else if (movingForward) fadeToAction('walk', 0.2);
            else if (movingBackward) fadeToAction('walkBack', 0.2);
            else fadeToAction('idle', 0.2);
        }

        // Light follows player
        dirLight.position.set(character.position.x + 50, character.position.y + 100, character.position.z + 50);
        dirLight.target.position.copy(character.position);

        minimapTimer += delta;
        if (minimapTimer > 0.1) {
            minimapTimer = 0;
            terrain.updateMap(character.position.x, character.position.z, character.rotation.y);
            document.getElementById('world-location').textContent = `X ${character.position.x.toFixed(0)} · Z ${character.position.z.toFixed(0)}`;
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


animate();
