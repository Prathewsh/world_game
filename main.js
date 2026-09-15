import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { ProceduralWorld } from './world.js';
import { WORLD_CONFIG, verticalStep } from './world-data.js';
import { initNetwork, broadcastState, updateRemotePlayers, checkPlayerCollision } from './network.js';

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

export const audioListener = new THREE.AudioListener();
camera.add(audioListener);

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

// Remote Player Management
export const animClips = {};
export let characterTemplate = null;

const loader = new FBXLoader();
loader.load('animations/Idle.fbx', function (fbx) {
    character = fbx;
    characterTemplate = fbx; // store for cloning
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
        animClips.idle = fbx.animations[0];
        animations.idle = mixer.clipAction(animClips.idle);
        currentAction = animations.idle;
        currentAction.play();
        activeAnimName = 'idle';
    }

    const animLoader = new FBXLoader();

    animLoader.load('animations/Idle.fbx', (anim) => {
        if (anim.animations.length > 0) {
            animClips.idle = anim.animations[0];
            animations.idle = mixer.clipAction(animClips.idle);
            if (!currentAction) {
                currentAction = animations.idle;
                currentAction.play();
                activeAnimName = 'idle';
            }
        }
    });

    animLoader.load('animations/Walking.fbx', (anim) => {
        animClips.walk = anim.animations[0];
        animations.walk = mixer.clipAction(animClips.walk);
    });

    animLoader.load('animations/Walking Backward.fbx', (anim) => {
        animClips.walkBack = anim.animations[0];
        animations.walkBack = mixer.clipAction(animClips.walkBack);
    });

    animLoader.load('animations/Running.fbx', (anim) => {
        animClips.run = anim.animations[0];
        animations.run = mixer.clipAction(animClips.run);
    });

    animLoader.load('animations/Jump.fbx', (anim) => {
        animClips.jump = anim.animations[0];
        animations.jump = mixer.clipAction(animClips.jump);
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

// Mouse Controls
let cameraPitch = 0.2;

renderer.domElement.addEventListener('click', () => {
    if (document.pointerLockElement !== renderer.domElement) {
        renderer.domElement.requestPointerLock();
    }
});

document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === renderer.domElement && character) {
        character.rotation.y -= e.movementX * 0.003;
        cameraPitch += e.movementY * 0.003; // inverted up/down look
        cameraPitch = Math.max(-0.5, Math.min(1.2, cameraPitch)); // clamp to avoid flipping
    }
});

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

        let rotateY = 0;
        if (keys.a || keys.ArrowLeft) rotateY = 1;
        if (keys.d || keys.ArrowRight) rotateY = -1;

        if (keys[' '] && !jumpHeld && !isJumping) {
            isJumping = true;
            verticalVelocity = 7;
            fadeToAction('jump', 0.1);
        }
        jumpHeld = keys[' '];

        const currentSpeed = isRunning ? speed * 2 : speed;
        character.rotation.y += rotateY * rotationSpeed * delta;
        
        const previous = character.position.clone();
        
        character.translateZ(moveZ * currentSpeed * delta);
        
        if (!terrain.canOccupy(character.position.x, character.position.z, character.position.y) || 
            checkPlayerCollision(character.position.x, character.position.z, 0.6)) {
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

        // Multiplayer logic
        if (!character.lastBroadcast || Date.now() - character.lastBroadcast > 50) {
            let animToBroadcast = 'idle';
            if (isJumping) animToBroadcast = 'jump';
            else if (isRunning) animToBroadcast = 'run';
            else if (movingForward) animToBroadcast = 'walk';
            else if (movingBackward) animToBroadcast = 'walkBack';
            
            broadcastState(character.position.x, character.position.y, character.position.z, character.rotation.y, animToBroadcast);
            character.lastBroadcast = Date.now();
        }
        updateRemotePlayers(delta);

        // Light follows player
        dirLight.position.set(character.position.x + 50, character.position.y + 100, character.position.z + 50);
        dirLight.target.position.copy(character.position);

        minimapTimer += delta;
        if (minimapTimer > 0.1) {
            minimapTimer = 0;
            terrain.updateMap(character.position.x, character.position.z, character.rotation.y);
        }

        // Camera - GTA style
        const cameraDistance = 2.5; // Zoomed in closer
        const pitchQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), cameraPitch);
        
        const cameraOffset = new THREE.Vector3(0, 0, -cameraDistance);
        cameraOffset.applyQuaternion(pitchQuat);
        cameraOffset.applyQuaternion(character.quaternion);
        
        const targetPos = character.position.clone();
        targetPos.y += 1.5;
        
        cameraOffset.add(targetPos);
        
        camera.position.lerp(cameraOffset, 0.2);
        
        // Prevent camera from clipping through the ground
        const cameraGround = terrain.getSupportHeight(camera.position.x, camera.position.z, camera.position.y);
        if (camera.position.y < cameraGround + 0.5) {
            camera.position.y = cameraGround + 0.5;
        }
        
        camera.lookAt(targetPos);
    }

    renderer.render(scene, camera);
}


animate();

// Name modal handling
const nameModal = document.getElementById('name-modal');
const nameInput = document.getElementById('player-name-input');
const joinBtn = document.getElementById('join-btn');
const playerNameDisplay = document.getElementById('player-name-display');

function handleJoin() {
    const rawName = nameInput.value.trim() || 'Player';
    const name = rawName.replace(/[^\w\s\-]/g, '').substring(0, 15).trim() || 'Player';
    playerNameDisplay.textContent = name;
    
    // Resume AudioContext on user gesture
    if (audioListener.context.state === 'suspended') {
        audioListener.context.resume();
    }
    
    nameModal.style.opacity = '0';
    nameModal.style.pointerEvents = 'none';
    setTimeout(() => {
        nameModal.style.display = 'none';
    }, 300);
    // Focus game window
    window.focus();
    
    // Request mic access and init networking
    navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        },
        video: false
    })
        .then(stream => {
            initNetwork(scene, name, stream, audioListener);
        })
        .catch(err => {
            console.warn("Microphone access denied or error:", err);
            // Fallback without voice chat
            initNetwork(scene, name, null, audioListener);
        });
}

// Ensure AudioContext is resumed on any user interaction
const resumeAudio = () => {
    if (audioListener && audioListener.context && audioListener.context.state === 'suspended') {
        audioListener.context.resume();
    }
};
window.addEventListener('click', resumeAudio);
window.addEventListener('keydown', resumeAudio);

if (joinBtn) {
    joinBtn.addEventListener('click', handleJoin);
}
if (nameInput) {
    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleJoin();
    });
}
