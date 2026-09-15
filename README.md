# Tomorrow Land

A 3D procedural multiplayer world.

**Play the game here:** [https://multiplayer-chi.vercel.app/](https://multiplayer-chi.vercel.app/)

## Features

- **Multiplayer:** See and interact with other players in real-time.
- **Proximity Voice Chat:** Talk to players near you. The audio uses a linear falloff based on your distance to other players.
- **Voice Controls:** Mute and unmute your microphone at any time by pressing **M** or clicking the mic icon on the HUD.
- **Procedural World:** Explore a shared island featuring a town square, woodland, hills, and a coastline.
- **Collision & Physics:** Fully physical world where you can jump on objects, climb hills, and collide with trees and buildings.
- **Minimap:** A real-time minimap to help you navigate the world.
- **Animations:** Fully animated character models with walking, running, and jumping states.
- **Dynamic Camera:** Mouse-controlled GTA-style camera with pitch control.

## Architecture

- **Game State Synchronization:** Player positions, rotations, and animations are synchronized using an **MQTT** broker (`test.mosquitto.org`). The game state is broadcasted efficiently to all connected clients.
- **Voice Chat (WebRTC):** Proximity voice chat is established via **WebRTC** for direct **Peer-to-Peer (P2P)** connections. The MQTT broker is used solely as a signaling server to exchange session descriptions and ICE candidates, ensuring minimal latency for voice communication once the P2P connection is established.

## Controls

- **W, A, S, D** or **Arrow Keys**: Move around
- **Mouse Move**: Look around / Rotate camera
- **Shift + W**: Run
- **Space**: Jump
- **M**: Mute / Unmute Voice Chat
