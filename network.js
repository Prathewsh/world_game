import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { animClips, characterTemplate } from './main.js';

export let myName = 'Player';
let localId = crypto.randomUUID ? crypto.randomUUID().split('-')[0] : Math.random().toString(36).substr(2, 9);
const BROKER_URL = 'wss://test.mosquitto.org:8081';
const TOPIC_PREFIX = 'tomorrow_land_world_multi_2026/';
const STATE_TOPIC = `${TOPIC_PREFIX}state`;

const MAX_REMOTE_PLAYERS = 20;
const MAX_PEERS = 10;
const VALID_ANIMS = new Set(['idle', 'walk', 'walkBack', 'run', 'jump']);
const COORD_LIMIT = 1000;
const NAME_MAX_LEN = 15;
const peerCooldowns = {};
const PEER_COOLDOWN_MS = 3000;

let client;
const remotePlayers = {};
const peers = {};
let myStream;
let myListener;
let voiceEnabled = true;
let cachedScene = null;

const gltfLoader = new GLTFLoader();
const vehicleCache = {};

function prepareVehicleScene(vehicleScene) {
    vehicleScene.rotation.y = -Math.PI / 2;
    vehicleScene.scale.set(2, 2, 2);
    vehicleScene.traverse((child) => {
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
}

function getOrLoadVehicle(modelName, callback) {
    if (vehicleCache[modelName]) {
        const cloned = vehicleCache[modelName].clone(true);
        prepareVehicleScene(cloned);
        callback(cloned);
        return;
    }
    gltfLoader.load(`models/vehicles/${modelName}`, (gltf) => {
        const vehicle = gltf.scene;
        prepareVehicleScene(vehicle);
        vehicleCache[modelName] = vehicle;
        const cloned = vehicle.clone(true);
        prepareVehicleScene(cloned);
        callback(cloned);
    });
}

function sanitizeName(name) {
    if (typeof name !== 'string') return 'Player';
    return name.replace(/[^\w\s\-]/g, '').substring(0, NAME_MAX_LEN).trim() || 'Player';
}

function isValidCoord(v) {
    return typeof v === 'string' && !isNaN(v) && isFinite(parseFloat(v)) && Math.abs(parseFloat(v)) < COORD_LIMIT;
}

function isValidId(id) {
    return typeof id === 'string' && id.length >= 4 && id.length <= 36 && /^[a-zA-Z0-9\-]+$/.test(id);
}

function validateState(state) {
    if (!state || typeof state !== 'object') return null;
    if (!isValidId(state.id)) return null;
    if (!isValidCoord(state.x) || !isValidCoord(state.y) || !isValidCoord(state.z)) return null;
    if (typeof state.r !== 'string' || isNaN(state.r)) return null;
    if (!VALID_ANIMS.has(state.anim)) return null;
    if (state.v !== undefined && state.v !== null && typeof state.v !== 'string') return null;
    state.name = sanitizeName(state.name);
    return state;
}

export function checkPlayerCollision(x, z, radius) {
    for (const id in remotePlayers) {
        const p = remotePlayers[id].model.position;
        const dx = p.x - x;
        const dz = p.z - z;
        if (dx * dx + dz * dz < radius * radius) {
            return true;
        }
    }
    return false;
}

export function initNetwork(scene, name, stream = null, listener = null) {
    myName = sanitizeName(name);
    myStream = stream;
    myListener = listener;
    cachedScene = scene;
    
    if (!window.mqtt) {
        console.error('MQTT not loaded');
        return;
    }
    client = window.mqtt.connect(BROKER_URL);
    
    client.on('connect', () => {
        console.log('Connected to multiplayer broker!');
        client.subscribe(STATE_TOPIC);
        client.subscribe(`${TOPIC_PREFIX}signal/${localId}`);
    });
    
    client.on('message', (topic, message) => {
        const msgStr = message.toString();
        if (msgStr.length > 16384) return; // reject oversized messages
        
        if (topic === STATE_TOPIC) {
            try {
                const state = JSON.parse(msgStr);
                if (state.id === localId) return;
                const validated = validateState(state);
                if (!validated) return;
                updateRemotePlayer(scene, validated);
            } catch(e) {}
        } else if (topic === `${TOPIC_PREFIX}signal/${localId}`) {
            try {
                const data = JSON.parse(msgStr);
                if (!isValidId(data.from)) return;
                if (!data.signal || typeof data.signal !== 'object') return;
                handleSignal(data.from, data.signal, scene);
            } catch(e) {}
        }
    });

    // Cleanup disconnected players
    setInterval(() => {
        const now = Date.now();
        for (const [id, rp] of Object.entries(remotePlayers)) {
            if (now - rp.lastSeen > 5000) {
                if (rp.audio) {
                    try {
                        rp.audio.disconnect();
                        rp.model.remove(rp.audio);
                    } catch(e) {}
                }
                if (rp.dummyAudio) {
                    try {
                        rp.dummyAudio.pause();
                        rp.dummyAudio.srcObject = null;
                    } catch(e) {}
                }
                scene.remove(rp.model);
                delete remotePlayers[id];
                if (peers[id]) {
                    peers[id].destroy();
                    delete peers[id];
                }
            }
        }
    }, 2000);
}

function handleSignal(remoteId, signalData, scene) {
    if (!isValidId(remoteId)) return;
    if (!voiceEnabled) return;
    
    let peer = peers[remoteId];
    if ((!peer || peer.destroyed) && window.SimplePeer) {
        // Rate-limit peer creation per remote ID
        const now = Date.now();
        if (peerCooldowns[remoteId] && now - peerCooldowns[remoteId] < PEER_COOLDOWN_MS) return;
        peerCooldowns[remoteId] = now;
        
        peer = createPeer(remoteId, false, scene);
    }
    if (peer && !peer.destroyed) {
        try {
            peer.signal(signalData);
        } catch(e) {
            console.warn(`[VoiceChat] Signal error`);
        }
    }
}

function createPeer(remoteId, initiator, scene) {
    if (peers[remoteId] && !peers[remoteId].destroyed) {
        return peers[remoteId];
    }
    
    // Cap total peer connections
    if (Object.keys(peers).length >= MAX_PEERS) return null;
    
    console.log(`[VoiceChat] Initiating peer for ${remoteId} (initiator: ${initiator})`);
    
    const peerOptions = {
        initiator: initiator,
        trickle: false,
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' }
            ]
        }
    };
    
    if (myStream) {
        peerOptions.stream = myStream;
    } else {
        peerOptions.offerConstraints = {
            offerToReceiveAudio: true,
            offerToReceiveVideo: false
        };
    }

    const peer = new window.SimplePeer(peerOptions);
    
    peer.on('signal', data => {
        if (client && client.connected) {
            client.publish(`${TOPIC_PREFIX}signal/${remoteId}`, JSON.stringify({
                from: localId,
                signal: data
            }));
        }
    });
    
    peer.on('stream', stream => {
        console.log(`[VoiceChat] Audio stream received from ${remoteId}`);
        
        // Workaround for Chrome/WebKit bug: remote WebRTC streams remain silent in Web Audio API
        // unless actively decoded by an HTMLMediaElement playing at low volume.
        let dummyAudio;
        try {
            dummyAudio = new Audio();
            dummyAudio.srcObject = stream;
            dummyAudio.volume = 0.0001;
            dummyAudio.play().catch(e => console.warn('[VoiceChat] Dummy audio play blocked:', e));
        } catch(e) {
            console.warn('[VoiceChat] Dummy audio setup error:', e);
        }

        // Attach audio to the remote player's model
        const attachAudio = () => {
            const rp = remotePlayers[remoteId];
            if (rp && myListener) {
                if (rp.audio) return; // Already attached
                if (dummyAudio) rp.dummyAudio = dummyAudio;
                
                const audio = new THREE.PositionalAudio(myListener);
                audio.setDistanceModel('linear');
                audio.setRefDistance(5);
                audio.setMaxDistance(60);
                audio.setRolloffFactor(1);
                
                audio.setMediaStreamSource(stream);
                
                rp.model.add(audio);
                rp.audio = audio;
                console.log(`[VoiceChat] Positional audio attached to player ${remoteId}`);
            } else {
                setTimeout(attachAudio, 300);
            }
        };
        attachAudio();
    });
    
    peer.on('error', err => {
        console.warn(`[VoiceChat] Peer error with ${remoteId}:`, err);
        delete peers[remoteId];
    });

    peer.on('close', () => {
        console.log(`[VoiceChat] Peer connection closed with ${remoteId}`);
        delete peers[remoteId];
    });
    
    peers[remoteId] = peer;
    return peer;
}

