// Articulated Voxel Villagers (with Personal-Space Steering, Right-Hand Passing, Bus-Stop Queueing,
// Boarding, Riding & Alighting) and Tactile World Props.

import * as THREE from "three";
import { Vox, buildVoxelMesh, mergeVoxelMeshInstances } from "./vox.js";

const SKIN_TONES = ["#f5cfa8", "#e6b48a", "#c98e63", "#8d5838", "#f7dcc0"];
const PANTS_COLORS = ["#394a6d", "#4b4f59", "#6b4f3a", "#3d6b5e", "#54476e"];

const ISLAND_HALF_EXTENT = 163.5;
const ISLAND_SUPERELLIPSE_EXP = 3.1;

function getIslandInlandMargin(x, z) {
  const ax = Math.abs(x) / ISLAND_HALF_EXTENT;
  const az = Math.abs(z) / ISLAND_HALF_EXTENT;
  const superDist =
    Math.pow(
      Math.pow(ax, ISLAND_SUPERELLIPSE_EXP) + Math.pow(az, ISLAND_SUPERELLIPSE_EXP),
      1 / ISLAND_SUPERELLIPSE_EXP,
    ) * ISLAND_HALF_EXTENT;
  const theta = Math.atan2(z, x);
  const warp =
    9.2 * Math.cos(2 * theta + 1.55) +
    7.8 * Math.sin(3 * theta + 0.75) +
    5.6 * Math.cos(4 * theta + 3.08) +
    4.1 * Math.sin(5 * theta - 0.85) +
    2.6 * Math.cos(7 * theta + 0.4);
  return ISLAND_HALF_EXTENT + warp - superDist;
}

function clampVillagerToIsland(x, z, minMargin = 2.0) {
  if (getIslandInlandMargin(x, z) >= minMargin) return [x, z];
  const r = Math.hypot(x, z);
  if (r < 0.001) return [0, 0];
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) * 0.5;
    if (getIslandInlandMargin(x * mid, z * mid) >= minMargin) lo = mid;
    else hi = mid;
  }
  return [x * lo, z * lo];
}

export function buildVillagerRig(villager, index = 0) {
  const root = new THREE.Group();
  const s = 0.135; // Fine micro-voxel scale (~1.5m tall villager)
  const skin = SKIN_TONES[index % SKIN_TONES.length];
  const pants = PANTS_COLORS[index % PANTS_COLORS.length];
  const shirt = villager.shirtColor || "#4c82d4";
  const hat = villager.hatColor || "#f5b82e";

  // Torso + backpack
  const torsoVox = new Vox(101 + index);
  torsoVox.box(-2, 0, -1, 2, 5, 2, shirt);
  if (villager.role === "student" || villager.role === "explorer") {
    torsoVox.box(-1.5, 1, -2, 1.5, 4, -1, hat);
  }
  const torso = buildVoxelMesh(torsoVox, { scale: s });
  torso.position.y = 4 * s;
  root.add(torso);

  // Head + eyes + hat/cap (slight clearance above torso collar + depthLayer 1)
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 9.06 * s, 0);
  const headVox = new Vox(201 + index);
  headVox.box(-2, 0, -2, 2, 4, 2, skin);
  headVox.put(-1, 1.5, 2, "#181a20");
  headVox.put(1, 1.5, 2, "#181a20");
  // Hat with brim
  headVox.box(-2, 3.5, -2, 2, 5, 2, hat);
  headVox.box(-2, 3.5, 2, 2, 4.2, 3, hat);
  headPivot.add(buildVoxelMesh(headVox, { scale: s, depthLayer: 1 }));
  root.add(headPivot);

  // Left & Right Legs (clean hip gap + depthLayer 2; torso & head cast the villager's ground shadow)
  const makeLeg = (seedOff) => {
    const piv = new THREE.Group();
    const lv = new Vox(301 + index + seedOff);
    lv.box(-1, -4, -1, 1, 0, 1, pants);
    lv.box(-1, -4, 0, 1, -3, 2, "#24272e");
    piv.add(buildVoxelMesh(lv, { scale: s, depthLayer: 2, castShadow: false }));
    return piv;
  };
  const leftLeg = makeLeg(1);
  leftLeg.position.set(1.08 * s, 3.94 * s, 0);
  const rightLeg = makeLeg(2);
  rightLeg.position.set(-1.08 * s, 3.94 * s, 0);
  root.add(leftLeg, rightLeg);

  // Left & Right Arms (clean 1-voxel wide shoulder clearance outside [-2..2] torso + depthLayer 3)
  const makeArm = (seedOff, x0, x1) => {
    const piv = new THREE.Group();
    const av = new Vox(401 + index + seedOff);
    av.box(x0, -3, -1, x1, 0, 1, shirt);
    av.box(x0, -4, -1, x1, -3, 1, skin);
    piv.add(buildVoxelMesh(av, { scale: s, depthLayer: 3, castShadow: false }));
    return piv;
  };
  const leftArm = makeArm(1, 0, 1);
  leftArm.position.set(2.08 * s, 8.6 * s, 0);
  const rightArm = makeArm(2, -1, 0);
  rightArm.position.set(-2.08 * s, 8.6 * s, 0);
  root.add(leftArm, rightArm);

  root.userData.dispose = () => {
    root.traverse((o) => {
      if (o.isMesh && o.geometry) o.geometry.dispose();
    });
  };

  return {
    root,
    headPivot,
    leftLeg,
    rightLeg,
    leftArm,
    rightArm,
  };
}

