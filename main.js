import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { ProceduralWorld } from './world.js';
import { WORLD_CONFIG, verticalStep } from './world-data.js';
import { initNetwork, broadcastState, updateRemotePlayers, checkPlayerCollision, toggleMic } from './network.js';

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
loader.load('animations/male_character/Idle.fbx', function (fbx) {
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
    let spawnX, spawnZ, spawnY;
    do {
        spawnX = (Math.random() - 0.5) * 80;
        spawnZ = (Math.random() - 0.5) * 80;
        spawnY = terrain.getWalkableHeight(spawnX, spawnZ);
    } while (!terrain.canOccupy(spawnX, spawnZ, spawnY) || spawnY < 2.0); // Ensure we're not in water or inside an object
    
    character.position.set(spawnX, spawnY + 0.02, spawnZ);
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

    animLoader.load('animations/male_character/Idle.fbx', (anim) => {
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

    animLoader.load('animations/male_character/Walking.fbx', (anim) => {
        animClips.walk = anim.animations[0];
        animations.walk = mixer.clipAction(animClips.walk);
    });

    animLoader.load('animations/male_character/Walking Backward.fbx', (anim) => {
        animClips.walkBack = anim.animations[0];
        animations.walkBack = mixer.clipAction(animClips.walkBack);
    });

    animLoader.load('animations/male_character/Running.fbx', (anim) => {
        animClips.run = anim.animations[0];
        animations.run = mixer.clipAction(animClips.run);
    });

    animLoader.load('animations/male_character/Jump.fbx', (anim) => {
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

// Vehicle Data
export const spawnedVehicles = [];
export let currentVehicle = null;

const gltfLoader = new GLTFLoader();
const vehicleConfigs = {
    'ambulance.glb': { speed: 12, turnSpeed: 1.5, accel: 15, brake: 25 },
    'cop_car.glb': { speed: 16, turnSpeed: 2.0, accel: 20, brake: 30 },
    'green_car.glb': { speed: 14, turnSpeed: 1.8, accel: 18, brake: 28 },
    'red_car.glb': { speed: 15, turnSpeed: 1.9, accel: 19, brake: 29 }
};

document.querySelectorAll('.vehicle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (!character) return;
        const modelName = btn.dataset.model;
        const modal = document.getElementById('vehicle-modal');
        modal.style.opacity = '0';
        setTimeout(() => modal.style.display = 'none', 300);
        renderer.domElement.requestPointerLock();
        
        gltfLoader.load(`models/vehicles/${modelName}`, (gltf) => {
            const vehicleGroup = new THREE.Group();
            const vehicle = gltf.scene;
            
            // Adjust local rotation so the model faces the correct direction (forward along Z)
            vehicle.rotation.y = -Math.PI / 2;
            
            // Scale up the vehicles to match character proportions better
            vehicle.scale.set(2, 2, 2);
            vehicle.traverse((child) => {
                if (child.isMesh) {
                    if (child.name.toLowerCase().includes('collider')) {
                        child.visible = false;
                        return;
                    }
                    child.castShadow = true;
                    child.receiveShadow = true;
                    const mats = Array.isArray(child.material) ? child.material : [child.material];
                    mats.forEach(mat => {
                        if (mat.name && mat.name.toLowerCase().includes('collider')) {
                            child.visible = false;
                            return;
                        }
                        mat.transparent = false;
                        mat.depthWrite = true;
                        mat.depthTest = true;
                        mat.needsUpdate = true;
                    });
                }
            });
            
            vehicleGroup.add(vehicle);
            vehicleGroup.position.copy(character.position);
            
            // Move it 4 units forward in whatever direction the character is facing
            const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(character.quaternion);
            vehicleGroup.position.addScaledVector(forward, 4);
            
            // Ground the vehicle immediately so it doesn't float when not driven
            const spawnY = terrain.getSupportHeight(vehicleGroup.position.x, vehicleGroup.position.z, character.position.y);
            vehicleGroup.position.y = spawnY;
            
            scene.add(vehicleGroup);
            spawnedVehicles.push({
                mesh: vehicleGroup,
                velocity: 0,
                config: vehicleConfigs[modelName] || vehicleConfigs['green_car.glb'],
                modelName: modelName
            });
        });
    });
});

document.getElementById('close-vehicle-btn').addEventListener('click', () => {
    const modal = document.getElementById('vehicle-modal');
    modal.style.opacity = '0';
    setTimeout(() => modal.style.display = 'none', 300);
    renderer.domElement.requestPointerLock();
});

window.addEventListener('keydown', (e) => {
    if (e.target.closest('select, input, button')) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (keys.hasOwnProperty(key)) {
        keys[key] = true;
        e.preventDefault();
    }
    
    if (key === 'v') {
        const modal = document.getElementById('vehicle-modal');
        if (modal.style.display === 'none' || !modal.style.display) {
            modal.style.display = 'flex';
            setTimeout(() => modal.style.opacity = '1', 10);
            document.exitPointerLock();
        } else {
            modal.style.opacity = '0';
            setTimeout(() => modal.style.display = 'none', 300);
            renderer.domElement.requestPointerLock();
        }
    }
    
    if (key === 'e') {
        if (currentVehicle) {
            const right = new THREE.Vector3(1, 0, 0).applyQuaternion(currentVehicle.mesh.quaternion);
            character.position.copy(currentVehicle.mesh.position).addScaledVector(right, 4);
            character.position.y = terrain.getWalkableHeight(character.position.x, character.position.z) + 0.02;
            character.visible = true;
            currentVehicle = null;
        } else if (character) {
            let closest = null;
            let minDist = Infinity;
            spawnedVehicles.forEach(v => {
                const dist = v.mesh.position.distanceTo(character.position);
                if (dist < 4 && dist < minDist) {
                    minDist = dist;
                    closest = v;
                }
            });
            if (closest) {
                currentVehicle = closest;
                character.visible = false;
                // Move character to vehicle to keep map/sync somewhat close
                character.position.copy(closest.mesh.position);
            }
        }
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
        let movingForward = false;
        let movingBackward = false;
        let isRunning = false;
        
        if (currentVehicle) {
            const vData = currentVehicle;
            const conf = vData.config;
            let accel = 0;
            if (keys.w || keys.ArrowUp) accel = conf.accel;
            if (keys.s || keys.ArrowDown) accel = -conf.brake;
            
            if (accel === 0) {
                if (vData.velocity > 0) vData.velocity = Math.max(0, vData.velocity - conf.brake * delta);
                if (vData.velocity < 0) vData.velocity = Math.min(0, vData.velocity + conf.brake * delta);
            }
            
            vData.velocity += accel * delta;
            vData.velocity = Math.max(-conf.speed * 0.5, Math.min(conf.speed, vData.velocity));
            
            if (Math.abs(vData.velocity) > 0.1) {
                let turn = 0;
                if (keys.a || keys.ArrowLeft) turn = 1;
                if (keys.d || keys.ArrowRight) turn = -1;
                const turnFactor = (vData.velocity > 0 ? 1 : -1) * (Math.abs(vData.velocity) / conf.speed);
                vData.mesh.rotation.y += turn * conf.turnSpeed * turnFactor * delta;
            }
            
            const prevPos = vData.mesh.position.clone();
            vData.mesh.translateZ(vData.velocity * delta);
            
            if (!terrain.canOccupy(vData.mesh.position.x, vData.mesh.position.z, vData.mesh.position.y)) {
                vData.mesh.position.copy(prevPos);
                vData.velocity = 0;
            }
            
            vData.mesh.position.y = terrain.getSupportHeight(vData.mesh.position.x, vData.mesh.position.z, vData.mesh.position.y);
            
            character.position.copy(vData.mesh.position);
            character.rotation.y = vData.mesh.rotation.y;
            
            dirLight.position.set(vData.mesh.position.x + 50, vData.mesh.position.y + 100, vData.mesh.position.z + 50);
            dirLight.target.position.copy(vData.mesh.position);
            
            minimapTimer += delta;
            if (minimapTimer > 0.1) {
                minimapTimer = 0;
                terrain.updateMap(vData.mesh.position.x, vData.mesh.position.z, vData.mesh.rotation.y);
            }
            
            const cameraDistance = 5.0;
            const pitchQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), cameraPitch);
            
            const cameraOffset = new THREE.Vector3(0, 0, -cameraDistance);
            cameraOffset.applyQuaternion(pitchQuat);
            cameraOffset.applyQuaternion(vData.mesh.quaternion);
            
            const targetPos = vData.mesh.position.clone();
            targetPos.y += 1.5;
            
            cameraOffset.add(targetPos);
            camera.position.lerp(cameraOffset, 0.2);
            
            const cameraGround = terrain.getSupportHeight(camera.position.x, camera.position.z, camera.position.y);
            if (camera.position.y < cameraGround + 0.5) camera.position.y = cameraGround + 0.5;
            
            camera.lookAt(targetPos);
            
        } else {
            let moveZ = 0;

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
            
            let hitVehicle = false;
            for (const v of spawnedVehicles) {
                if (Math.hypot(character.position.x - v.mesh.position.x, character.position.z - v.mesh.position.z) < 2.5) {
                    hitVehicle = true;
                    break;
                }
            }
            
            if (!terrain.canOccupy(character.position.x, character.position.z, character.position.y) || 
                checkPlayerCollision(character.position.x, character.position.z, 0.6) || hitVehicle) {
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

        // Multiplayer logic
        if (!character.lastBroadcast || Date.now() - character.lastBroadcast > 50) {
            let animToBroadcast = 'idle';
            if (currentVehicle) animToBroadcast = 'idle';
            else if (isJumping) animToBroadcast = 'jump';
            else if (isRunning) animToBroadcast = 'run';
            else if (movingForward) animToBroadcast = 'walk';
            else if (movingBackward) animToBroadcast = 'walkBack';
            
            broadcastState(
                character.position.x, 
                character.position.y, 
                character.position.z, 
                currentVehicle ? currentVehicle.mesh.rotation.y : character.rotation.y, 
                animToBroadcast, 
                currentVehicle ? currentVehicle.modelName : null
            );
            character.lastBroadcast = Date.now();
        }
        updateRemotePlayers(delta);
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
            const micBtn = document.getElementById('mic-toggle');
            if (micBtn) micBtn.style.display = 'flex';
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

// Mic mute/unmute toggle
function updateMicUI(isEnabled) {
    const btn = document.getElementById('mic-toggle');
    const iconOn = document.getElementById('mic-icon-on');
    const iconOff = document.getElementById('mic-icon-off');
    if (!btn) return;
    if (isEnabled) {
        btn.classList.remove('muted');
        if (iconOn) iconOn.style.display = '';
        if (iconOff) iconOff.style.display = 'none';
    } else {
        btn.classList.add('muted');
        if (iconOn) iconOn.style.display = 'none';
        if (iconOff) iconOff.style.display = '';
    }
}

const micBtn = document.getElementById('mic-toggle');
if (micBtn) {
    micBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        updateMicUI(toggleMic());
    });
}

window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, button')) return;
    if (e.key === 'm' || e.key === 'M') {
        updateMicUI(toggleMic());
    }
});