function updateRemotePlayer(scene, state) {
    if (!characterTemplate) return;

    if (!remotePlayers[state.id]) {
        // Cap total remote players to prevent DoS
        if (Object.keys(remotePlayers).length >= MAX_REMOTE_PLAYERS) return;
        // Create new player
        const model = SkeletonUtils.clone(characterTemplate);
        
        // Add name sprite
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        ctx.font = 'bold 36px "Segoe UI", sans-serif';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        
        // Draw rounded rectangle background
        ctx.beginPath();
        ctx.moveTo(128 + 10, 32);
        ctx.lineTo(384 - 10, 32);
        ctx.quadraticCurveTo(384, 32, 384, 32 + 10);
        ctx.lineTo(384, 96 - 10);
        ctx.quadraticCurveTo(384, 96, 384 - 10, 96);
        ctx.lineTo(128 + 10, 96);
        ctx.quadraticCurveTo(128, 96, 128, 96 - 10);
        ctx.lineTo(128, 32 + 10);
        ctx.quadraticCurveTo(128, 32, 128 + 10, 32);
        ctx.fill();
        
        ctx.fillStyle = '#38bdf8';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(state.name, 256, 64);
        
        const tex = new THREE.CanvasTexture(canvas);
        const spriteMat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
        const sprite = new THREE.Sprite(spriteMat);
        sprite.position.y = 220; // 2.2 / 0.01 (model scale)
        sprite.scale.set(150, 37.5, 100); // (1.5, 0.375, 1) / 0.01
        sprite.renderOrder = 999;
        model.add(sprite);
        
        scene.add(model);
        
        const mixer = new THREE.AnimationMixer(model);
        
        const actions = {};
        for (const [name, clip] of Object.entries(animClips)) {
            actions[name] = mixer.clipAction(clip);
            if (name === 'jump') {
                actions[name].setLoop(THREE.LoopOnce, 1);
                actions[name].clampWhenFinished = true;
            }
        }

        remotePlayers[state.id] = {
            model,
            mixer,
            actions,
            nameSprite: sprite,
            currentActionName: '',
            currentAction: null,
            currentVehicleName: null,
            vehicleMesh: null,
            targetPos: new THREE.Vector3(parseFloat(state.x), parseFloat(state.y), parseFloat(state.z)),
            targetRot: parseFloat(state.r),
            lastSeen: Date.now()
        };
        
        // Immediately set position so they don't slide in from 0,0,0
        model.position.copy(remotePlayers[state.id].targetPos);
        model.rotation.y = remotePlayers[state.id].targetRot;
    }
    
    // Initiate WebRTC connection if we are "greater" (deterministic to prevent collision)
    if (voiceEnabled && window.SimplePeer && localId > state.id && !peers[state.id]) {
        createPeer(state.id, true, scene);
    }
    
    const rp = remotePlayers[state.id];
    rp.lastSeen = Date.now();
    rp.targetPos.set(parseFloat(state.x), parseFloat(state.y), parseFloat(state.z));
    rp.targetRot = parseFloat(state.r);
    
    if (rp.currentActionName !== state.anim) {
        const nextAction = rp.actions[state.anim];
        if (nextAction) {
            nextAction.reset().fadeIn(0.2).play();
            if (rp.currentAction) rp.currentAction.fadeOut(0.2);
            rp.currentAction = nextAction;
            rp.currentActionName = state.anim;
        }
    }

    // Sync vehicle model for remote player
    const vModelName = state.v || null;
    if (rp.currentVehicleName !== vModelName) {
        rp.currentVehicleName = vModelName;
        if (vModelName) {
            getOrLoadVehicle(vModelName, (vehGroup) => {
                if (rp.currentVehicleName !== vModelName) return;
                if (rp.vehicleMesh) rp.model.remove(rp.vehicleMesh);
                rp.vehicleMesh = vehGroup;
                rp.model.add(vehGroup);
                
                // Hide character mesh components inside rp.model
                rp.model.traverse((child) => {
                    if (child.isMesh && (!rp.vehicleMesh || !rp.vehicleMesh.getObjectById(child.id))) {
                        child.visible = false;
                    }
                });
                
                if (rp.nameSprite) rp.nameSprite.position.y = 350;
            });
        } else {
            if (rp.vehicleMesh) {
                rp.model.remove(rp.vehicleMesh);
                rp.vehicleMesh = null;
            }
            rp.model.traverse((child) => {
                if (child.isMesh) {
                    child.visible = true;
                }
            });
            if (rp.nameSprite) rp.nameSprite.position.y = 220;
        }
    }
}