export class VillagerAgent {
  constructor(data, index) {
    this.id = data.id;
    this.data = data;
    this.index = index;
    this.rig = buildVillagerRig(data, index);
    this.group = this.rig.root;

    // Golden-angle staggered personal queue offset so villagers never target the exact same point
    const qAngle = (index * 2.399963) % (Math.PI * 2);
    const qRadius = 1.55 + (index % 5) * 0.65;
    this.queueOffsetX = Math.cos(qAngle) * qRadius;
    this.queueOffsetZ = Math.sin(qAngle) * qRadius;

    this.x = (data.homeX ?? 0) + this.queueOffsetX;
    this.z = (data.homeZ ?? 0) + this.queueOffsetZ;
    this.yaw = qAngle;
    this.scale = 1.0;

    this.stopIndex = index % Math.max(1, (data.stops || []).length);
    this.state = data.usesTransit ? "WALK_TO_STOP" : "STROLL";
    this.timer = (index * 1.9) % 4.5;
    this.ridingVehicleId = null;
    this.boardedStopId = null;
    this.phase = index * 1.37;
    this.avoidSide = index % 2 === 0 ? 1 : -1;
    this.smoothDirX = Math.sin(this.yaw);
    this.smoothDirZ = Math.cos(this.yaw);
    this.stuckSec = 0;
    this.initialSanitized = false;

    this.group.position.set(this.x, 0, this.z);
  }

  sanitizeTarget(rawX, rawZ) {
    let [tx, tz] = clampVillagerToIsland(rawX, rawZ, 2.2);
    for (let pass = 0; pass < 2; pass++) {
      for (const pond of this.ponds || []) {
        const pr = (pond.radius || 6.4) + 1.15;
        const dx = tx - pond.x;
        const dz = tz - pond.z;
        const d = Math.hypot(dx, dz);
        if (d < pr) {
          const ang = d > 0.01 ? Math.atan2(dz, dx) : (this.index * 2.399) % (Math.PI * 2);
          tx = pond.x + Math.cos(ang) * pr;
          tz = pond.z + Math.sin(ang) * pr;
        }
      }
      for (const obs of this.obstacles || []) {
        const clearR = obs.r + 0.95;
        const dx = tx - obs.x;
        const dz = tz - obs.z;
        const d = Math.hypot(dx, dz);
        if (d < clearR) {
          const ang = d > 0.01 ? Math.atan2(dz, dx) : (this.index * 2.399) % (Math.PI * 2);
          tx = obs.x + Math.cos(ang) * clearR;
          tz = obs.z + Math.sin(ang) * clearR;
        }
      }
      [tx, tz] = clampVillagerToIsland(tx, tz, 2.2);
    }
    return [tx, tz];
  }

