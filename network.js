import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { animClips, characterTemplate } from './main.js';

export let myName = 'Player';
let localId = Math.random().toString(36).substr(2, 9);
const BROKER_URL = 'wss://test.mosquitto.org:8081';
const TOPIC_PREFIX = 'haven_world_multi_2026/';
const STATE_TOPIC = `${TOPIC_PREFIX}state`;

let client;
const remotePlayers = {};

export function initNetwork(scene, name) {
    myName = name;
    if (!window.mqtt) {
        console.error('MQTT not loaded');
        return;
    }
    client = window.mqtt.connect(BROKER_URL);
    
    client.on('connect', () => {
        console.log('Connected to multiplayer broker!');
        client.subscribe(STATE_TOPIC);
    });
    
    client.on('message', (topic, message) => {
        if (topic === STATE_TOPIC) {
            try {
                const state = JSON.parse(message.toString());
                if (state.id === localId) return; // ignore self
                updateRemotePlayer(scene, state);
            } catch(e) {}
        }
    });

    // Cleanup disconnected players
    setInterval(() => {
        const now = Date.now();
        for (const [id, rp] of Object.entries(remotePlayers)) {
            if (now - rp.lastSeen > 5000) {
                scene.remove(rp.model);
                delete remotePlayers[id];
            }
        }
    }, 2000);
}

function updateRemotePlayer(scene, state) {
    if (!characterTemplate) return; // Template not loaded yet

    if (!remotePlayers[state.id]) {
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
            currentActionName: '',
            currentAction: null,
            targetPos: new THREE.Vector3(parseFloat(state.x), parseFloat(state.y), parseFloat(state.z)),
            targetRot: parseFloat(state.r),
            lastSeen: Date.now()
        };
        
        // Immediately set position so they don't slide in from 0,0,0
        model.position.copy(remotePlayers[state.id].targetPos);
        model.rotation.y = remotePlayers[state.id].targetRot;
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
}

export function broadcastState(x, y, z, rotation, animName) {
    if (client && client.connected) {
        const msg = JSON.stringify({
            id: localId,
            name: myName,
            x: x.toFixed(3),
            y: y.toFixed(3),
            z: z.toFixed(3),
            r: rotation.toFixed(3),
            anim: animName
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
