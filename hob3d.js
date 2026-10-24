// Hexes of Battle - 3D visuals add-on.
// Loaded before the game bundle. The bundle calls in through window.HOB3D and
// hands over its own Three.js classes (T), so everything shares one Three.js copy.
(function () {
  'use strict';

  const TEAM = [0x2f5fd0, 0xc8302c]; // army 0 blue, army 1 red
  const DIR_YAW = { 0: 0, 1: 0, 2: Math.PI / 3, 3: (2 * Math.PI) / 3, 4: Math.PI, 5: (-2 * Math.PI) / 3, 6: -Math.PI / 3 };
  const UNIT = { PEASANT: 0, PEASANT_ARCHER: 1, SWORDSMAN: 2, SPEARMAN: 3, CROSSBOWMAN: 4, ARCHER: 5, BARBARIAN: 6, HEAVY_KNIGHTS: 7, BEHEMOTH: 8, HERO_COMMANDER: 9, SLINGER: 10 };
  const TERRAIN = { PLAIN: 0, FOREST: 1, HILL: 2, SWAMP: 3, WATER: 5 };
  const VARIANTS = 4;

  const C = {
    steel: 0xc4cad3, darkSteel: 0x7d838c, iron: 0x55595f, mail: 0x8a8f96,
    wood: 0x7a5230, darkWood: 0x4e3420, leather: 0x6b4426, darkLeather: 0x3e2a1a, boot: 0x3a2a1c,
    straw: 0xd8c070, cloth: 0x8a6e4e, linen: 0xd8ccae, wool: 0x6f6a5c, gold: 0xe2b43a,
    fur: 0x8c6a48, bone: 0xe6dcc4, rock: 0x7d7468, rockDark: 0x5b544b, lava: 0xff7a1a,
    string: 0xeee6cc, stone: 0x9a9a92, eye: 0x1d1612, eyeWhite: 0xe9e3d9, lips: 0x9a5a4a, feather: 0xf2efe6,
  };
  // Per-part surface: [roughness, metalness, emissive strength]
  const MAT = {
    skin: [0.62, 0, 0], cloth: [0.93, 0, 0], leather: [0.68, 0, 0], wood: [0.72, 0, 0],
    steel: [0.26, 0.95, 0], iron: [0.42, 0.85, 0], mail: [0.5, 0.88, 0], gold: [0.28, 1, 0],
    hair: [0.8, 0, 0], eye: [0.15, 0, 0], rock: [0.95, 0, 0], lava: [0.6, 0, 1.6], plant: [0.88, 0, 0],
  };
  const SKIN = [0xf2c9a6, 0xe3b48b, 0xc89468, 0xa9744d, 0x8a5a3a];
  const HAIR = [0x2a1c12, 0x4b3020, 0x7a5530, 0x1b1b1b, 0xa08560, 0x8c8c8c];

  let T = null; // three.js classes from the bundle
  let sceneMgr = null;
  let lastBoard = null;
  let unitMaterial = null;
  let envTexture = null;
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
  function shade(hex, f) {
    const c = new T.Color(hex);
    c.multiplyScalar(f);
    return c.getHex();
  }

  // Transform a primitive: scale, rotate X/Y/Z, translate. Returns a part {geo, color, mat}.
  function P(geo, color, o = {}, mat = 'cloth') {
    if (o.s) geo.scale(o.s[0], o.s[1], o.s[2]);
    if (o.r) {
      if (o.r[0]) geo.rotateX(o.r[0]);
      if (o.r[1]) geo.rotateY(o.r[1]);
      if (o.r[2]) geo.rotateZ(o.r[2]);
    }
    if (o.t) geo.translate(o.t[0], o.t[1], o.t[2]);
    return { geo, color, mat };
  }
  const box = (w, h, d) => new T.BoxGeometry(w, h, d);
  const cyl = (rt, rb, h, seg = 10) => new T.CylinderGeometry(rt, rb, h, seg);
  const cone = (r, h, seg = 10) => new T.ConeGeometry(r, h, seg);
  const ball = (r, ws = 12, hs = 9) => new T.SphereGeometry(r, ws, hs);
  // Upper part of a sphere (helmets, hair caps); f = fraction of the half-turn covered.
  const dome = (r, f = 0.5, ws = 16, hs = 8) => new T.SphereGeometry(r, ws, hs, 0, Math.PI * 2, 0, Math.PI * f);

  // A rod of length len along angle phi (radians, in the XY plane from +X),
  // gripped at fraction g of its length at point p.
  function rod(len, radius, phi, g, p, color, mat = 'wood', seg = 6) {
    const geo = cyl(radius, radius, len, seg);
    geo.rotateZ(phi - Math.PI / 2);
    const k = len * (0.5 - g);
    geo.translate(p[0] + Math.cos(phi) * k, p[1] + Math.sin(phi) * k, p[2]);
    return { geo, color, mat };
  }
  function along(phi, p, d) {
    return [p[0] + Math.cos(phi) * d, p[1] + Math.sin(phi) * d, p[2]];
  }
  // A piece placed at distance d along a rod, rotated to the rod direction.
  function onRod(geo, color, phi, p, d, extra = {}, mat = 'steel') {
    if (extra.s) geo.scale(extra.s[0], extra.s[1], extra.s[2]);
    geo.rotateZ(phi - Math.PI / 2);
    const q = along(phi, p, d);
    geo.translate(q[0] + (extra.dx || 0), q[1] + (extra.dy || 0), q[2] + (extra.dz || 0));
    return { geo, color, mat };
  }

  // Merge parts into one non-indexed geometry with baked colours, normals and surface values.
  function merge(parts) {
    let count = 0;
    const flat = parts.map((p) => {
      const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
      if (!g.attributes.normal) g.computeVertexNormals();
      count += g.attributes.position.count;
      return { g, rgb: linear(p.color), pbr: MAT[p.mat] || MAT.cloth };
    });
    const pos = new Float32Array(count * 3);
    const nor = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const pbr = new Float32Array(count * 3);
    let o = 0;
    for (const { g, rgb, pbr: m } of flat) {
      const a = g.attributes.position.array;
      pos.set(a, o);
      nor.set(g.attributes.normal.array, o);
      for (let i = 0; i < a.length; i += 3) {
        col[o + i] = rgb[0];
        col[o + i + 1] = rgb[1];
        col[o + i + 2] = rgb[2];
        pbr[o + i] = m[0];
        pbr[o + i + 1] = m[1];
        pbr[o + i + 2] = m[2];
      }
      o += a.length;
    }
    const out = new T.BufferGeometry();
    out.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
    out.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    out.setAttribute('pbr', new T.Float32BufferAttribute(pbr, 3));
    out.computeBoundingSphere();
    return out;
  }

  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  // Lumpy sphere for rocks and the stone giant.
  function rough(r, color, o, mat = 'rock') {
    const g = new T.SphereGeometry(r, 7, 5);
    const a = g.attributes.position;
    for (let i = 0; i < a.count; i++) {
      const k = 1 + ((Math.sin(i * 12.9898) * 43758.5453) % 1) * 0.18;
      a.setXYZ(i, a.getX(i) * k, a.getY(i) * k, a.getZ(i) * k);
    }
    g.computeVertexNormals();
    return P(g, color, o, mat);
  }

  // ---------- soldier rigs ----------
  // Model space: facing +X, up +Y, right hand on +Z. Head top is about 1.0.
  // A rig is { hipY, legZ, kneeY, shoulderY, shoulderZ, headY, body, armL, armR, thigh, shin, pose }.

  const HAND = [0, -0.3, 0];

  function humanRig(spec, v) {
    const team = shade(spec.team, v.shade);
    const tunic = spec.tunic != null ? shade(spec.tunic, v.shade) : team;
    const pants = spec.pants ?? C.wool;
    const b = spec.bulk ?? 1;
    const armour = !!spec.armour;
    const mail = !!spec.mail;
    const torsoCol = armour ? C.steel : mail ? C.mail : tunic;
    const torsoMat = armour ? 'steel' : mail ? 'mail' : 'cloth';
    const skin = v.skin;
    const zx = 0.74; // body depth along the facing axis

    const body = [
      // pelvis, torso, rounded upper chest and shoulders
      P(cyl(0.1 * b, 0.108 * b, 0.1, 14), pants, { s: [zx, 1, 1], t: [0, -0.01, 0] }),
      P(cyl(0.126 * b, 0.1 * b, 0.28, 16), torsoCol, { s: [zx, 1, 1], t: [0, 0.16, 0] }, torsoMat),
      P(ball(0.112 * b, 16, 10), torsoCol, { s: [zx, 0.5, 1.12], t: [0, 0.27, 0] }, torsoMat),
      P(ball(0.042, 12, 8), torsoCol, { s: [1, 0.75, 1], t: [0, 0.28, 0.125 * b] }, torsoMat),
      P(ball(0.042, 12, 8), torsoCol, { s: [1, 0.75, 1], t: [0, 0.28, -0.125 * b] }, torsoMat),
      // skirt of the tunic or mail
      P(cyl(0.104 * b, 0.132 * b, 0.15, 16), mail || armour ? C.mail : tunic, { s: [0.8, 1, 1], t: [0, -0.05, 0] }, mail || armour ? 'mail' : 'cloth'),
      // belt with buckle and pouch
      P(cyl(0.106 * b, 0.106 * b, 0.032, 16), C.darkLeather, { s: [zx + 0.02, 1, 1], t: [0, 0.035, 0] }, 'leather'),
      P(box(0.012, 0.026, 0.03), C.gold, { t: [0.081 * b, 0.035, 0] }, 'gold'),
      P(box(0.04, 0.05, 0.034), C.leather, { t: [0.02, 0.0, 0.104 * b] }, 'leather'),
      // neck and head
      P(cyl(0.031, 0.036, 0.07, 10), skin, { t: [0, 0.34, 0] }, 'skin'),
      P(ball(0.074, 18, 14), skin, { s: [0.92, 1.1, 0.88], t: [0, 0.432, 0] }, 'skin'),
      P(ball(0.056, 14, 10), skin, { s: [1, 0.78, 0.94], t: [0.012, 0.398, 0] }, 'skin'),
      P(cone(0.012, 0.03, 6), skin, { r: [0, 0, -Math.PI / 2], t: [0.074, 0.428, 0] }, 'skin'),
      P(ball(0.016, 8, 6), skin, { s: [0.55, 1, 0.5], t: [0, 0.432, 0.066] }, 'skin'),
      P(ball(0.016, 8, 6), skin, { s: [0.55, 1, 0.5], t: [0, 0.432, -0.066] }, 'skin'),
      // eyes, brows, mouth
      P(ball(0.009, 8, 6), C.eyeWhite, { t: [0.06, 0.445, 0.024] }, 'eye'),
      P(ball(0.009, 8, 6), C.eyeWhite, { t: [0.06, 0.445, -0.024] }, 'eye'),
      P(ball(0.0055, 6, 5), C.eye, { t: [0.0655, 0.445, 0.024] }, 'eye'),
      P(ball(0.0055, 6, 5), C.eye, { t: [0.0655, 0.445, -0.024] }, 'eye'),
      P(box(0.01, 0.007, 0.03), v.hair, { r: [0.12, 0, 0], t: [0.068, 0.46, 0.026] }, 'hair'),
      P(box(0.01, 0.007, 0.03), v.hair, { r: [-0.12, 0, 0], t: [0.068, 0.46, -0.026] }, 'hair'),
      P(box(0.006, 0.006, 0.026), C.lips, { t: [0.066, 0.401, 0] }, 'skin'),
      // hair cap and back of the head
      P(dome(0.079, 0.5, 18, 8), v.hair, { s: [0.97, 1.05, 0.93], r: [0, 0, 0.45], t: [-0.01, 0.448, 0] }, 'hair'),
      P(ball(0.07, 12, 8), v.hair, { s: [0.8, 1, 0.92], t: [-0.022, 0.428, 0] }, 'hair'),
    ];
    if (v.beard && !spec.noBeard) {
      body.push(P(ball(0.05, 12, 9), v.hair, { s: [0.62, 0.82, 1.08], t: [0.04, 0.388, 0] }, 'hair'));
      body.push(P(box(0.012, 0.012, 0.042), v.hair, { t: [0.07, 0.411, 0] }, 'hair'));
    }
    if (spec.tabard) {
      body.push(P(box(0.012, 0.42, 0.15 * b), team, { r: [0, 0, -0.06], t: [0.094 * b, 0.1, 0] }));
      body.push(P(box(0.012, 0.42, 0.15 * b), team, { r: [0, 0, 0.06], t: [-0.094 * b, 0.1, 0] }));
      body.push(P(box(0.006, 0.055, 0.055), C.gold, { r: [Math.PI / 4, 0, 0], t: [0.102 * b, 0.2, 0] }, 'gold'));
    }
    if (spec.sash) body.push(P(box(0.2 * b, 0.045, 0.27 * b), team, { r: [0.55, 0, 0], t: [0, 0.17, 0] }));
    if (spec.fur) body.push(P(cyl(0.11 * b, 0.15 * b, 0.07, 14), C.fur, { s: [0.85, 1, 1], t: [0, 0.31, 0] }));
    if (armour) {
      body.push(P(cyl(0.05, 0.06, 0.04, 12), C.steel, { t: [0, 0.325, 0] }, 'steel'));
      body.push(P(dome(0.066, 0.5, 14, 6), C.steel, { s: [1, 0.55, 1.1], r: [-0.35, 0, 0], t: [0, 0.29, 0.13 * b] }, 'steel'));
      body.push(P(dome(0.066, 0.5, 14, 6), C.steel, { s: [1, 0.55, 1.1], r: [0.35, 0, 0], t: [0, 0.29, -0.13 * b] }, 'steel'));
    }
    if (spec.cape) body.push(P(box(0.02, 0.5, 0.28 * b), team, { r: [0, 0, -0.1], t: [-0.12 * b, 0.07, 0] }));
    if (spec.quiver) {
      body.push(P(cyl(0.032, 0.028, 0.27, 10), C.leather, { r: [0.5, 0, 0.25], t: [-0.1, 0.2, -0.05] }, 'leather'));
      for (let i = 0; i < 4; i++) {
        const dz = (i - 1.5) * 0.012;
        body.push(P(cyl(0.004, 0.004, 0.1, 4), C.wood, { r: [0.5, 0, 0.25], t: [-0.135 + dz, 0.37, -0.12 + dz] }, 'wood'));
        body.push(P(box(0.004, 0.035, 0.016), C.feather, { r: [0.5, 0, 0.25], t: [-0.142 + dz, 0.405, -0.14 + dz] }));
      }
    }
    for (const part of spec.head(team, v)) body.push(part);

    // Arms: upper arm, elbow, forearm and hand, plus the held item.
    const sleeve = armour ? C.steel : mail ? C.mail : spec.bareArms ? skin : tunic;
    const sleeveMat = armour ? 'steel' : mail ? 'mail' : spec.bareArms ? 'skin' : 'cloth';
    const fore = armour ? C.steel : spec.rolledSleeves || spec.bareArms ? skin : sleeve;
    const foreMat = armour ? 'steel' : spec.rolledSleeves || spec.bareArms ? 'skin' : sleeveMat;
    const hand = armour ? C.darkSteel : spec.gloves ? C.leather : skin;
    const handMat = armour ? 'iron' : spec.gloves ? 'leather' : 'skin';
    const arm = () => [
      P(cyl(0.034, 0.03, 0.15, 10), sleeve, { t: [0, -0.075, 0] }, sleeveMat),
      P(ball(0.031, 10, 8), sleeve, { t: [0, -0.15, 0] }, sleeveMat),
      P(cyl(0.03, 0.024, 0.13, 10), fore, { t: [0, -0.215, 0] }, foreMat),
      P(ball(0.03, 10, 8), hand, { s: [1.1, 1.25, 0.8], t: [0, -0.295, 0] }, handMat),
      ...(armour ? [P(ball(0.04, 10, 8), C.steel, { t: [0, -0.15, 0] }, 'steel')] : []),
    ];

    // Legs: thigh hangs from the hip, shin hangs from the knee.
    const legCol = armour ? C.steel : pants;
    const legMat = armour ? 'steel' : 'cloth';
    const thigh = [P(cyl(0.05 * b, 0.042, 0.22, 10), legCol, { t: [0, -0.11, 0] }, legMat)];
    const shin = [
      P(ball(0.042, 10, 8), armour ? C.steel : pants, { t: [0, 0, 0] }, legMat),
      P(cyl(0.04, 0.034, 0.15, 10), armour ? C.steel : pants, { t: [0, -0.08, 0] }, legMat),
      P(cyl(0.042, 0.045, 0.09, 12), armour ? C.iron : C.boot, { t: [0, -0.175, 0] }, armour ? 'iron' : 'leather'),
      P(ball(0.045, 12, 8), armour ? C.iron : C.boot, { s: [1.55, 0.55, 0.95], t: [0.03, -0.205, 0] }, armour ? 'iron' : 'leather'),
    ];

    return {
      hipY: 0.44,
      legZ: 0.062 * b,
      kneeY: -0.22,
      shoulderY: 0.29,
      shoulderZ: 0.155 * b,
      headY: 0.44 + 0.432,
      body: merge(body),
      armL: merge([...arm(), ...(spec.leftHand ? spec.leftHand(team) : [])]),
      armR: merge([...arm(), ...(spec.rightHand ? spec.rightHand(team) : [])]),
      thigh: merge(thigh),
      shin: merge(shin),
      pose: spec.pose,
    };
  }

  // Head gear
  const heads = {
    strawHat: () => [
      P(cyl(0.14, 0.15, 0.012, 20), C.straw, { t: [0, 0.474, 0] }, 'plant'),
      P(cyl(0.07, 0.084, 0.065, 16), C.straw, { t: [0, 0.505, 0] }, 'plant'),
      P(cyl(0.085, 0.085, 0.014, 16), 0x6b4a2a, { t: [0, 0.482, 0] }, 'leather'),
    ],
    hood: () => [
      P(new T.SphereGeometry(0.088, 16, 10, Math.PI * 1.32, Math.PI * 1.36), C.cloth, { s: [1, 1.08, 1.02], t: [-0.008, 0.44, 0] }),
      P(cyl(0.075, 0.16, 0.08, 16), C.cloth, { t: [0, 0.335, 0] }),
    ],
    kettle: () => [
      P(dome(0.087, 0.5, 18, 8), C.steel, { t: [0, 0.462, 0] }, 'steel'),
      P(cyl(0.135, 0.135, 0.01, 22), C.steel, { t: [0, 0.465, 0] }, 'steel'),
      P(cyl(0.089, 0.089, 0.016, 18), C.iron, { t: [0, 0.47, 0] }, 'iron'),
    ],
    conical: () => [
      P(cone(0.085, 0.14, 18), C.steel, { t: [0, 0.538, 0] }, 'steel'),
      P(cyl(0.087, 0.087, 0.022, 18), C.iron, { t: [0, 0.472, 0] }, 'iron'),
      P(box(0.007, 0.06, 0.012), C.steel, { t: [0.083, 0.442, 0] }, 'steel'),
    ],
    cap: () => [
      P(dome(0.088, 0.52, 18, 8), C.darkSteel, { s: [1.08, 1, 1], t: [-0.006, 0.458, 0] }, 'iron'),
      P(cone(0.05, 0.08, 10), C.darkSteel, { r: [0, 0, Math.PI / 2 + 0.5], t: [-0.09, 0.43, 0] }, 'iron'),
    ],
    horned: (team, v) => [
      P(dome(0.086, 0.5, 16, 8), C.iron, { t: [0, 0.462, 0] }, 'iron'),
      P(cyl(0.088, 0.088, 0.018, 16), C.darkSteel, { t: [0, 0.468, 0] }, 'iron'),
      P(cone(0.022, 0.09, 8), C.bone, { r: [-1.1, 0, 0], t: [0, 0.5, 0.1] }, 'skin'),
      P(cone(0.016, 0.07, 8), C.bone, { r: [-0.3, 0, 0], t: [0, 0.56, 0.15] }, 'skin'),
      P(cone(0.022, 0.09, 8), C.bone, { r: [1.1, 0, 0], t: [0, 0.5, -0.1] }, 'skin'),
      P(cone(0.016, 0.07, 8), C.bone, { r: [0.3, 0, 0], t: [0, 0.56, -0.15] }, 'skin'),
      P(cyl(0.012, 0.008, 0.16, 6), v.hair, { t: [-0.06, 0.36, 0.05] }, 'hair'),
      P(cyl(0.012, 0.008, 0.16, 6), v.hair, { t: [-0.06, 0.36, -0.05] }, 'hair'),
    ],
    greatHelm: (team) => [
      P(cyl(0.084, 0.082, 0.15, 18), C.steel, { t: [0, 0.44, 0] }, 'steel'),
      P(dome(0.084, 0.5, 18, 8), C.steel, { s: [1, 0.6, 1], t: [0, 0.515, 0] }, 'steel'),
      P(box(0.006, 0.012, 0.11), 0x0e0e0e, { t: [0.083, 0.458, 0] }, 'iron'),
      P(box(0.006, 0.07, 0.008), C.gold, { t: [0.084, 0.43, 0] }, 'gold'),
      P(cone(0.024, 0.16, 8), team, { r: [0, 0, 0.9], t: [-0.04, 0.585, 0] }),
    ],
    crown: (team) => [
      P(dome(0.088, 0.5, 18, 8), C.steel, { t: [0, 0.464, 0] }, 'steel'),
      P(cyl(0.092, 0.092, 0.028, 18), C.gold, { t: [0, 0.472, 0] }, 'gold'),
      ...[0, 1, 2, 3, 4, 5].map((i) => {
        const a = (i / 6) * Math.PI * 2;
        return P(cone(0.012, 0.04, 6), C.gold, { t: [Math.cos(a) * 0.088, 0.5, Math.sin(a) * 0.088] }, 'gold');
      }),
      P(cone(0.03, 0.17, 8), team, { r: [0, 0, 0.8], t: [-0.05, 0.56, 0] }),
    ],
    headband: (team) => [P(cyl(0.08, 0.08, 0.018, 18), team, { t: [0, 0.474, 0] })],
  };

  // Hand items. Right hand on the right arm, left hand on the left arm.
  function shieldRound(team) {
    const parts = [
      P(cyl(0.15, 0.15, 0.022, 24), team, { r: [Math.PI / 2, 0, 0], t: [0.0, -0.18, -0.058] }, 'wood'),
      P(cyl(0.157, 0.157, 0.018, 24), C.darkWood, { r: [Math.PI / 2, 0, 0], t: [0.0, -0.18, -0.054] }, 'wood'),
      P(cyl(0.157, 0.157, 0.006, 24), C.iron, { r: [Math.PI / 2, 0, 0], t: [0.0, -0.18, -0.064] }, 'iron'),
      P(dome(0.04, 0.5, 12, 6), C.steel, { r: [-Math.PI / 2, 0, 0], t: [0.0, -0.18, -0.069] }, 'steel'),
      P(box(0.02, 0.24, 0.004), C.linen, { t: [0.0, -0.18, -0.07] }),
      P(box(0.24, 0.02, 0.004), C.linen, { t: [0.0, -0.18, -0.07] }),
    ];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      parts.push(P(ball(0.008, 6, 4), C.iron, { t: [Math.cos(a) * 0.125, -0.18 + Math.sin(a) * 0.125, -0.07] }, 'iron'));
    }
    return parts;
  }
  function shieldKite(team) {
    return [
      P(box(0.2, 0.3, 0.022), team, { t: [0.0, -0.19, -0.062] }, 'wood'),
      P(cone(0.1, 0.13, 4), team, { s: [1, 1, 0.16], r: [Math.PI, Math.PI / 4, 0], t: [0.0, -0.405, -0.062] }, 'wood'),
      P(box(0.21, 0.012, 0.026), C.steel, { t: [0.0, -0.04, -0.062] }, 'steel'),
      P(box(0.012, 0.32, 0.026), C.steel, { t: [0.1, -0.19, -0.062] }, 'steel'),
      P(box(0.012, 0.32, 0.026), C.steel, { t: [-0.1, -0.19, -0.062] }, 'steel'),
      P(box(0.035, 0.22, 0.006), C.gold, { t: [0.0, -0.2, -0.075] }, 'gold'),
      P(box(0.14, 0.035, 0.006), C.gold, { t: [0.0, -0.15, -0.075] }, 'gold'),
    ];
  }
  function spear(phi) {
    return [
      rod(1.25, 0.011, phi, 0.35, HAND, C.wood),
      onRod(cyl(0.015, 0.012, 0.05, 8), C.iron, phi, HAND, 1.25 * 0.65 - 0.01, {}, 'iron'),
      onRod(cone(0.03, 0.14, 4), C.steel, phi, HAND, 1.25 * 0.65 + 0.08, { s: [1, 1, 0.3] }),
    ];
  }
  function pitchfork(phi) {
    const parts = [rod(1.05, 0.014, phi, 0.35, HAND, C.wood)];
    const end = 1.05 * 0.65;
    parts.push(onRod(box(0.02, 0.02, 0.12), C.iron, phi, HAND, end, {}, 'iron'));
    for (const dz of [-0.05, 0, 0.05]) parts.push(onRod(cone(0.007, 0.14, 5), C.iron, phi, HAND, end + 0.075, { dz }, 'iron'));
    return parts;
  }
  function sword(phi) {
    return [
      rod(0.09, 0.016, phi, 0.5, HAND, C.darkLeather, 'leather'),
      onRod(ball(0.02, 8, 6), C.steel, phi, HAND, -0.05),
      onRod(box(0.025, 0.022, 0.14), C.steel, phi, HAND, 0.05),
      onRod(box(0.012, 0.36, 0.048), C.steel, phi, HAND, 0.24),
      onRod(cone(0.024, 0.07, 4), C.steel, phi, HAND, 0.455, { s: [1, 1, 0.3] }),
    ];
  }
  function axe(phi) {
    return [
      rod(0.6, 0.015, phi, 0.3, HAND, C.darkWood),
      onRod(box(0.12, 0.1, 0.018), C.iron, phi, HAND, 0.36, { dx: 0.045 }, 'iron'),
      onRod(box(0.025, 0.14, 0.02), C.steel, phi, HAND, 0.36, { dx: 0.105 }),
    ];
  }
  function halberd(phi) {
    return [
      rod(1.35, 0.014, phi, 0.35, HAND, C.darkWood),
      onRod(cone(0.022, 0.18, 4), C.steel, phi, HAND, 1.35 * 0.65 + 0.08, { s: [1, 1, 0.4] }),
      onRod(box(0.15, 0.13, 0.016), C.steel, phi, HAND, 1.35 * 0.65 - 0.07, { dx: 0.05 }),
      onRod(cone(0.02, 0.08, 4), C.steel, phi, HAND, 1.35 * 0.65 - 0.07, { dx: -0.04, s: [1, 1, 0.4] }),
    ];
  }
  function bow() {
    // Bow along the arm's local X axis, bulging to local -Y (forward when the arm points ahead).
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const s = -1 + i / 4;
      pts.push([s * 0.32, -0.3 - 0.08 * (1 - s * s), 0]);
    }
    const parts = [];
    for (let i = 0; i < 8; i++) {
      const a = pts[i], c = pts[i + 1];
      const dx = c[0] - a[0], dy = c[1] - a[1];
      const len = Math.hypot(dx, dy);
      const r = 0.012 - Math.abs(i - 3.5) * 0.0012;
      const g = cyl(r, r, len + 0.004, 6);
      g.rotateZ(Math.atan2(dy, dx) - Math.PI / 2);
      g.translate((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, 0);
      parts.push({ geo: g, color: C.darkWood, mat: 'wood' });
    }
    parts.push(P(cyl(0.015, 0.015, 0.07, 8), C.darkLeather, { r: [0, 0, Math.PI / 2], t: [0, -0.38, 0] }, 'leather'));
    parts.push(P(cyl(0.002, 0.002, 0.64, 4), C.string, { r: [0, 0, Math.PI / 2], t: [0, -0.3, 0] }));
    return parts;
  }
  function crossbow() {
    // Stock runs along local -Y from the hand (forward when the arm points ahead).
    return [
      P(box(0.045, 0.4, 0.05), C.wood, { t: [0, -0.42, 0] }, 'wood'),
      P(box(0.03, 0.03, 0.36), C.iron, { t: [0, -0.6, 0] }, 'iron'),
      P(cyl(0.002, 0.002, 0.34, 4), C.string, { r: [Math.PI / 2, 0, 0], t: [0, -0.52, 0] }),
      P(box(0.012, 0.03, 0.012), C.iron, { t: [0.03, -0.33, 0] }, 'iron'),
      P(cyl(0.004, 0.004, 0.22, 4), C.wood, { t: [-0.03, -0.5, 0] }, 'wood'),
    ];
  }
  function sling() {
    return [
      P(cyl(0.004, 0.004, 0.22, 4), C.leather, { t: [0, -0.41, 0] }, 'leather'),
      P(ball(0.032, 8, 6), C.stone, { t: [0, -0.53, 0] }, 'rock'),
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

  function buildRig(type, team, hero, v) {
    switch (type) {
      case UNIT.PEASANT:
        return humanRig({ team, tunic: C.linen, sash: true, rolledSleeves: true, pants: C.wool, head: heads.strawHat, rightHand: () => pitchfork(POLE), pose: POSES.polearm }, v);
      case UNIT.PEASANT_ARCHER:
        return humanRig({ team, rolledSleeves: true, pants: C.leather, head: heads.hood, quiver: true, leftHand: bow, pose: POSES.bow }, v);
      case UNIT.ARCHER:
        return humanRig({ team, tabard: true, tunic: 0x4f6b3a, gloves: true, pants: C.leather, head: heads.hood, quiver: true, leftHand: bow, pose: POSES.bow }, v);
      case UNIT.SWORDSMAN:
        return humanRig({ team, mail: true, tabard: true, gloves: true, head: heads.kettle, rightHand: () => sword(0.25), leftHand: shieldRound, pose: POSES.sword }, v);
      case UNIT.SPEARMAN:
        return humanRig({ team, gloves: true, head: heads.conical, rightHand: () => spear(POLE), leftHand: shieldRound, pose: POSES.polearm }, v);
      case UNIT.CROSSBOWMAN:
        return humanRig({ team, tabard: true, tunic: C.leather, gloves: true, head: heads.cap, rightHand: crossbow, pose: POSES.crossbow }, v);
      case UNIT.BARBARIAN:
        return humanRig({ team, tunic: v.skin, bareArms: true, fur: true, sash: true, pants: team, bulk: 1.12, head: heads.horned, rightHand: () => axe(0.4), pose: POSES.axe }, { ...v, beard: true });
      case UNIT.HEAVY_KNIGHTS:
        return humanRig({ team, armour: true, tabard: true, noBeard: true, bulk: 1.08, head: heads.greatHelm, rightHand: () => halberd(POLE), leftHand: shieldKite, pose: POSES.halberd }, v);
      case UNIT.SLINGER:
        return humanRig({ team, tunic: C.linen, pants: C.wool, sash: true, rolledSleeves: true, head: heads.headband, rightHand: sling, pose: POSES.sling }, v);
      case UNIT.BEHEMOTH:
        return behemothRig(team);
      case UNIT.HERO_COMMANDER:
      default:
        if (hero || type === UNIT.HERO_COMMANDER)
          return humanRig({ team, armour: true, tabard: true, cape: true, head: heads.crown, rightHand: () => sword(0.25), leftHand: shieldKite, pose: POSES.sword }, v);
        return humanRig({ team, tunic: C.linen, sash: true, head: heads.strawHat, rightHand: () => pitchfork(POLE), pose: POSES.polearm }, v);
    }
  }

  function behemothRig(team) {
    const body = [
      rough(0.3, C.rock, { s: [0.9, 1.1, 1.15], t: [0, 0.3, 0] }),
      rough(0.17, C.rockDark, { t: [0.06, 0.68, 0] }),
      P(ball(0.03, 8, 6), C.lava, { t: [0.2, 0.7, 0.06] }, 'lava'),
      P(ball(0.03, 8, 6), C.lava, { t: [0.2, 0.7, -0.06] }, 'lava'),
      P(box(0.05, 0.22, 0.05), C.lava, { r: [0.3, 0, 0], t: [0.26, 0.28, 0] }, 'lava'),
      P(box(0.04, 0.16, 0.04), C.lava, { r: [-0.5, 0, 0.2], t: [0.2, 0.42, 0.15] }, 'lava'),
      P(cone(0.08, 0.2, 6), team, { r: [0.5, 0, 0], t: [-0.02, 0.6, 0.3] }, 'eye'),
      P(cone(0.08, 0.2, 6), team, { r: [-0.5, 0, 0], t: [-0.02, 0.6, -0.3] }, 'eye'),
      P(cone(0.06, 0.16, 6), team, { t: [-0.12, 0.66, 0] }, 'eye'),
    ];
    const arm = () => [rough(0.13, C.rock, { t: [0, -0.1, 0] }), rough(0.15, C.rockDark, { t: [0.02, -0.36, 0] })];
    return {
      hipY: 0.3,
      legZ: 0.17,
      kneeY: -0.14,
      shoulderY: 0.45,
      shoulderZ: 0.38,
      headY: 0.98,
      body: merge(body),
      armL: merge(arm()),
      armR: merge(arm()),
      thigh: merge([rough(0.12, C.rockDark, { s: [1, 1.3, 1], t: [0, -0.07, 0] })]),
      shin: merge([rough(0.12, C.rock, { s: [1.2, 0.9, 1], t: [0.02, -0.1, 0] })]),
      pose: POSES.behemoth,
    };
  }

  function variantFor(type, team, i) {
    const r = rng((type + 1) * 7919 + (team === TEAM[1] ? 104729 : 0) + i * 31337);
    return {
      skin: SKIN[Math.floor(r() * SKIN.length)],
      hair: HAIR[Math.floor(r() * HAIR.length)],
      beard: r() < 0.55,
      shade: 0.82 + r() * 0.3,
    };
  }

  function getRig(type, team, hero, variant) {
    const key = `${type}|${team}|${hero ? 1 : 0}|${variant}`;
    if (!rigCache.has(key)) rigCache.set(key, buildRig(type, team, hero, variantFor(type, team, variant)));
    return rigCache.get(key);
  }

  // One material for every soldier; roughness, metalness and glow come from each vertex.
  function makeUnitMaterial() {
    const m = new T.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    m.onBeforeCompile = (s) => {
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 pbr;\nvarying vec3 vPbr;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPbr = pbr;');
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vPbr;')
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPbr.x;')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.y;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * vPbr.z;');
    };
    m.customProgramCacheKey = () => 'hob3d-pbr-v1';
    return m;
  }
  function getUnitMaterial() {
    if (!unitMaterial) unitMaterial = makeUnitMaterial();
    return unitMaterial;
  }

  // ---------- unit visual (implements the game's model-visual interface) ----------

  class Unit3D {
    constructor(creature, isHero, opts = {}) {
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
      this.variant = opts.variant ?? Math.floor(Math.random() * VARIANTS);
      this.rig = getRig(type, team, isHero, this.variant);
      this.pose = this.rig.pose;

      const n = Math.max(1, creature.stats?.model_count ?? 1);
      // Formations pack 16 men at 0.2 spacing, so big squads use smaller miniatures.
      let scale = n >= 12 ? 0.68 : n >= 6 ? 0.8 : n >= 3 ? 0.95 : 1.1;
      if (type === UNIT.BEHEMOTH) scale = 1.6;
      if (isHero) scale *= 1.15;
      if (opts.scale) scale = opts.scale;
      // Men differ a little in height and build.
      const tall = opts.variant != null ? 1 : 0.94 + Math.random() * 0.12;
      const wide = opts.variant != null ? 1 : 0.95 + Math.random() * 0.1;
      this.object3D.scale.set(scale * wide, scale * tall, scale * wide);
      this.object3D.name = 'Unit3D';
      this.object3D.userData.unit = this;

      const mat = getUnitMaterial();
      const mk = (geo) => {
        const m = new T.Mesh(geo, mat);
        m.castShadow = true;
        return m;
      };
      const r = this.rig;
      this.anim = new T.Group();
      this.object3D.add(this.anim);
      this.body = mk(r.body);
      this.body.position.y = r.hipY;
      this.thighL = mk(r.thigh);
      this.thighR = mk(r.thigh);
      this.thighL.position.set(0, r.hipY, -r.legZ);
      this.thighR.position.set(0, r.hipY, r.legZ);
      this.shinL = mk(r.shin);
      this.shinR = mk(r.shin);
      this.shinL.position.y = r.kneeY;
      this.shinR.position.y = r.kneeY;
      this.thighL.add(this.shinL);
      this.thighR.add(this.shinR);
      this.armL = mk(r.armL);
      this.armR = mk(r.armR);
      this.armL.position.set(0, r.shoulderY, -r.shoulderZ);
      this.armR.position.set(0, r.shoulderY, r.shoulderZ);
      this.body.add(this.armL, this.armR);
      this.anim.add(this.body, this.thighL, this.thighR);
      this.meshes = [this.body, this.thighL, this.thighR, this.shinL, this.shinR, this.armL, this.armR];

      if (creature.facingDirection !== undefined) this.setFacing(creature.facingDirection);
      this.applyPose();
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
        this.ownMaterial = makeUnitMaterial();
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
      this.applyPose();
    }

    applyPose() {
      const p = this.pose;
      const t = this.time;
      const k = Math.min(1, this.animTimer / this.animDuration);
      let legL = 0, legR = 0, kneeL = 0, kneeR = 0, armL = p.armL, armR = p.armR, armRx = 0;
      let lean = 0, px = 0, py = 0, pz = 0, fall = 0, twist = 0, sway = 0;

      switch (this.animState) {
        case 'walk': {
          const ph = t * 9;
          const s = Math.sin(ph);
          const c = Math.cos(ph);
          legL = s * 0.5;
          legR = -s * 0.5;
          // The swinging leg bends at the knee; the standing leg stays almost straight.
          kneeL = -(0.06 + 0.75 * Math.max(0, c));
          kneeR = -(0.06 + 0.75 * Math.max(0, -c));
          armL += -s * 0.35;
          armR += s * 0.22;
          py = Math.abs(c) * 0.03 - 0.012;
          lean = -0.1;
          sway = s * 0.04;
          break;
        }
        case 'attack_melee': {
          if (p.attack === 'thrust') {
            const e = k < 0.35 ? -k / 0.35 * 0.35 : k < 0.6 ? -0.35 + ((k - 0.35) / 0.25) * 1.15 : 0.8 * (1 - (k - 0.6) / 0.4);
            armR += e;
            px = Math.max(0, e) * 0.18;
            lean = -Math.max(0, e) * 0.25;
            legL = Math.max(0, e) * 0.45;
            kneeL = -Math.max(0, e) * 0.5;
            kneeR = -Math.max(0, e) * 0.2;
          } else if (p.attack === 'smash') {
            const e = k < 0.45 ? (k / 0.45) * 2.6 : 2.6 - ((k - 0.45) / 0.55) * 2.6;
            armL += e;
            armR += e;
            lean = k < 0.45 ? 0.15 : -0.2 * Math.sin(((k - 0.45) / 0.55) * Math.PI);
            px = k > 0.45 ? Math.sin(((k - 0.45) / 0.55) * Math.PI) * 0.15 : 0;
          } else if (p.attack === 'chop') {
            const up = 2.4 - p.armR;
            const e = k < 0.4 ? (k / 0.4) * up : up - ((k - 0.4) / 0.25) * (up + 0.5);
            const strike = k > 0.4 ? Math.sin(Math.min(1, (k - 0.4) / 0.6) * Math.PI) : 0;
            armR += k < 0.65 ? e : -0.5 * (1 - (k - 0.65) / 0.35);
            lean = k < 0.4 ? 0.06 : -0.18 * strike;
            px = strike * 0.12;
            legL = strike * 0.35;
            kneeL = -strike * 0.4;
            kneeR = -strike * 0.25;
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
            kneeL = kneeR = -0.12;
          } else if (p.ranged === 'crossbow') {
            armL = armR = 1.45;
            px = k > 0.5 && k < 0.7 ? -0.06 : 0;
            kneeL = -0.15;
          } else if (p.ranged === 'sling') {
            armR = k < 0.7 ? 0.2 + (k / 0.7) * Math.PI * 4 : 0.2 + Math.PI * 4 + ((k - 0.7) / 0.3) * 1.2;
            px = k > 0.6 && k < 0.8 ? 0.08 : 0;
            legL = 0.25;
            kneeL = -0.2;
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
          kneeL = kneeR = -0.3 * e;
          py = -0.02 * e;
          if (k >= 1) this.playAnimation('idle');
          break;
        }
        case 'die': {
          fall = k * (Math.PI / 2);
          kneeL = kneeR = -Math.min(1, k * 2) * 0.9;
          legL = legR = Math.min(1, k * 2) * 0.4;
          py = -k * 0.05;
          this.setCasualtyFade(1 - Math.max(0, (k - 0.5) * 2));
          break;
        }
        case 'rest': {
          // Down on one knee.
          legL = 1.35;
          kneeL = -1.45;
          legR = -0.15;
          kneeR = -1.55;
          py = -0.13 + Math.sin(t * 2) * 0.006;
          lean = 0.12;
          armR = p.armR * 0.5;
          armL = p.armL * 0.5;
          break;
        }
        case 'panicked': {
          px = (Math.random() - 0.5) * 0.03;
          armL = 2.6 + Math.sin(t * 13) * 0.3;
          armR = 2.6 + Math.cos(t * 13) * 0.3;
          kneeL = kneeR = -0.25;
          lean = 0.15;
          break;
        }
        default: {
          // idle: breathe, shift weight from foot to foot
          const w = Math.sin(t * 0.7);
          py = Math.sin(t * 2.2) * 0.006;
          armL += Math.sin(t * 1.3) * 0.04;
          armR += Math.sin(t * 1.1 + 1) * 0.04;
          lean = Math.sin(t * 0.9) * 0.02;
          sway = w * 0.025;
          kneeL = -Math.max(0, w) * 0.12;
          kneeR = -Math.max(0, -w) * 0.12;
        }
      }

      this.thighL.rotation.z = legL;
      this.thighR.rotation.z = legR;
      this.shinL.rotation.z = kneeL;
      this.shinR.rotation.z = kneeR;
      this.armL.rotation.z = armL;
      this.armR.rotation.z = armR;
      this.armR.rotation.x = armRx;
      this.body.rotation.z = lean;
      this.body.rotation.y = twist;
      this.body.rotation.x = sway;
      this.anim.position.set(px, py, pz);
      this.anim.rotation.z = fall;
    }

    dispose() {
      // Geometry and the shared material are cached across units.
      if (this.ownMaterial) this.ownMaterial.dispose();
    }
  }

  // ---------- reflections ----------

  // A painted sky panorama the renderer turns into reflections and soft fill light.
  function getEnvTexture() {
    if (envTexture) return envTexture;
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#3a6aa8');
    grad.addColorStop(0.42, '#a9c3dc');
    grad.addColorStop(0.5, '#e4ebef');
    grad.addColorStop(0.53, '#8a8a68');
    grad.addColorStop(1, '#3a3d2a');
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 256);
    const sun = g.createRadialGradient(150, 70, 0, 150, 70, 60);
    sun.addColorStop(0, 'rgba(255,250,230,1)');
    sun.addColorStop(0.15, 'rgba(255,240,200,0.9)');
    sun.addColorStop(1, 'rgba(255,240,200,0)');
    g.fillStyle = sun;
    g.fillRect(0, 0, 512, 256);
    envTexture = new T.CanvasTexture(c);
    envTexture.mapping = 303; // EquirectangularReflectionMapping
    envTexture.colorSpace = 'srgb';
    return envTexture;
  }

  // ---------- portraits for the HUD ----------

  let portraitStage = null;
  const portraitCache = new Map();
  const portraitCanvases = new Map(); // same keys, raw canvases for inspection

  function portraitFor(creature, makeTexture) {
    const type = Number(creature.creatureType);
    const teamIdx = creature.armyAlignment === 1 ? 1 : 0;
    const hero = !!creature.stats?.is_hero || type === UNIT.HERO_COMMANDER;
    const key = `${type}|${teamIdx}|${hero ? 1 : 0}`;
    if (portraitCache.has(key)) return portraitCache.get(key);

    const S = 256;
    if (!portraitStage) {
      const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1);
      renderer.setSize(S, S, false);
      renderer.toneMapping = 7; // Neutral
      renderer.setClearColor(0x000000, 0);
      const scene = new T.Scene();
      scene.environment = getEnvTexture();
      scene.environmentIntensity = 0.7;
      scene.add(new T.AmbientLight(0xffffff, 0.2));
      const key = new T.DirectionalLight(0xffe8cc, 1.5);
      key.position.set(2, 2.2, 1.6);
      scene.add(key);
      const rim = new T.DirectionalLight(0x9fc0ff, 1.2);
      rim.position.set(-2, 1.5, -2);
      scene.add(rim);
      const camera = new T.PerspectiveCamera(24, 1, 0.01, 20);
      portraitStage = { renderer, scene, camera };
    }
    const { renderer, scene, camera } = portraitStage;
    const unit = new Unit3D(creature, hero, { variant: 0, scale: 1 });
    unit.yaw = unit.targetYaw = 0;
    unit.object3D.rotation.y = 0;
    unit.applyPose();
    // Head and shoulders only: arms and weapons would cross the face.
    unit.armL.visible = unit.armR.visible = false;
    scene.add(unit.object3D);

    const out = document.createElement('canvas');
    try {
      const big = type === UNIT.BEHEMOTH;
      const headY = unit.rig.headY;
      const dist = big ? 1.5 : 0.78;
      // Three-quarter view of the face (the model faces +X).
      camera.position.set(dist * 0.86, headY + (big ? 0.1 : 0.03), dist * 0.5);
      camera.lookAt(0, headY - (big ? 0.12 : 0.04), 0);
      renderer.render(scene, camera);

      out.width = out.height = S;
      const g = out.getContext('2d');
      const bg = g.createRadialGradient(S * 0.45, S * 0.4, S * 0.1, S * 0.5, S * 0.5, S * 0.75);
      bg.addColorStop(0, teamIdx ? '#5a3a30' : '#34445e');
      bg.addColorStop(1, '#141210');
      g.fillStyle = bg;
      g.fillRect(0, 0, S, S);
      g.drawImage(renderer.domElement, 0, 0, S, S);
      const vig = g.createRadialGradient(S / 2, S / 2, S * 0.35, S / 2, S / 2, S * 0.72);
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(1, 'rgba(0,0,0,0.55)');
      g.fillStyle = vig;
      g.fillRect(0, 0, S, S);
    } finally {
      // Always take the temporary model out, or it would appear in every later portrait.
      scene.remove(unit.object3D);
      unit.dispose();
    }
    const tex = makeTexture(out);
    portraitCache.set(key, tex);
    portraitCanvases.set(key, out);
    return tex;
  }

  // ---------- terrain props ----------

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

    // Sky reflections on steel, and a filmic colour response that keeps base colours true.
    scene.environment = getEnvTexture();
    scene.environmentIntensity = 0.45;
    sm.renderer.toneMapping = 7; // NeutralToneMapping
    sm.renderer.toneMappingExposure = 1.0;

    if (sm.hemiLight) {
      sm.hemiLight.color.setHex(0xcfe0ff);
      sm.hemiLight.groundColor.setHex(0x4a5230);
      sm.hemiLight.intensity = 0.45;
    }
    if (sm.ambientLight) sm.ambientLight.intensity = 0.25;
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

  // ---------- HUD edge anchoring ----------
  // The game draws its HUD for 1920x1080 and scales it as one block from the top-left,
  // so on other window shapes panels float in the middle. Each top-level panel is pulled
  // to the edge it was designed against, through its pivot (the game owns position).

  const DESIGN = { w: 1920, h: 1080 };
  const ui = { hud: null, dx: 0, dy: 0, items: [] };
  const uiState = new WeakMap(); // child -> { key, pivotX, pivotY, ax, ay, box }

  function registerHud(hud) {
    ui.hud = hud;
    applyUiAnchors();
  }

  function uiResize(w, h, s) {
    const scale = s || 1;
    ui.dx = Math.max(0, w / scale - DESIGN.w);
    ui.dy = Math.max(0, h / scale - DESIGN.h);
    applyUiAnchors();
  }

  // Which edge a panel belongs to: 0 = left/top, 0.5 = centre, 1 = right/bottom.
  function anchorOf(lo, hi, size) {
    const mid = size / 2;
    if (hi - lo > size * 0.7) return 0.5;
    const c = (lo + hi) / 2;
    if (Math.abs(c - mid) < size * 0.08) return 0.5;
    return c > mid ? 1 : 0;
  }

  function applyUiAnchors() {
    if (!ui.hud) return;
    const items = [];
    for (const group of [ui.hud.uiRenderGroup, ui.hud.uiPlusRenderGroup]) {
      if (!group) continue;
      for (const c of group.children) {
        let st = uiState.get(c);
        const key = `${c.position.x},${c.position.y},${c.scale.x},${c.scale.y},${c.children?.length ?? 0},${c.visible}`;
        if (!st) {
          st = { pivotX: c.pivot.x, pivotY: c.pivot.y };
          uiState.set(c, st);
        }
        if (st.key !== key) {
          // Design-space box: local bounds through the game's position and scale, ignoring our pivot.
          const b = c.getLocalBounds();
          const sx = c.scale.x || 1, sy = c.scale.y || 1;
          const x0 = c.position.x + (b.minX - st.pivotX) * sx;
          const x1 = c.position.x + (b.maxX - st.pivotX) * sx;
          const y0 = c.position.y + (b.minY - st.pivotY) * sy;
          const y1 = c.position.y + (b.maxY - st.pivotY) * sy;
          if (Number.isFinite(x0) && x1 > x0 && y1 > y0) {
            st.box = { x0, x1, y0, y1 };
            st.ax = anchorOf(x0, x1, DESIGN.w);
            st.ay = anchorOf(y0, y1, DESIGN.h);
            st.key = key; // only remember a measurement that found content; empty panels retry next frame
          }
        }
        if (!st.box) continue;
        const shiftX = st.ax * ui.dx, shiftY = st.ay * ui.dy;
        c.pivot.set(st.pivotX - shiftX / (c.scale.x || 1), st.pivotY - shiftY / (c.scale.y || 1));
        if (c.visible) items.push({ ...st.box, shiftX, shiftY });
      }
    }
    ui.items = items;
  }

  // Map a pointer from where things are drawn back to the HUD's design coordinates.
  function uiUnshift(x, y) {
    for (let i = ui.items.length - 1; i >= 0; i--) {
      const it = ui.items[i];
      if (x >= it.x0 + it.shiftX && x <= it.x1 + it.shiftX && y >= it.y0 + it.shiftY && y <= it.y1 + it.shiftY)
        return [x - it.shiftX, y - it.shiftY];
    }
    // Empty space: undo the shift of the zone the point is in.
    const zone = (v, size, d) => (v <= size / 2 ? v : v >= size / 2 + d ? v - d : v - d / 2);
    return [zone(x, DESIGN.w, ui.dx), zone(y, DESIGN.h, ui.dy)];
  }

  let last = 0;
  function tick(now) {
    applyUiAnchors();
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
    registerHud,
    uiResize,
    uiUnshift,
    // Debug: HUD panels as anchored now (design boxes and shifts).
    get uiItems() {
      return { dx: ui.dx, dy: ui.dy, items: ui.items };
    },
    get hud() {
      return ui.hud;
    },
    // Debug: objects currently in the portrait scene (lights only when idle).
    get portraitSceneSize() {
      return portraitStage ? portraitStage.scene.children.length : 0;
    },
    // Debug: render portraits for every unit type and team, returns canvases by key.
    allPortraits(threeClasses) {
      T = T || threeClasses;
      const had = new Set(portraitCache.keys());
      try {
        for (const type of Object.values(UNIT))
          for (const armyAlignment of [0, 1])
            portraitFor({ creatureType: type, armyAlignment, stats: { model_count: 1 } }, () => ({}));
      } finally {
        // Drop the placeholder textures so the HUD still gets real ones later.
        for (const k of [...portraitCache.keys()]) if (!had.has(k)) portraitCache.delete(k);
      }
      return portraitCanvases;
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
    // HUD portrait: a rendered close-up of the 3D soldier, as a HUD texture.
    portraitFor(threeClasses, creature, makeTexture) {
      try {
        T = T || threeClasses;
        return portraitFor(creature, makeTexture);
      } catch (err) {
        console.warn('HOB3D: portrait failed, using painted face', err);
        return null;
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