  updateFromServer(data) {
    this.data = data;
  }

  step(dt, t, activeVehicles, ponds = [], allVillagers = [], obstacles = []) {
    this.ponds = ponds;
    this.allVillagers = allVillagers;
    this.obstacles = obstacles;
    if (!this.initialSanitized && obstacles.length > 1) {
      const [sx, sz] = this.sanitizeTarget(this.x, this.z);
      this.x = sx;
      this.z = sz;
      this.initialSanitized = true;
    }

    const stops = this.data.stops && this.data.stops.length >= 2 ? this.data.stops : [[this.x, this.z], [0, -16]];
    let movingSpeed = 0;

    if (this.state === "RIDING") {
      const bus = activeVehicles.find((v) => v.id === this.ridingVehicleId);
      if (!bus) {
        this.state = "STROLL";
        this.group.visible = true;
        this.scale = 1.0;
      } else {
        this.x = bus.doorX;
        this.z = bus.doorZ;
        if (bus.dwellingStop && bus.dwellingStop.id !== this.boardedStopId) {
          this.ridingVehicleId = null;
          this.group.visible = true;
          this.scale = 0.25;
          // Step off with slight per-villager fan-out so alighting passengers don't stack
          const [ax, az] = this.sanitizeTarget(
            bus.doorX + this.queueOffsetX * 0.35,
            bus.doorZ + this.queueOffsetZ * 0.35,
          );
          this.x = ax;
          this.z = az;
          this.yaw = bus.yaw + Math.PI / 2;
          this.smoothDirX = Math.sin(this.yaw);
          this.smoothDirZ = Math.cos(this.yaw);
          this.stopIndex = (this.stopIndex + 1) % stops.length;
          this.state = "ALIGHT_VISIT";
          this.timer = 6.5 + (this.index % 4);
        } else {
          this.group.visible = false;
          return;
        }
      }
    }

    if (this.scale < 1.0 && this.state !== "BOARDING") {
      this.scale = Math.min(1.0, this.scale + dt * 3.8);
    }

    if (this.state === "WALK_TO_STOP") {
      const target = stops[this.stopIndex % stops.length];
      const tx = target[0] + this.queueOffsetX;
      const tz = target[1] + this.queueOffsetZ;
      const res = this.walkToward(tx, tz, 2.25, dt, false);
      movingSpeed = res.arrived ? 0 : res.moveRatio;
      if (res.arrived) {
        this.state = "WAIT_FOR_BUS";
        this.timer = 0;
      }
    } else if (this.state === "WAIT_FOR_BUS") {
      this.timer += dt;
      this.rig.headPivot.rotation.y = Math.sin(t * 1.6 + this.phase) * 0.35;

      const nearbyStoppedBus = activeVehicles.find(
        (v) => v.dwellingStop && Math.hypot(v.x - this.x, v.z - this.z) < 8.8,
      );
      if (nearbyStoppedBus) {
        this.ridingVehicleId = nearbyStoppedBus.id;
        this.boardedStopId = nearbyStoppedBus.dwellingStop.id;
        this.state = "BOARDING";
      } else if (this.timer > 20) {
        this.stopIndex = (this.stopIndex + 1) % stops.length;
        this.state = "STROLL";
        this.timer = 4.0 + (this.index % 3);
      }
    } else if (this.state === "BOARDING") {
      const bus = activeVehicles.find((v) => v.id === this.ridingVehicleId);
      if (!bus || !bus.dwellingStop) {
        this.state = "WAIT_FOR_BUS";
        this.scale = 1.0;
      } else {
        const res = this.walkToward(bus.doorX, bus.doorZ, 3.35, dt, true);
        movingSpeed = 1.2 * Math.max(0.35, res.moveRatio);
        if (res.arrived) {
          this.scale = Math.max(0.15, this.scale - dt * 4.5);
          if (this.scale <= 0.2) {
            this.state = "RIDING";
            this.group.visible = false;
            return;
          }
        }
      }
    } else if (this.state === "ALIGHT_VISIT") {
      const visitSpot = stops[this.stopIndex % stops.length];
      const tx = visitSpot[0] + this.queueOffsetX * 1.15;
      const tz = visitSpot[1] + this.queueOffsetZ * 1.15;
      const res = this.walkToward(tx, tz, 2.15, dt, false);
      movingSpeed = res.arrived ? 0 : res.moveRatio;
      if (res.arrived) {
        this.timer -= dt;
        this.rig.headPivot.rotation.y = Math.sin(t * 1.8 + this.phase) * 0.3;
        if (this.timer <= 0) {
          this.stopIndex = (this.stopIndex + 1) % stops.length;
          this.state = this.data.usesTransit ? "WALK_TO_STOP" : "STROLL";
        }
      }
    } else {
      const target = stops[this.stopIndex % stops.length];
      const tx = target[0] + this.queueOffsetX;
      const tz = target[1] + this.queueOffsetZ;
      const res = this.walkToward(tx, tz, 1.9, dt, false);
      movingSpeed = res.arrived ? 0 : 0.85 * res.moveRatio;
      if (res.arrived) {
        this.timer -= dt;
        if (this.timer <= 0) {
          this.stopIndex = (this.stopIndex + 1) % stops.length;
          this.timer = 3.8 + (this.index % 3);
          if (this.data.usesTransit && this.stopIndex === 0) {
            this.state = "WALK_TO_STOP";
          }
        }
      }
    }

    // Enforce hard personal-space separation even while standing/waiting
    if (this.state !== "BOARDING") {
      this.resolveCollisions(dt);
    }

    // Animate gait (swinging limbs + cheerful walk bounce)
    const stride = movingSpeed > 0.08 ? Math.sin(t * 8.5 + this.phase) * 0.62 * movingSpeed : 0;
    const bounce = movingSpeed > 0.08 ? Math.abs(Math.sin(t * 8.5 + this.phase)) * 0.09 * movingSpeed : 0;
    this.rig.leftLeg.rotation.x = stride;
    this.rig.rightLeg.rotation.x = -stride;
    this.rig.leftArm.rotation.x = -stride * 0.8;
    this.rig.rightArm.rotation.x = stride * 0.8;
    if (movingSpeed > 0.08) {
      this.rig.headPivot.rotation.y *= 0.85;
    }

    this.group.position.set(this.x, bounce, this.z);
    this.group.rotation.y = this.yaw;
    this.group.scale.setScalar(this.scale);
  }

