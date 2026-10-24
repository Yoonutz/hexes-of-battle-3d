# Hexes of Battle - 3D fan edit

Play it: <https://yoonutz.github.io/hexes-of-battle-3d/>

An unofficial fan modification of [Hexes of Battle](https://hexes-of-battle.web.app/). The original game, its rules and its art belong to its creator. This edit only changes the visuals.

## What changed

- Soldiers are real 3D models instead of flat cut-outs, in blue or red per army, each with its own weapon.
- Forests, swamps and hills have 3D trees, reeds and rocks.
- Sky, horizon and sun shadows.
- Camera rotation: right-click and drag, the Q and E keys, or the three buttons at the bottom right.

## How it works

- `hob3d.js` builds the 3D models, terrain props, sky and camera controls.
- The game bundle in `assets/` is the original build with small hooks that call `hob3d.js`.