export function broadcastState(x, y, z, rotation, animName, vehicleModel = null) {
    if (client && client.connected) {
        const msg = JSON.stringify({
            id: localId,
            name: sanitizeName(myName),
            x: x.toFixed(3),
            y: y.toFixed(3),
            z: z.toFixed(3),
            r: rotation.toFixed(3),
            anim: VALID_ANIMS.has(animName) ? animName : 'idle',
            v: vehicleModel || null
        });
        client.publish(STATE_TOPIC, msg, { qos: 0 });
    }
}

export function updateRemotePlayers(delta) {
    for (const [id, rp] of Object.entries(remotePlayers)) {
        if (rp.mixer) rp.mixer.update(delta);
        rp.model.position.lerp(rp.targetPos, 10 * delta);
        
        const currentRot = rp.model.rotation.y;
        let diff = rp.targetRot - currentRot;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        rp.model.rotation.y += diff * 10 * delta;
    }
}

export function toggleMic() {
    voiceEnabled = !voiceEnabled;
    
    if (!voiceEnabled) {
        // Disconnect: destroy all peers and clean up audio on remote players
        for (const id of Object.keys(peers)) {
            if (peers[id] && !peers[id].destroyed) {
                peers[id].destroy();
            }
            delete peers[id];
        }
        for (const rp of Object.values(remotePlayers)) {
            if (rp.audio) {
                try {
                    rp.audio.disconnect();
                    rp.model.remove(rp.audio);
                } catch(e) {}
                rp.audio = null;
            }
            if (rp.dummyAudio) {
                try {
                    rp.dummyAudio.pause();
                    rp.dummyAudio.srcObject = null;
                } catch(e) {}
                rp.dummyAudio = null;
            }
        }
        // Disable mic tracks
        if (myStream) {
            myStream.getAudioTracks().forEach(t => { t.enabled = false; });
        }
    } else {
        // Reconnect: re-enable mic and trigger peer creation for known players
        if (myStream) {
            myStream.getAudioTracks().forEach(t => { t.enabled = true; });
        }
        if (cachedScene && window.SimplePeer) {
            for (const id of Object.keys(remotePlayers)) {
                if (localId > id && !peers[id]) {
                    createPeer(id, true, cachedScene);
                }
            }
        }
    }
    
    return voiceEnabled;
}