  walkToward(rawTx, rawTz, speed, dt, isBoarding = false) {
    const [tx, tz] = isBoarding ? [rawTx, rawTz] : this.sanitizeTarget(rawTx, rawTz);
    const dx = tx - this.x;
    const dz = tz - this.z;
    const dist = Math.hypot(dx, dz);
    const arriveTol = isBoarding ? 0.45 : 0.65;
    if (dist < arriveTol) {
      this.stuckSec = 0;
      return { arrived: true, moveRatio: 0 };
    }

    const goalUx = dx / dist;
    const goalUz = dz / dist;
    let steerX = goalUx;
    let steerZ = goalUz;

    // Social-force personal-space repulsion + right-hand passing rule
    if (!isBoarding && this.allVillagers) {
      for (const other of this.allVillagers) {
        if (other === this || !other.group.visible || other.state === "RIDING") continue;
        const vx = this.x - other.x;
        const vz = this.z - other.z;
        const d = Math.hypot(vx, vz);
        if (d < 3.2 && d > 0.0001) {
          const ux = vx / d;
          const uz = vz / d;
          const prox = (3.2 - d) / 3.2;
          const repel = prox * prox * 1.45;
          const rightPass = prox * 0.85;
          steerX += ux * repel - uz * rightPass;
          steerZ += uz * repel + ux * rightPass;
        }
      }
    }

    // Smoothly skirt around stationary buildings & town signboard with hysteresis (no 60Hz sign-flipping!)
    if (!isBoarding && this.obstacles) {
      for (const obs of this.obstacles) {
        const vx = this.x - obs.x;
        const vz = this.z - obs.z;
        const d = Math.hypot(vx, vz);
        const avoidR = obs.r + 1.55;
        if (d < avoidR && d > 0.001) {
          const ux = vx / d;
          const uz = vz / d;
          const prox = (avoidR - d) / avoidR;
          const t1x = -uz;
          const t1z = ux;
          const dot = t1x * goalUx + t1z * goalUz;
          if (Math.abs(dot) > 0.38 && d > obs.r + 0.35) {
            this.avoidSide = dot >= 0 ? 1 : -1;
          }
          const sign = Math.abs(dot) > 0.55 ? (dot >= 0 ? 1 : -1) : this.avoidSide;
          steerX += ux * prox * 1.25 + t1x * sign * prox * 1.65;
          steerZ += uz * prox * 1.25 + t1z * sign * prox * 1.65;
        }
      }
    }

    const sLen = Math.hypot(steerX, steerZ) || 1;
    steerX /= sLen;
    steerZ /= sLen;

    const prevX = this.x;
    const prevZ = this.z;
    const stepLen = Math.min(dist, speed * dt);
    this.x += steerX * stepLen;
    this.z += steerZ * stepLen;

    this.resolveCollisions(dt, isBoarding);

    const actualDx = this.x - prevX;
    const actualDz = this.z - prevZ;
    const actualMove = Math.hypot(actualDx, actualDz);
    const fwdProgress = actualDx * steerX + actualDz * steerZ;
    const moveRatio =
      stepLen > 1e-4 ? Math.max(0, Math.min(1, Math.max(0, fwdProgress > -0.002 ? actualMove : 0) / stepLen)) : 0;

    // Smooth facing direction without ever snapping to single-frame collision pushback
    const blend = Math.min(1, dt * 7.5);
    this.smoothDirX += (steerX - this.smoothDirX) * blend;
    this.smoothDirZ += (steerZ - this.smoothDirZ) * blend;
    const smLen = Math.hypot(this.smoothDirX, this.smoothDirZ) || 1;
    this.smoothDirX /= smLen;
    this.smoothDirZ /= smLen;

    if (moveRatio > 0.12) {
      const targetYaw = Math.atan2(this.smoothDirX, this.smoothDirZ);
      let diff = targetYaw - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const maxTurn = dt * 5.2;
      this.yaw += Math.max(-maxTurn, Math.min(maxTurn, diff * Math.min(1, dt * 6.5)));
    }

    if (!isBoarding) {
      if (moveRatio < 0.28) {
        this.stuckSec += dt;
        if (this.stuckSec >= 0.65) {
          this.stuckSec = 0;
          this.avoidSide *= -1;
          return { arrived: true, moveRatio: 0 };
        }
      } else {
        this.stuckSec = Math.max(0, this.stuckSec - dt * 1.5);
      }
    }

    const reached = Math.hypot(tx - this.x, tz - this.z) <= arriveTol;
    if (reached) this.stuckSec = 0;
    return { arrived: reached, moveRatio };
  }

