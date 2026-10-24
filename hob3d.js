// Hexes of Battle - 3D visuals add-on.
// Loaded before the game bundle. The bundle calls in through window.HOB3D and
// hands over its own Three.js classes (T), so everything shares one Three.js copy.
(function () {
  'use strict';

  const TEAM = [0x2f5fd0, 0xc8302c]; // army 0 blue, army 1 red
  const DIR_YAW = { 0: 0, 1: 0, 2: Math.PI / 3, 3: (2 * Math.PI) / 3, 4: Math.PI, 5: (-2 * Math.PI) / 3, 6: -Math.PI / 3 };
  const UNIT = { PEASANT: 0, PEASANT_ARCHER: 1, SWORDSMAN: 2, SPEARMAN: 3, CROSSBOWMAN: 4, ARCHER: 5, BARBARIAN: 6, HEAVY_KNIGHTS: 7, BEHEMOTH: 8, HERO_COMMANDER: 9, SLINGER: 10 };
  const TERRAIN = { PLAIN: 0, FOREST: 1, HILL: 2, SWAMP: 3, WATER: 5 };

  const C = {
    skin: 0xe0b48c, skinDark: 0xb98a62, steel: 0xb8bec8, darkSteel: 0x6c727c, iron: 0x4a4e55,
    wood: 0x7a5230, darkWood: 0x4e3420, leather: 0x6b4426, boot: 0x3a2a1c, straw: 0xd8c070,
    cloth: 0x8a6e4e, linen: 0xcfc3a3, gold: 0xe8b830, fur: 0x8c6a48, rock: 0x7d7468,
    rockDark: 0x5b544b, lava: 0xff8a2a, string: 0xeee6cc, stone: 0x9a9a92,
  };

  let T = null; // three.js classes from the bundle
  let sceneMgr = null;
  let lastBoard = null;
  let unitMaterial = null;
  const rigCache = new Map();
  const colorTmp = {};

  // ---------- geometry helpers ----------

  function linear(hex) {
    if (!colorTmp[hex]) {
      const c = new T.Color(hex);
      colorTmp[hex] = [c.r, c.g, c.b];
    }
    return colorTmp[hex];
  }

  // Transform a primitive: scale, rotate X/Y/Z, translate. Returns {geo, color}.
  function P(geo, color, o = {}) {
    if (o.s) geo.scale(o.s[0], o.s[1], o.s[2]);
    if (o.r) {
      if (o.r[0]) geo.rotateX(o.r[0]);
      if (o.r[1]) geo.rotateY(o.r[1]);
      if (o.r[2]) geo.rotateZ(o.r[2]);
    }
    if (o.t) geo.translate(o.t[0], o.t[1], o.t[2]);
    return { geo, color };
  }
  const box = (w, h, d) => new T.BoxGeometry(w, h, d);
  const cyl = (rt, rb, h, seg = 6) => new T.CylinderGeometry(rt, rb, h, seg);
  const cone = (r, h, seg = 6) => new T.ConeGeometry(r, h, seg);
  const ball = (r, ws = 7, hs = 5) => new T.SphereGeometry(r, ws, hs);

  // A rod of length len along angle phi (radians, in the XY plane from +X),
  // gripped at fraction g of its length at point p.
  function rod(len, radius, phi, g, p, color, seg = 5) {
    const geo = cyl(radius, radius, len, seg);
    geo.rotateZ(phi - Math.PI / 2);
    const k = len * (0.5 - g);
    geo.translate(p[0] + Math.cos(phi) * k, p[1] + Math.sin(phi) * k, p[2]);
    return { geo, color };
  }
  function along(phi, p, d) {
    return [p[0] + Math.cos(phi) * d, p[1] + Math.sin(phi) * d, p[2]];
  }
  // A piece placed at distance d along a rod, rotated to the rod direction.
  function onRod(geo, color, phi, p, d, extra = {}) {
    if (extra.s) geo.scale(extra.s[0], extra.s[1], extra.s[2]);
    geo.rotateZ(phi - Math.PI / 2);
    const q = along(phi, p, d);
    geo.translate(q[0] + (extra.dx || 0), q[1] + (extra.dy || 0), q[2] + (extra.dz || 0));
    return { geo, color };
  }

  // Merge parts into one non-indexed geometry with baked vertex colours.
  function merge(parts) {
    let count = 0;
    const flat = parts.map((p) => {
      const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
      count += g.attributes.position.count;
      return { g, rgb: linear(p.color) };
    });
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    let o = 0;
    for (const { g, rgb } of flat) {
      const a = g.attributes.position.array;
      pos.set(a, o);
      for (let i = 0; i < a.length; i += 3) {
        col[o + i] = rgb[0];
        col[o + i + 1] = rgb[1];
        col[o + i + 2] = rgb[2];
      }
      o += a.length;
    }
    const out = new T.BufferGeometry();
    out.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    out.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    out.computeVertexNormals();
    out.computeBoundingSphere();
    return out;
  }

  // ---------- soldier rigs ----------
  // Model space: facing +X, up +Y, right hand on +Z. Head top is about 1.0.
  // A rig is { hipY, legZ, shoulderY, shoulderZ, body, armL, armR, legL, legR, pose }.

  const HAND = [0, -0.3, 0];

  function humanRig(spec) {
    const team = spec.team;
    const tunic = spec.tunic ?? team;
    const pants = spec.pants ?? C.cloth;
    const armColor = spec.bareArms ? C.skin : spec.armour ? C.steel : tunic;
    const bulk = spec.bulk ?? 1;

    const body = [
      P(box(0.17 * bulk, 0.3, 0.27 * bulk), spec.armour ? C.steel : tunic, { t: [0, 0.17, 0] }),
      P(box(0.18 * bulk, 0.045, 0.28 * bulk), C.leather, { t: [0, 0.04, 0] }),
      P(box(0.17 * bulk, 0.12, 0.26 * bulk), spec.armour ? C.darkSteel : tunic, { t: [0, -0.03, 0] }),
      P(cyl(0.035, 0.04, 0.06), C.skin, { t: [0, 0.34, 0] }),
      P(ball(0.085), C.skin, { t: [0, 0.42, 0] }),
      P(box(0.02, 0.02, 0.025), 0x222222, { t: [0.08, 0.43, 0.035] }),
      P(box(0.02, 0.02, 0.025), 0x222222, { t: [0.08, 0.43, -0.035] }),
    ];
    if (spec.tabard) body.push(P(box(0.175 * bulk, 0.34, 0.16), team, { t: [0.005, 0.1, 0] }));
    if (spec.sash) body.push(P(box(0.18, 0.05, 0.28), team, { r: [0.6, 0, 0], t: [0, 0.18, 0] }));
    if (spec.fur) body.push(P(box(0.2, 0.08, 0.31), C.fur, { t: [0, 0.3, 0] }));
    if (spec.cape) body.push(P(box(0.03, 0.46, 0.28), team, { r: [0, 0, -0.12], t: [-0.12, 0.08, 0] }));
    if (spec.quiver) {
      body.push(P(cyl(0.035, 0.03, 0.26), C.leather, { r: [0.5, 0, 0.3], t: [-0.1, 0.22, -0.05] }));
      body.push(P(box(0.05, 0.05, 0.05), 0xdddddd, { r: [0.5, 0, 0.3], t: [-0.15, 0.34, -0.1] }));
    }
    for (const part of spec.head(team)) body.push(part);

    const leg = (side) => [
      P(box(0.09, 0.42, 0.09), pants, { t: [0, -0.21, 0] }),
      P(box(0.14, 0.07, 0.1), C.boot, { t: [0.025, -0.405, 0] }),
      ...(spec.armour ? [P(box(0.1, 0.16, 0.1), C.steel, { t: [0.005, -0.27, 0] })] : []),
    ];
    const arm = () => [
      P(box(0.07, 0.29, 0.07), armColor, { t: [0, -0.14, 0] }),
      P(ball(0.04, 5, 4), spec.armour ? C.darkSteel : C.skin, { t: [0, -0.3, 0] }),
      ...(spec.armour ? [P(ball(0.06, 6, 4), C.steel, { s: [1, 0.8, 1], t: [0, 0.0, 0] })] : []),
    ];

    return {
      hipY: 0.44,
      legZ: 0.065,
      shoulderY: 0.3,
      shoulderZ: 0.165 * bulk,
      body: merge(body),
      legL: merge(leg(-1)),
      legR: merge(leg(1)),
      armL: merge([...arm(), ...(spec.leftHand ? spec.leftHand(team) : [])]),
      armR: merge([...arm(), ...(spec.rightHand ? spec.rightHand(team) : [])]),
      pose: spec.pose,
    };
  }

  // Head gear
  const heads = {
    strawHat: () => [P(cyl(0.16, 0.16, 0.02, 10), C.straw, { t: [0, 0.48, 0] }), P(cone(0.09, 0.09, 8), C.straw, { t: [0, 0.53, 0] })],
    hood: () => [P(ball(0.097, 8, 6), C.cloth, { s: [1.05, 1, 1.05], t: [-0.012, 0.43, 0] })],
    kettle: () => [P(ball(0.095, 8, 5), C.steel, { s: [1, 0.75, 1], t: [0, 0.47, 0] }), P(cyl(0.15, 0.15, 0.02, 10), C.darkSteel, { t: [0, 0.46, 0] })],
    conical: () => [P(cone(0.1, 0.16, 8), C.steel, { t: [0, 0.54, 0] }), P(box(0.02, 0.07, 0.02), C.darkSteel, { t: [0.09, 0.44, 0] })],
    cap: () => [P(ball(0.094, 8, 5), C.darkSteel, { s: [1, 0.7, 1], t: [-0.005, 0.465, 0] })],
    horned: () => [
      P(ball(0.094, 8, 5), C.iron, { s: [1, 0.7, 1], t: [0, 0.465, 0] }),
      P(cone(0.025, 0.12, 5), C.linen, { r: [-0.9, 0, 0], t: [0, 0.52, 0.1] }),
      P(cone(0.025, 0.12, 5), C.linen, { r: [0.9, 0, 0], t: [0, 0.52, -0.1] }),
      P(box(0.05, 0.08, 0.14), 0x7a4a26, { t: [0.07, 0.36, 0] }),
    ],
    greatHelm: (team) => [
      P(cyl(0.1, 0.1, 0.18, 8), C.steel, { t: [0, 0.44, 0] }),
      P(box(0.01, 0.02, 0.12), 0x111111, { t: [0.1, 0.45, 0] }),
      P(box(0.05, 0.1, 0.03), team, { r: [0, 0, -0.4], t: [-0.03, 0.58, 0] }),
    ],
    crown: (team) => [
      P(ball(0.096, 8, 5), C.gold, { s: [1, 0.72, 1], t: [0, 0.47, 0] }),
      P(cyl(0.11, 0.11, 0.04, 8), C.gold, { t: [0, 0.48, 0] }),
      P(box(0.06, 0.12, 0.03), team, { r: [0, 0, -0.3], t: [-0.02, 0.6, 0] }),
    ],
    headband: (team) => [P(cyl(0.09, 0.09, 0.03, 8), team, { t: [0, 0.45, 0] })],
  };

  // Hand items. Right hand on the right arm, left hand on the left arm.
  function shieldRound(team) {
    return [
      P(cyl(0.15, 0.15, 0.025, 10), team, { r: [Math.PI / 2, 0, 0], t: [0.0, -0.18, -0.055] }),
      P(cyl(0.155, 0.155, 0.018, 10), C.darkWood, { r: [Math.PI / 2, 0, 0], t: [0.0, -0.18, -0.045] }),
      P(ball(0.035, 6, 4), C.steel, { t: [0.0, -0.18, -0.075] }),
    ];
  }
  function shieldKite(team) {
    return [
      P(box(0.2, 0.32, 0.025), team, { t: [0.0, -0.2, -0.06] }),
      P(cone(0.1, 0.12, 4), team, { s: [1, 1, 0.12], r: [Math.PI, Math.PI / 4, 0], t: [0.0, -0.42, -0.06] }),
      P(box(0.04, 0.32, 0.03), C.gold, { t: [0.0, -0.2, -0.07] }),
    ];
  }
  function spear(phi) {
    return [
      rod(1.25, 0.014, phi, 0.35, HAND, C.wood),
      onRod(cone(0.03, 0.12, 5), C.steel, phi, HAND, 1.25 * 0.65 + 0.05),
    ];
  }
  function pitchfork(phi) {
    const parts = [rod(1.05, 0.016, phi, 0.35, HAND, C.wood)];
    const end = 1.05 * 0.65;
    parts.push(onRod(box(0.02, 0.02, 0.12), C.iron, phi, HAND, end));
    for (const dz of [-0.05, 0, 0.05]) parts.push(onRod(box(0.012, 0.13, 0.012), C.iron, phi, HAND, end + 0.065, { dz }));
    return parts;
  }
  function sword(phi) {
    return [
      rod(0.09, 0.018, phi, 0.5, HAND, C.leather),
      onRod(box(0.03, 0.025, 0.14), C.gold, phi, HAND, 0.05),
      onRod(box(0.022, 0.38, 0.055), C.steel, phi, HAND, 0.25),
    ];
  }
  function axe(phi) {
    return [
      rod(0.6, 0.016, phi, 0.3, HAND, C.darkWood),
      onRod(box(0.14, 0.13, 0.025), C.darkSteel, phi, HAND, 0.36, { dx: 0.05 }),
    ];
  }
  function halberd(phi) {
    return [
      rod(1.35, 0.015, phi, 0.35, HAND, C.darkWood),
      onRod(cone(0.025, 0.16, 5), C.steel, phi, HAND, 1.35 * 0.65 + 0.07),
      onRod(box(0.15, 0.12, 0.02), C.steel, phi, HAND, 1.35 * 0.65 - 0.08, { dx: 0.05 }),
    ];
  }
  function bow() {
    // Bow along the arm's local X axis, bulging to local -Y (forward when the arm points ahead).
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const s = -1 + i / 3;
      pts.push([s * 0.32, -0.3 - 0.08 * (1 - s * s), 0]);
    }
    const parts = [];
    for (let i = 0; i < 6; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      const g = box(len + 0.01, 0.025, 0.025);
      g.rotateZ(Math.atan2(dy, dx));
      g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0);
      parts.push({ geo: g, color: C.darkWood });
    }
    parts.push(P(box(0.64, 0.006, 0.006), C.string, { t: [0, -0.3, 0] }));
    return parts;
  }
  function crossbow() {
    // Stock runs along local -Y from the hand (forward when the arm points ahead).
    return [
      P(box(0.05, 0.4, 0.05), C.wood, { t: [0, -0.42, 0] }),
      P(box(0.03, 0.03, 0.36), C.darkSteel, { t: [0, -0.6, 0] }),
      P(box(0.006, 0.006, 0.34), C.string, { t: [0, -0.5, 0] }),
    ];
  }
  function sling() {
    return [
      P(box(0.008, 0.22, 0.008), C.leather, { t: [0, -0.41, 0] }),
      P(ball(0.03, 5, 4), C.stone, { t: [0, -0.52, 0] }),
    ];
  }

  // Rest poses (radians, positive swings the arm forward).
  const POSES = {
    polearm: { armR: 0.55, armL: 0.25, attack: 'thrust', ranged: null },
    sword: { armR: 0.6, armL: 0.55, attack: 'chop', ranged: null },
    axe: { armR: 0.45, armL: 0.15, attack: 'chop', ranged: null },
    bow: { armR: 0.35, armL: 0.75, attack: 'jab', ranged: 'bow' },
    crossbow: { armR: 0.9, armL: 0.9, attack: 'jab', ranged: 'crossbow' },
    sling: { armR: 0.2, armL: 0.15, attack: 'jab', ranged: 'sling' },
    halberd: { armR: 0.55, armL: 0.35, attack: 'chop', ranged: null },
    behemoth: { armR: 0.15, armL: 0.15, attack: 'smash', ranged: null },
  };
  // Weapon angle in arm-local space so it reads well at the rest pose.
  const POLE = 0.73; // about 70 degrees elevation once the arm is raised 0.55

  function buildRig(type, team, hero) {
    switch (type) {
      case UNIT.PEASANT:
        return humanRig({ team, pants: C.cloth, head: heads.strawHat, rightHand: () => pitchfork(POLE), pose: POSES.polearm });
      case UNIT.PEASANT_ARCHER:
        return humanRig({ team, pants: C.leather, head: heads.hood, quiver: true, leftHand: bow, pose: POSES.bow });
      case UNIT.ARCHER:
        return humanRig({ team, tabard: true, pants: C.leather, head: heads.hood, quiver: true, leftHand: bow, pose: POSES.bow });
      case UNIT.SWORDSMAN:
        return humanRig({ team, tabard: true, tunic: C.darkSteel, head: heads.kettle, rightHand: () => sword(0.25), leftHand: shieldRound, pose: POSES.sword });
      case UNIT.SPEARMAN:
        return humanRig({ team, head: heads.conical, rightHand: () => spear(POLE), leftHand: shieldRound, pose: POSES.polearm });
      case UNIT.CROSSBOWMAN:
        return humanRig({ team, tabard: true, tunic: C.leather, head: heads.cap, rightHand: crossbow, pose: POSES.crossbow });
      case UNIT.BARBARIAN:
        return humanRig({ team, tunic: C.skinDark, bareArms: true, fur: true, sash: true, pants: team, bulk: 1.12, head: heads.horned, rightHand: () => axe(0.4), pose: POSES.axe });
      case UNIT.HEAVY_KNIGHTS:
        return humanRig({ team, armour: true, tabard: true, pants: C.darkSteel, bulk: 1.08, head: heads.greatHelm, rightHand: () => halberd(POLE), leftHand: shieldKite, pose: POSES.halberd });
      case UNIT.SLINGER:
        return humanRig({ team, pants: C.linen, head: heads.headband, rightHand: sling, pose: POSES.sling });
      case UNIT.BEHEMOTH:
        return behemothRig(team);
      case UNIT.HERO_COMMANDER:
      default:
        if (hero || type === UNIT.HERO_COMMANDER)
          return humanRig({ team, armour: true, tabard: true, cape: true, pants: C.darkSteel, head: heads.crown, rightHand: () => sword(0.25), leftHand: shieldKite, pose: POSES.sword });
        return humanRig({ team, tunic: C.linen, sash: true, head: heads.strawHat, rightHand: () => pitchfork(POLE), pose: POSES.polearm });
    }
  }

  function rough(r, color, o) {
    const g = new T.SphereGeometry(r, 6, 4);
    const a = g.attributes.position;
    for (let i = 0; i < a.count; i++) {
      const k = 1 + (Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.18;
      a.setXYZ(i, a.getX(i) * k, a.getY(i) * k, a.getZ(i) * k);
    }
    return P(g, color, o);
  }

  function behemothRig(team) {
    const body = [
      rough(0.3, C.rock, { s: [0.9, 1.1, 1.15], t: [0, 0.3, 0] }),
      rough(0.17, C.rockDark, { t: [0.06, 0.68, 0] }),
      P(box(0.05, 0.035, 0.05), C.lava, { t: [0.2, 0.7, 0.06] }),
      P(box(0.05, 0.035, 0.05), C.lava, { t: [0.2, 0.7, -0.06] }),
      P(box(0.06, 0.2, 0.06), C.lava, { r: [0.3, 0, 0], t: [0.27, 0.28, 0] }),
      P(cone(0.08, 0.2, 5), team, { r: [0.5, 0, 0], t: [-0.02, 0.6, 0.3] }),
      P(cone(0.08, 0.2, 5), team, { r: [-0.5, 0, 0], t: [-0.02, 0.6, -0.3] }),
      P(cone(0.06, 0.16, 5), team, { t: [-0.12, 0.66, 0] }),
    ];
    const arm = () => [rough(0.13, C.rock, { t: [0, -0.1, 0] }), rough(0.15, C.rockDark, { t: [0.02, -0.36, 0] })];
    const leg = () => [rough(0.14, C.rockDark, { s: [1, 1.5, 1], t: [0, -0.16, 0] })];
    return {
      hipY: 0.3,
      legZ: 0.17,
      shoulderY: 0.45,
      shoulderZ: 0.38,
      body: merge(body),
      legL: merge(leg()),
      legR: merge(leg()),
      armL: merge(arm()),
      armR: merge(arm()),
      pose: POSES.behemoth,
    };
  }

  function getRig(type, team, hero) {
    const key = `${type}|${team}|${hero ? 1 : 0}`;
    if (!rigCache.has(key)) rigCache.set(key, buildRig(type, team, hero));
    return rigCache.get(key);
  }

  function getUnitMaterial() {
    if (!unitMaterial) {
      unitMaterial = new T.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.72, metalness: 0.08 });
    }
    return unitMaterial;
  }

  // ---------- unit visual (implements the game's model-visual interface) ----------

  class Unit3D {
    constructor(creature, isHero) {
      this.format = 'FULL_3D_RIGID';
      this.object3D = new T.Group();
      this.animState = 'idle';
      this.animTimer = 0;
      this.animDuration = 500;
      this.time = Math.random() * 10;
      this.speed = 0.85 + Math.random() * 0.3;
      this.yaw = null;
      this.targetYaw = 0;
      this.ownMaterial = null;

      const type = Number(creature.creatureType);
      const team = TEAM[creature.armyAlignment === 1 ? 1 : 0];
      this.rig = getRig(type, team, isHero);
      this.pose = this.rig.pose;

      const n = Math.max(1, creature.stats?.model_count ?? 1);
      // Formations pack 16 men at 0.2 spacing, so big squads use smaller miniatures.
      let scale = n >= 12 ? 0.68 : n >= 6 ? 0.8 : n >= 3 ? 0.95 : 1.1;
      if (type === UNIT.BEHEMOTH) scale = 1.6;
      if (isHero) scale *= 1.15;
      this.object3D.scale.setScalar(scale);
      this.object3D.name = 'Unit3D';

      const mat = getUnitMaterial();
      const mk = (geo) => {
        const m = new T.Mesh(geo, mat);
        m.castShadow = true;
        return m;
      };
      this.anim = new T.Group();
      this.object3D.add(this.anim);
      this.body = mk(this.rig.body);
      this.body.position.y = this.rig.hipY;
      this.legL = mk(this.rig.legL);
      this.legR = mk(this.rig.legR);
      this.legL.position.set(0, this.rig.hipY, -this.rig.legZ);
      this.legR.position.set(0, this.rig.hipY, this.rig.legZ);
      this.armL = mk(this.rig.armL);
      this.armR = mk(this.rig.armR);
      this.armL.position.set(0, this.rig.shoulderY, -this.rig.shoulderZ);
      this.armR.position.set(0, this.rig.shoulderY, this.rig.shoulderZ);
      this.body.add(this.armL, this.armR);
      this.anim.add(this.body, this.legL, this.legR);
      this.meshes = [this.body, this.legL, this.legR, this.armL, this.armR];

      if (creature.facingDirection !== undefined) this.setFacing(creature.facingDirection);
      this.applyPose(0);
    }

    setFacing(dir) {
      this.targetYaw = DIR_YAW[dir] ?? 0;
      if (this.yaw === null) {
        this.yaw = this.targetYaw;
        this.object3D.rotation.y = this.yaw;
      }
    }

    playAnimation(state, duration = 500) {
      this.animState = state;
      this.animTimer = 0;
      this.animDuration = Math.max(1, duration);
    }

    setCasualtyFade(f) {
      const t = Math.max(0, Math.min(1, f));
      this.object3D.visible = t > 0;
      if (t >= 1) {
        if (this.ownMaterial) for (const m of this.meshes) m.material = getUnitMaterial();
        return;
      }
      if (t <= 0) return;
      if (!this.ownMaterial) {
        this.ownMaterial = getUnitMaterial().clone();
        this.ownMaterial.transparent = true;
      }
      this.ownMaterial.opacity = t;
      for (const m of this.meshes) m.material = this.ownMaterial;
    }

    update(dtMs) {
      const dt = Math.min(100, dtMs);
      this.animTimer += dt;
      this.time += (dt / 1000) * this.speed;
      // Smooth turn toward the target facing along the shortest arc.
      let d = this.targetYaw - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * Math.min(1, dt / 120);
      this.object3D.rotation.y = this.yaw;
      this.applyPose(dt);
    }

    applyPose() {
      const p = this.pose;
      const t = this.time;
      const k = Math.min(1, this.animTimer / this.animDuration);
      let legL = 0, legR = 0, armL = p.armL, armR = p.armR, armRx = 0;
      let lean = 0, px = 0, py = 0, pz = 0, fall = 0, twist = 0;

      switch (this.animState) {
        case 'walk': {
          const s = Math.sin(t * 11);
          legL = s * 0.6;
          legR = -s * 0.6;
          armL += -s * 0.35;
          armR += s * 0.25;
          py = Math.abs(Math.cos(t * 11)) * 0.035;
          lean = -0.08;
          break;
        }
        case 'attack_melee': {
          if (p.attack === 'thrust') {
            const e = k < 0.35 ? -k / 0.35 * 0.35 : k < 0.6 ? -0.35 + ((k - 0.35) / 0.25) * 1.15 : 0.8 * (1 - (k - 0.6) / 0.4);
            armR += e;
            px = Math.max(0, e) * 0.18;
            lean = -Math.max(0, e) * 0.25;
            legL = Math.max(0, e) * 0.4;
          } else if (p.attack === 'smash') {
            const e = k < 0.45 ? (k / 0.45) * 2.6 : 2.6 - ((k - 0.45) / 0.55) * 2.6;
            armL += e;
            armR += e;
            lean = k < 0.45 ? 0.15 : -0.2 * Math.sin(((k - 0.45) / 0.55) * Math.PI);
            px = k > 0.45 ? Math.sin(((k - 0.45) / 0.55) * Math.PI) * 0.15 : 0;
          } else if (p.attack === 'chop') {
            const up = 2.4 - p.armR;
            const e = k < 0.4 ? (k / 0.4) * up : up - ((k - 0.4) / 0.25) * (up + 0.5);
            armR += k < 0.65 ? e : -0.5 * (1 - (k - 0.65) / 0.35);
            lean = k < 0.4 ? 0.06 : -0.18 * Math.sin(Math.min(1, (k - 0.4) / 0.6) * Math.PI);
            px = k > 0.4 ? Math.sin(Math.min(1, (k - 0.4) / 0.6) * Math.PI) * 0.12 : 0;
            twist = k < 0.4 ? -0.2 * (k / 0.4) : -0.2 + 0.4 * Math.min(1, (k - 0.4) / 0.3);
          } else {
            const e = Math.sin(k * Math.PI);
            armR += e * 0.9;
            px = e * 0.1;
          }
          if (k >= 1) this.playAnimation('idle');
          break;
        }
        case 'attack_ranged': {
          if (p.ranged === 'bow') {
            armL = 1.5;
            armR = k < 0.55 ? 1.5 - (k / 0.55) * 0.3 : 1.2 + ((k - 0.55) / 0.45) * 0.3;
            armRx = k < 0.55 ? -(k / 0.55) * 0.35 : -0.35 * (1 - (k - 0.55) / 0.45);
            lean = 0.05;
          } else if (p.ranged === 'crossbow') {
            armL = armR = 1.45;
            px = k > 0.5 && k < 0.7 ? -0.06 : 0;
          } else if (p.ranged === 'sling') {
            armR = k < 0.7 ? 0.2 + (k / 0.7) * Math.PI * 4 : 0.2 + Math.PI * 4 + ((k - 0.7) / 0.3) * 1.2;
            px = k > 0.6 && k < 0.8 ? 0.08 : 0;
          } else {
            armR += Math.sin(k * Math.PI) * 1.2;
          }
          if (k >= 1) this.playAnimation('idle');
          break;
        }
        case 'hit': {
          const e = 1 - k;
          px = -0.12 * e;
          lean = 0.25 * e;
          twist = Math.sin(this.animTimer * 0.05) * 0.15 * e;
          if (k >= 1) this.playAnimation('idle');
          break;
        }
        case 'die': {
          fall = k * (Math.PI / 2);
          py = -k * 0.05;
          this.setCasualtyFade(1 - Math.max(0, (k - 0.5) * 2));
          break;
        }
        case 'rest': {
          py = -0.06 + Math.sin(t * 2) * 0.01;
          legL = legR = 0.35;
          lean = 0.1;
          armR = p.armR * 0.5;
          armL = p.armL * 0.5;
          break;
        }
        case 'panicked': {
          px = (Math.random() - 0.5) * 0.03;
          armL = 2.6 + Math.sin(t * 13) * 0.3;
          armR = 2.6 + Math.cos(t * 13) * 0.3;
          lean = 0.15;
          break;
        }
        default: {
          // idle: breathe and sway a little
          py = Math.sin(t * 2.2) * 0.008;
          armL += Math.sin(t * 1.3) * 0.04;
          armR += Math.sin(t * 1.1 + 1) * 0.04;
          lean = Math.sin(t * 0.9) * 0.025;
        }
      }

      this.legL.rotation.z = legL;
      this.legR.rotation.z = legR;
      this.armL.rotation.z = armL;
      this.armR.rotation.z = armR;
      this.armR.rotation.x = armRx;
      this.body.rotation.z = lean;
      this.body.rotation.y = twist;
      this.anim.position.set(px, py, pz);
      this.anim.rotation.z = fall;
    }

    dispose() {
      // Geometry and the shared material are cached across units.
      if (this.ownMaterial) this.ownMaterial.dispose();
    }
  }

  // ---------- terrain props ----------

  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function pine(parts, x, y, z, h, r) {
    parts.push(P(cyl(0.035 * h, 0.05 * h, 0.22 * h, 5), C.darkWood, { t: [x, y + 0.11 * h, z] }));
    const greens = [0x2f5a2a, 0x3a6b31, 0x46793a];
    for (let i = 0; i < 3; i++) {
      const rr = (0.32 - i * 0.075) * h * (0.9 + r() * 0.2);
      parts.push(P(cone(rr, 0.36 * h, 7), greens[i], { r: [0, r() * 6, 0], t: [x, y + (0.32 + i * 0.2) * h, z] }));
    }
  }
  function broadleaf(parts, x, y, z, h, r) {
    parts.push(P(cyl(0.03 * h, 0.045 * h, 0.3 * h, 5), C.wood, { t: [x, y + 0.15 * h, z] }));
    parts.push(rough(0.2 * h, r() > 0.5 ? 0x4c7a34 : 0x5a8a3a, { s: [1, 0.85, 1], t: [x, y + 0.42 * h, z] }));
  }

  function decorateBoard(board) {
    if (board.__hobProps) {
      board.group.remove(board.__hobProps);
      board.__hobProps.geometry.dispose();
      board.__hobProps = null;
    }
    const map = board.hexMap;
    const R = board.hexRadius;
    const parts = [];
    const terrainAt = (x, y) => (board.getTerrain ? board.getTerrain(x, y) : typeof map.getTerrain === 'function' ? map.getTerrain(x, y) : 0);

    for (let x = 0; x < map.width; x++) {
      for (let y = 0; y < map.height; y++) {
        const ter = terrainAt(x, y);
        const c = board.hexToWorld(x, y);
        const top = board.getHexElevation(x, y);
        const r = rng(x * 73856093 ^ y * 19349663);
        // Points on a ring near the tile edge keep the centre clear for units.
        const ring = (minR, maxR) => {
          const a = r() * Math.PI * 2;
          const d = R * (minR + r() * (maxR - minR));
          return [c.x + Math.cos(a) * d, c.z + Math.sin(a) * d];
        };
        if (ter === TERRAIN.FOREST) {
          const n = 4 + Math.floor(r() * 3);
          for (let i = 0; i < n; i++) {
            const [px, pz] = ring(0.6, 0.84);
            const h = 0.5 + r() * 0.35;
            (r() < 0.7 ? pine : broadleaf)(parts, px, top, pz, h, r);
          }
        } else if (ter === TERRAIN.SWAMP) {
          for (let i = 0; i < 6; i++) {
            const [px, pz] = ring(0.45, 0.82);
            for (let j = 0; j < 4; j++) {
              parts.push(P(cone(0.012, 0.22 + r() * 0.14, 3), r() > 0.5 ? 0x6f7a3a : 0x55682e, {
                r: [(r() - 0.5) * 0.5, 0, (r() - 0.5) * 0.5],
                t: [px + (r() - 0.5) * 0.08, top + 0.12, pz + (r() - 0.5) * 0.08],
              }));
            }
          }
          for (let i = 0; i < 2; i++) {
            const [px, pz] = ring(0.3, 0.7);
            parts.push(P(cyl(0.07, 0.07, 0.01, 7), 0x5b8a3c, { t: [px, top + 0.01, pz] }));
          }
        } else if (ter === TERRAIN.HILL) {
          const n = 3 + Math.floor(r() * 3);
          for (let i = 0; i < n; i++) {
            const [px, pz] = ring(0.5, 0.68);
            const s = 0.06 + r() * 0.08;
            parts.push(rough(s, r() > 0.5 ? 0x8a8478 : 0x6e695f, { s: [1.2, 0.7, 1], r: [0, r() * 6, 0], t: [px, top + s * 0.3, pz] }));
          }
        } else if (ter === TERRAIN.PLAIN) {
          const n = 4 + Math.floor(r() * 4);
          for (let i = 0; i < n; i++) {
            const [px, pz] = ring(0.55, 0.85);
            parts.push(P(cone(0.035, 0.07, 4), r() > 0.5 ? 0x5f8f3b : 0x7a9a40, { t: [px, top + 0.035, pz] }));
          }
          if (r() < 0.25) {
            const [px, pz] = ring(0.6, 0.8);
            parts.push(rough(0.05, 0x8a8478, { s: [1.2, 0.6, 1], t: [px, top + 0.015, pz] }));
          }
        }
      }
    }
    if (!parts.length) return;
    const mesh = new T.Mesh(merge(parts), new T.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85 }));
    mesh.name = 'TerrainProps3D';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.raycast = () => {}; // never block tile picking
    board.group.add(mesh);
    board.__hobProps = mesh;
    lastBoard = board;

    // Let water scroll gently.
    const water = board.materials?.water?.map;
    if (water) {
      water.wrapS = water.wrapT = 1000; // RepeatWrapping
      water.needsUpdate = true;
      animated.water = water;
    }
    fitShadows(board);
  }

  // ---------- sky, fog, light ----------

  const SKY = { top: 0x2c5a96, horizon: 0xb6c8d8, ground: 0x4d5a3a };
  const animated = { water: null };

  function setupAtmosphere(sm) {
    sceneMgr = sm;
    const scene = sm.scene;
    scene.fog = new T.FogExp2(SKY.horizon, 0.017);
    sm.renderer.setClearColor(SKY.horizon, 1);

    const skyMat = new T.ShaderMaterial({
      side: 1, // BackSide
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new T.Color(SKY.top) },
        horizon: { value: new T.Color(SKY.horizon) },
        ground: { value: new T.Color(SKY.ground) },
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader:
        'uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; varying vec3 vDir;' +
        'void main(){ float h = vDir.y; vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.6)) : mix(horizon, ground, pow(-h, 0.4));' +
        'gl_FragColor = vec4(c, 1.0); }',
    });
    const sky = new T.Mesh(new T.SphereGeometry(120, 24, 12), skyMat);
    sky.name = 'SkyDome3D';
    sky.raycast = () => {};
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    scene.add(sky);
    animated.sky = sky;

    const ground = new T.Mesh(new T.CylinderGeometry(110, 110, 0.1, 48), new T.MeshStandardMaterial({ color: 0x55663a, roughness: 1 }));
    ground.name = 'Ground3D';
    ground.position.y = -0.42;
    ground.receiveShadow = true;
    ground.raycast = () => {};
    scene.add(ground);

    if (sm.hemiLight) {
      sm.hemiLight.color.setHex(0xcfe0ff);
      sm.hemiLight.groundColor.setHex(0x4a5230);
      sm.hemiLight.intensity = 0.7;
    }
    if (sm.ambientLight) sm.ambientLight.intensity = 0.45;
    if (sm.dirLight) {
      sm.dirLight.color.setHex(0xfff1d6);
      sm.dirLight.intensity = 1.9;
      sm.dirLight.shadow.bias = -0.0004;
      sm.dirLight.shadow.normalBias = 0.02;
    }
    if (!setupAtmosphere.started) {
      setupAtmosphere.started = true;
      installCameraControls(sm);
      requestAnimationFrame(tick);
    }
  }

  function fitShadows(board) {
    const L = sceneMgr?.dirLight;
    if (!L) return;
    const w = board.hexMap.width * board.hexRadius * Math.sqrt(3);
    const h = board.hexMap.height * board.hexRadius * 1.5;
    const half = Math.max(w, h) * 0.6 + 2;
    const cam = L.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.far = 80;
    L.position.set(14, 26, 10);
    L.target.position.set(0, 0, 0);
    if (!L.target.parent) sceneMgr.scene.add(L.target);
    L.shadow.mapSize.set(4096, 4096);
    if (L.shadow.map) {
      L.shadow.map.dispose();
      L.shadow.map = null;
    }
    cam.updateProjectionMatrix();
  }

  // ---------- camera rotation controls ----------
  // Right-drag rotates (a plain right-click still reaches the game), plus on-screen buttons.
  // Q/E keyboard rotation is built into the game already.

  const rot = { dragging: false, armed: false, x: 0, y: 0, hold: 0 };

  function swallow(e) {
    e.stopPropagation();
  }

  function installCameraControls(sm) {
    window.addEventListener('pointerdown', (e) => {
      // The HUD's own canvas covers the 3D canvas, so accept any game canvas.
      if (e.button !== 2 || !(e.target instanceof HTMLCanvasElement)) return;
      rot.armed = true;
      rot.dragging = false;
      rot.x = e.clientX;
      rot.y = e.clientY;
    }, true);
    window.addEventListener('pointermove', (e) => {
      if (!rot.armed) return;
      const dx = e.clientX - rot.x;
      const dy = e.clientY - rot.y;
      if (!rot.dragging && Math.hypot(dx, dy) < 5) return;
      rot.dragging = true;
      rot.x = e.clientX;
      rot.y = e.clientY;
      sm.rotateCamera(-dx * 0.005, -dy * 0.004);
      document.body.style.cursor = 'grabbing';
    }, true);
    window.addEventListener('pointerup', (e) => {
      if (e.button !== 2 || !rot.armed) return;
      rot.armed = false;
      document.body.style.cursor = '';
      if (rot.dragging) {
        rot.dragging = false;
        e.stopPropagation(); // a drag is not a right-click for the game
      }
    }, true);

    const bar = document.createElement('div');
    bar.id = 'hob3d-camera';
    bar.innerHTML =
      '<button data-r="-1" title="Rotate left (Q, or right-drag)">&#10226;</button>' +
      '<button data-reset="1" title="Reset view">&#8962;</button>' +
      '<button data-r="1" title="Rotate right (E, or right-drag)">&#10227;</button>';
    const css = document.createElement('style');
    css.textContent =
      '#hob3d-camera{position:fixed;right:16px;bottom:16px;z-index:50;display:flex;gap:6px;user-select:none}' +
      '#hob3d-camera button{width:40px;height:40px;border-radius:8px;border:1px solid #6b5a3e;' +
      'background:rgba(30,24,18,.82);color:#f0dcae;font:20px/1 serif;cursor:pointer;touch-action:none}' +
      '#hob3d-camera button:hover{background:rgba(70,52,30,.92)}' +
      '#hob3d-camera button:active{transform:translateY(1px)}';
    document.head.appendChild(css);
    document.body.appendChild(bar);
    // Keep presses on the buttons away from the game's board click handlers.
    for (const type of ['pointerdown', 'pointerup', 'click', 'wheel', 'contextmenu']) bar.addEventListener(type, swallow);
    bar.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.reset) {
        sm.setCameraYaw(0);
        sm.setCameraPitch(sm.getCameraConfig().initialPitch);
        return;
      }
      rot.hold = Number(b.dataset.r);
      try {
        b.setPointerCapture(e.pointerId);
      } catch {
        // no active pointer (synthetic event); pointerup still stops the hold
      }
    });
    const stop = () => (rot.hold = 0);
    bar.addEventListener('pointerup', stop);
    bar.addEventListener('pointercancel', stop);
    bar.addEventListener('lostpointercapture', stop);
  }

  let last = 0;
  function tick(now) {
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    if (rot.hold && sceneMgr) sceneMgr.rotateCamera(rot.hold * dt * 1.6);
    if (animated.water) {
      animated.water.offset.x += dt * 0.012;
      animated.water.offset.y += dt * 0.007;
    }
    if (animated.sky && sceneMgr) animated.sky.position.copy(sceneMgr.camera.position);
    requestAnimationFrame(tick);
  }

  // ---------- public hooks called from the bundle ----------

  window.HOB3D = {
    // Debug handle for the camera (rotateCamera, zoomCamera, setCameraTarget).
    get sceneManager() {
      return sceneMgr;
    },
    get board() {
      return lastBoard;
    },
    createUnit(threeClasses, creature, isHero) {
      try {
        T = T || threeClasses;
        return new Unit3D(creature, !!isHero);
      } catch (err) {
        console.warn('HOB3D: unit build failed, using sprite', err);
        return null;
      }
    },
    setupAtmosphere(threeClasses, sm) {
      try {
        T = T || threeClasses;
        setupAtmosphere(sm);
      } catch (err) {
        console.warn('HOB3D: atmosphere setup failed', err);
      }
    },
    decorateBoard(threeClasses, board) {
      try {
        T = T || threeClasses;
        decorateBoard(board);
      } catch (err) {
        console.warn('HOB3D: board decoration failed', err);
      }
    },
  };
})();