  resolveCollisions(dt, isBoarding = false) {
    // Keep on the island plateau
    const [ix, iz] = clampVillagerToIsland(this.x, this.z, 1.8);
    this.x = ix;
    this.z = iz;

    // Keep dry outside ponds
    for (const pond of this.ponds || []) {
      const pr = (pond.radius || 6.4) + 0.9;
      const pdx = this.x - pond.x;
      const pdz = this.z - pond.z;
      const pd = Math.hypot(pdx, pdz);
      if (pd < pr && pd > 0.001) {
        this.x = pond.x + (pdx / pd) * pr;
        this.z = pond.z + (pdz / pd) * pr;
      }
    }

    // Keep outside stationary building footprints & city sign
    if (!isBoarding && this.obstacles) {
      for (const obs of this.obstacles) {
        const odx = this.x - obs.x;
        const odz = this.z - obs.z;
        const od = Math.hypot(odx, odz);
        if (od < obs.r && od > 0.001) {
          this.x = obs.x + (odx / od) * obs.r;
          this.z = obs.z + (odz / od) * obs.r;
        }
      }
    }

    // Non-overlapping personal space between villagers
    if (!isBoarding && this.allVillagers) {
      const minSep = 1.5;
      for (const other of this.allVillagers) {
        if (other === this || !other.group.visible || other.state === "RIDING") continue;
        let dx = this.x - other.x;
        let dz = this.z - other.z;
        let d = Math.hypot(dx, dz);
        if (d < minSep) {
          if (d < 0.001) {
            const ang = (this.index * 2.399) % (Math.PI * 2);
            dx = Math.cos(ang);
            dz = Math.sin(ang);
            d = 1;
          }
          const push = Math.min((minSep - d) * 0.55, dt * 4.5 + 0.08);
          this.x += (dx / d) * push;
          this.z += (dz / d) * push;
        }
      }
    }
  }

  dispose() {
    this.rig.root.userData.dispose?.();
  }
}

const propProtoCache = new Map();
let sharedPondWaterMat = null;

function getSharedPondWaterMaterial() {
  if (!sharedPondWaterMat) {
    sharedPondWaterMat = new THREE.MeshStandardMaterial({
      color: "#4daee0",
      roughness: 0.18,
      metalness: 0.08,
      emissive: new THREE.Color("#1a5b7d"),
      emissiveIntensity: 0.16,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
  }
  return sharedPondWaterMat;
}

function getPondPropProtos(radius) {
  const r = radius || 6.4;
  const ps = 0.32;
  const s = 0.2;
  const gr = Math.round(r / ps);
  const cacheKey = `pond:${gr}`;
  let cached = propProtoCache.get(cacheKey);
  if (!cached) {
    const pondVox = new Vox(77);
    const rimTones = ["limestone", "concrete", "concrete2", "grass2"];
    for (let x = -gr - 3; x <= gr + 3; x++) {
      for (let z = -gr - 3; z <= gr + 3; z++) {
        const d = Math.hypot(x, z);
        if (d >= gr - 0.8 && d <= gr + 2.4) {
          const h = Math.abs((x * 13 + z * 29) % 7);
          const col = d > gr + 1.3 && h < 3 ? "grass2" : rimTones[h % 3];
          pondVox.put(x, 0, z, col);
          if (d >= gr - 0.2 && d <= gr + 1.1 && h % 3 !== 0) {
            pondVox.put(x, 1, z, col);
          }
        }
      }
    }
    const rimMesh = buildVoxelMesh(pondVox, { scale: ps });

    const padVox = new Vox(79);
    const pads = [
      [-r * 0.38, -r * 0.24, true],
      [r * 0.34, r * 0.28, false],
      [-r * 0.14, r * 0.44, true],
      [r * 0.4, -r * 0.18, false],
    ];
    for (const [lx, lz, hasFlower] of pads) {
      const gx = Math.round(lx / s);
      const gz = Math.round(lz / s);
      padVox.cylinderAxis("y", gx, gz, 1, 2, 2.4, "leaf");
      if (hasFlower) {
        padVox.box(gx - 1, 2, gz, gx + 1, 3, gz + 1, "#f598b6");
        padVox.put(gx, 3, gz, "yellow");
      }
    }
    const padMesh = buildVoxelMesh(padVox, { scale: s, castShadow: false });
    const waterR = Math.max(1.2, (gr - 0.85) * ps);
    cached = { rimMesh, padMesh, waterR };
    propProtoCache.set(cacheKey, cached);
  }
  return cached;
}

function getStandardPropProtoMesh(prop) {
  const s = 0.2;
  if (prop.kind === "bus_stop") {
    let m = propProtoCache.get("bus_stop");
    if (!m) {
      const v = new Vox(51);
      v.box(-5, 0, -3, 5, 1, 3, "concrete");
      v.box(-4, 1, -2, -3, 10, -1, "woodDark");
      v.box(3, 1, -2, 4, 10, -1, "woodDark");
      v.box(-3, 2, -2, 3, 9, -1, "glass");
      v.box(-5, 10, -3, 5, 11, 2, "terracotta");
      v.box(-3, 2, -1, 3, 3, 1, "wood");
      v.box(5, 0, 1, 6, 11, 2, "steelDark");
      v.box(4, 10, 1, 7, 13, 2, "busYellow", 0.55);
      v.put(5, 11, 2, "charcoal");
      m = buildVoxelMesh(v, { scale: s });
      propProtoCache.set("bus_stop", m);
    }
    return m;
  }
  if (prop.kind === "lamp_post") {
    let m = propProtoCache.get("lamp_post");
    if (!m) {
      const v = new Vox(61);
      v.box(-1, 0, -1, 2, 2, 2, "iron");
      v.box(0, 2, 0, 1, 13, 1, "iron");
      v.box(0, 12, 0, 3, 13, 1, "iron");
      v.box(2, 10, -0.5, 4, 12, 1.5, "warmGlow", 1.5);
      m = buildVoxelMesh(v, { scale: s });
      propProtoCache.set("lamp_post", m);
    }
    return m;
  }
  if (prop.kind === "bench") {
    let m = propProtoCache.get("bench");
    if (!m) {
      const v = new Vox(71);
      v.box(-4, 0, -1, -3, 3, 2, "iron");
      v.box(3, 0, -1, 4, 3, 2, "iron");
      v.box(-4, 2, -1, 4, 3, 2, "wood");
      v.box(-4, 3, -1, 4, 5, 0, "woodLight");
      m = buildVoxelMesh(v, { scale: s });
      propProtoCache.set("bench", m);
    }
    return m;
  }
  if (prop.kind === "signpost") {
    let m = propProtoCache.get("signpost");
    if (!m) {
      const v = new Vox(81);
      v.box(0, 0, 0, 1, 10, 1, "woodDark");
      v.box(-3, 7, 0, 4, 9, 1, "cream");
      v.box(-1, 5, 0, 5, 6, 1, "wood");
      m = buildVoxelMesh(v, { scale: s });
      propProtoCache.set("signpost", m);
    }
    return m;
  }
  const rawSeed = Math.abs(Math.round((prop.x || 1) * 13 + (prop.z || 1) * 29)) + 91;
  const variant = rawSeed % 8;
  const key = `flower:${variant}`;
  let m = propProtoCache.get(key);
  if (!m) {
    const v = new Vox(91 + variant * 17);
    const blossoms = ["#f6d55c", "#ec8db0", "#fcfaf5", "#ffb642"];
    const b1 = blossoms[variant % blossoms.length];
    const b2 = blossoms[(variant + 1) % blossoms.length];
    v.sphere(0, 1.1, 0, 2.6, 1.4, 2.3, "leaf");
    v.sphere(2.1, 0.9, 1.1, 1.9, 1.2, 1.8, "leafLight");
    v.sphere(-1.8, 0.8, 0.9, 1.6, 1.1, 1.6, "leafDark");
    v.clear(-6, -4, -6, 6, 0, 6);
    v.put(-1, 2, 0, b1);
    v.put(0, 2, 1, b1);
    v.put(2, 2, 1, b2);
    v.put(-2, 1, 1, b2);
    m = buildVoxelMesh(v, { scale: 0.22 });
    propProtoCache.set(key, m);
  }
  return m;
}

/**
 * Batch all static WorldProps into minimal GPU draw calls (1 shadow-casting voxel mesh,
 * 1 non-shadow lilypad mesh, and pond water surfaces) while preserving exact visuals.
 */
export function buildBatchedWorldProps(props, targetGroup) {
  const shadowEntries = [];
  const noShadowEntries = [];

  for (const prop of props || []) {
    const px = prop.x || 0;
    const pz = prop.z || 0;
    const rotY = prop.yaw || 0;
    if (prop.kind === "pond") {
      const { rimMesh, padMesh, waterR } = getPondPropProtos(prop.radius);
      shadowEntries.push({ mesh: rimMesh, x: px, y: 0, z: pz, rotY });
      noShadowEntries.push({ mesh: padMesh, x: px, y: 0.05, z: pz, rotY });

      const waterGeo = new THREE.CylinderGeometry(waterR, waterR, 0.2, 32);
      const water = new THREE.Mesh(waterGeo, getSharedPondWaterMaterial());
      water.position.set(px, 0.11, pz);
      water.rotation.y = rotY;
      water.receiveShadow = true;
      water.matrixAutoUpdate = false;
      water.updateMatrix();
      water.userData.sharedMaterial = true;
      targetGroup.add(water);
    } else {
      const protoMesh = getStandardPropProtoMesh(prop);
      // Tiny low flower tufts don't need 4K shadow-map draw calls; tall props keep crisp shadows
      const casts =
        prop.kind === "bus_stop" ||
        prop.kind === "lamp_post" ||
        prop.kind === "bench" ||
        prop.kind === "signpost";
      if (casts) {
        shadowEntries.push({ mesh: protoMesh, x: px, y: 0, z: pz, rotY });
      } else {
        noShadowEntries.push({ mesh: protoMesh, x: px, y: 0, z: pz, rotY });
      }
    }
  }

  const mergedShadow = mergeVoxelMeshInstances(shadowEntries, {
    depthLayer: 0,
    castShadow: true,
    receiveShadow: true,
  });
  if (mergedShadow) targetGroup.add(mergedShadow);

  const mergedNoShadow = mergeVoxelMeshInstances(noShadowEntries, {
    depthLayer: 0,
    castShadow: false,
    receiveShadow: true,
  });
  if (mergedNoShadow) targetGroup.add(mergedNoShadow);
}

/**
 * Build charming micro-voxel WorldProps (single-prop helper kept for compatibility).
 */
export function buildWorldPropMesh(prop) {
  const group = new THREE.Group();
  if (prop.kind === "pond") {
    const { rimMesh, padMesh, waterR } = getPondPropProtos(prop.radius);
    const rim = rimMesh.clone();
    rim.userData.sharedProto = true;
    group.add(rim);

    const waterGeo = new THREE.CylinderGeometry(waterR, waterR, 0.2, 32);
    const water = new THREE.Mesh(waterGeo, getSharedPondWaterMaterial());
    water.position.y = 0.11;
    water.receiveShadow = true;
    water.userData.sharedMaterial = true;
    group.add(water);

    const pad = padMesh.clone();
    pad.position.y = 0.05;
    pad.userData.sharedProto = true;
    group.add(pad);
  } else {
    const proto = getStandardPropProtoMesh(prop).clone();
    proto.userData.sharedProto = true;
    group.add(proto);
  }

  group.position.set(prop.x, 0, prop.z);
  group.rotation.y = prop.yaw || 0;
  return group;
}
