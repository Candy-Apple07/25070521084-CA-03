// WebGL table built with three.js. The geometry comes straight from the physics table, so the
// cushions, jaws and pockets you see are the ones the balls bounce off.
//
// Coordinates: physics works in millimetres with x along the table and y across it. In the 3D
// scene one unit is a metre, the table is centred on the origin, X runs along the table, Z across
// it and Y is up.

import * as THREE from 'three';
import type { AimPrediction } from '../core/aim';
import type { Ball } from '../core/physics';
import type { AimGuide } from '../core/rules';
import type { TableGeometry } from '../core/table';
import { BALL_COLORS, cueSkin, poolColor, tableTheme, type TableTheme } from './themes';
import type { HandZone } from '../core/table';

const M = 0.001;
const RAIL = 165;
const CUSHION = 46;
const CUSHION_H = 0.037;
const RAIL_TOP = 0.044;
export const MAX_PULL_MM = 300;
const CUE_LEN = 1.45;
const CUE_ELEV = 0.1; // radians the butt is raised

export type CameraMode = 'overview' | 'orbit';

export interface CueDraw {
  x: number; y: number;
  dx: number; dy: number;
  pull: number;
  skin: string;
  alpha: number;
  /** Overrides pull: distance in mm from the tip to the ball (negative = following through). */
  offsetMm?: number;
  spinX?: number;
  spinY?: number;
}

/** A ball on its way into a pocket: where and how fast it was going when it dropped. */
export interface PotAnim { id: number; kind: Ball['kind']; x: number; y: number; vx: number; vy: number; hx: number; hy: number; hr: number; t0: number }

export interface Frame {
  balls: Ball[];
  pots: PotAnim[];
  now: number;
  cue: CueDraw | null;
  guide: { mode: AimGuide; from: { x: number; y: number }; dx: number; dy: number; pred: AimPrediction } | null;
  placing: { valid: boolean; zone: HandZone } | null;
  labels: boolean;
  /** Orientation matrix per ball id. */
  orient: (id: number) => number[];
  /** Balls are rolling (drives trails). */
  moving: boolean;
}

interface Pose { pos: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 }

export class Renderer3D {
  readonly gl: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.05, 50);
  private tableGroup = new THREE.Group();
  private ballGroup = new THREE.Group();
  private guideGroup = new THREE.Group();
  private theme: TableTheme;
  private w = 1;
  private h = 1;
  private pad = { top: 0, right: 0, bottom: 0, left: 0 };
  private portrait = false;
  mode: CameraMode = 'overview';
  private pose: Pose | null = null;
  private overviewPose: Pose | null = null;
  private raycaster = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private lastNow = 0;

  // Reused objects.
  private ballGeo!: THREE.SphereGeometry;
  private ballMeshes = new Map<number, THREE.Mesh>();
  private shadowMeshes = new Map<number, THREE.Mesh>();
  private materials = new Map<string, THREE.MeshPhysicalMaterial>();
  private labelsOn = false;
  private cueMeshes = new Map<string, THREE.Mesh>();
  private ribbons: THREE.Mesh[] = [];
  private ghost!: THREE.Mesh;
  private ghostRing!: THREE.Mesh;
  private dMesh!: THREE.Mesh;
  private placeRing!: THREE.Mesh;
  private shadowTex = blobTexture();
  private glowTex = glowTexture();
  private shake = 0;
  private punch = 0;
  private flashes: Array<{ sprite: THREE.Sprite; t0: number; life: number; size: number }> = [];
  private puffs: Array<{ points: THREE.Points; vel: Float32Array; t0: number; life: number }> = [];
  private trailMats = new Map<string, THREE.MeshBasicMaterial>();
  private trails = new Map<number, THREE.Mesh[]>();
  private fxGroup = new THREE.Group();

  constructor(readonly canvas: HTMLCanvasElement, public table: TableGeometry, themeId: string) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 0.92;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFShadowMap;

    const pmrem = new THREE.PMREMGenerator(this.gl);
    this.scene.environment = pmrem.fromScene(hallEnvironment(), 0.015).texture;
    this.scene.environmentIntensity = 1;
    pmrem.dispose();

    this.theme = tableTheme(themeId);
    this.addLights();
    this.scene.add(this.tableGroup, this.ballGroup, this.guideGroup, this.fxGroup);
    this.buildGuides();
    this.rebuild();
  }

  get rotated() { return this.portrait; }

  dispose() {
    this.gl.dispose();
    this.gl.forceContextLoss();
  }

  setPadding(p: { top: number; right: number; bottom: number; left: number }) {
    this.pad = p;
    this.resize();
  }

  setTable(table: TableGeometry, themeId: string) {
    this.table = table;
    this.theme = tableTheme(themeId);
    this.rebuild();
  }

  setMode(mode: CameraMode) {
    this.mode = mode;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.gl.setSize(this.w, this.h, false);
    this.camera.aspect = this.w / this.h;
    this.camera.updateProjectionMatrix();
    const aw = Math.max(50, this.w - this.pad.left - this.pad.right);
    const ah = Math.max(50, this.h - this.pad.top - this.pad.bottom);
    this.portrait = ah > aw * 1.05;
    this.overviewPose = this.fitOverview(aw, ah);
    if (!this.pose || this.mode === 'overview') this.pose = clonePose(this.overviewPose);
    this.applyPose(this.pose);
  }

  // -------------------------------------------------------------------------------------------
  // Coordinates

  private v(x: number, y: number, h = 0): THREE.Vector3 {
    return new THREE.Vector3((x - this.table.L / 2) * M, h, (y - this.table.W / 2) * M);
  }

  toWorld(px: number, py: number): { x: number; y: number } {
    const ndc = new THREE.Vector2((px / this.w) * 2 - 1, -(py / this.h) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.plane.constant = -this.table.R * M;
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.plane, p)) return { x: this.table.L / 2, y: this.table.W / 2 };
    return { x: p.x / M + this.table.L / 2, y: p.z / M + this.table.W / 2 };
  }

  toScreen(x: number, y: number): { x: number; y: number } {
    const p = this.v(x, y, this.table.R * M).project(this.camera);
    return { x: ((p.x + 1) / 2) * this.w, y: ((1 - p.y) / 2) * this.h };
  }

  // -------------------------------------------------------------------------------------------
  // Camera

  private fitOverview(aw: number, ah: number): Pose {
    const L = (this.table.L + RAIL * 2) * M;
    const W = (this.table.W + RAIL * 2) * M;
    const extW = this.portrait ? W : L;
    const extH = this.portrait ? L : W;
    const s = Math.min(aw / extW, ah / extH) * 0.97;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const H = (this.h / (2 * s * Math.tan(fov / 2))) * 1.02;
    const right = this.portrait ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const up = this.portrait ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, -1);
    const dxp = this.pad.left + aw / 2 - this.w / 2;
    const dyp = this.pad.top + ah / 2 - this.h / 2;
    const target = new THREE.Vector3()
      .addScaledVector(right, -dxp / s)
      .addScaledVector(up, dyp / s);
    // A slight tilt, as if seen from a high gantry at the baulk side, so balls read as spheres.
    const tilt = 0.2;
    const pos = target.clone()
      .addScaledVector(new THREE.Vector3(0, 1, 0), H * Math.cos(tilt))
      .addScaledVector(up, -H * Math.sin(tilt));
    return { pos, target, up };
  }

  private orbitPose(now: number): Pose {
    // A slow drift around the table; the target sits right of centre to leave room for panels.
    const a = Math.sin(now * 0.00005) * 0.9 + Math.PI / 2;
    const narrow = this.w <= 900;
    const r = narrow ? 4.4 : 3.9;
    const right = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
    // Wide screens: nudge the table right, clear of the copy and panels.
    const target = narrow ? new THREE.Vector3() : right.multiplyScalar(-0.38);
    return {
      pos: target.clone().add(new THREE.Vector3(Math.cos(a) * r, 2.1, Math.sin(a) * r)),
      target,
      up: new THREE.Vector3(0, 1, 0),
    };
  }

  private applyPose(p: Pose) {
    this.camera.position.copy(p.pos);
    this.camera.up.copy(p.up);
    this.camera.lookAt(p.target);
    this.camera.updateMatrixWorld();
  }

  private updateCamera(f: Frame) {
    const dt = Math.min(0.1, (f.now - this.lastNow) / 1000 || 0);
    this.lastNow = f.now;
    let want: Pose | null = this.overviewPose;
    if (this.mode === 'orbit') want = this.orbitPose(f.now);
    if (!want || !this.pose) return;
    const k = this.mode === 'orbit' ? 1 : 1 - Math.exp(-dt * 5);
    this.pose.pos.lerp(want.pos, k);
    this.pose.target.lerp(want.target, k);
    this.pose.up.lerp(want.up, k).normalize();
    this.applyPose(this.pose);
    // Impact shake and a small zoom punch.
    if (this.shake > 0.002) {
      const a = this.shake * 0.014;
      this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * a, (Math.random() - 0.5) * a, (Math.random() - 0.5) * a));
      this.camera.updateMatrixWorld();
    }
    this.shake *= Math.exp(-dt * 9);
    if (Math.abs(this.punch) > 0.001) {
      this.camera.fov = 32 - this.punch * 2.2;
      this.camera.updateProjectionMatrix();
      this.punch *= Math.exp(-dt * 7);
    } else if (this.camera.fov !== 32) {
      this.camera.fov = 32;
      this.camera.updateProjectionMatrix();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Impact effects

  /** The cue meets the ball: chalk, shake and a zoom punch scaled by power. */
  strikeFx(x: number, y: number, dx: number, dy: number, power: number) {
    this.shake = Math.min(1.2, this.shake + 0.15 + power * 0.85);
    this.punch = Math.min(1, this.punch + power * 0.9);
    const R = this.table.R;
    const p = this.v(x - dx * R, y - dy * R, R * M);
    this.puff(p, new THREE.Vector3(-dx, 0.35, -dy), 0x6f9fe6, 26 + Math.round(power * 30), 0.25 + power * 0.6, 520);
    this.flash(p, 0.03 + power * 0.05, 140);
  }

  impact(kind: 'ball' | 'cushion' | 'pot', x: number, y: number, speed: number) {
    const R = this.table.R;
    if (kind === 'ball' && speed > 500) {
      const k = Math.min(1, speed / 5000);
      this.flash(this.v(x, y, R * M), 0.02 + k * 0.07, 120 + k * 120);
      this.shake = Math.min(1.2, this.shake + k * k * 0.6);
      if (speed > 2500) this.puff(this.v(x, y, R * M), new THREE.Vector3(0, 0.6, 0), 0xfff4dc, 18, 0.3 + k * 0.4, 380);
    } else if (kind === 'cushion' && speed > 1400) {
      const k = Math.min(1, speed / 5000);
      this.puff(this.v(x, y, 0.004), new THREE.Vector3(0, 0.5, 0), 0xe8dcc4, 12, 0.15 + k * 0.3, 420);
      this.shake = Math.min(1.2, this.shake + k * 0.15);
    } else if (kind === 'pot') {
      this.shake = Math.min(1.2, this.shake + 0.12);
    }
  }

  private flash(at: THREE.Vector3, size: number, life: number) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xfff1d6, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    sprite.position.copy(at);
    sprite.scale.setScalar(size);
    this.fxGroup.add(sprite);
    this.flashes.push({ sprite, t0: performance.now(), life, size });
  }

  private puff(at: THREE.Vector3, dir: THREE.Vector3, color: number, count: number, speed: number, life: number) {
    const pos = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = at.x; pos[i * 3 + 1] = at.y; pos[i * 3 + 2] = at.z;
      const r = () => (Math.random() - 0.5) * 2;
      vel[i * 3] = (dir.x + r() * 0.8) * speed * Math.random();
      vel[i * 3 + 1] = (dir.y + Math.random() * 0.6) * speed * Math.random();
      vel[i * 3 + 2] = (dir.z + r() * 0.8) * speed * Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color, size: 0.007, transparent: true, opacity: 0.9, depthWrite: false, map: this.glowTex, sizeAttenuation: true });
    const points = new THREE.Points(geo, mat);
    this.fxGroup.add(points);
    this.puffs.push({ points, vel, t0: performance.now(), life });
  }

  private updateFx(now: number, dt: number) {
    this.flashes = this.flashes.filter((f) => {
      const k = (now - f.t0) / f.life;
      if (k >= 1) { this.fxGroup.remove(f.sprite); f.sprite.material.dispose(); return false; }
      f.sprite.scale.setScalar(f.size * (1 + k * 1.5));
      f.sprite.material.opacity = (1 - k) * (1 - k);
      return true;
    });
    this.puffs = this.puffs.filter((p) => {
      const k = (now - p.t0) / p.life;
      const mat = p.points.material as THREE.PointsMaterial;
      if (k >= 1) { this.fxGroup.remove(p.points); p.points.geometry.dispose(); mat.dispose(); return false; }
      const pos = p.points.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i] += p.vel[i] * dt;
        arr[i + 1] = Math.max(0.002, arr[i + 1] + p.vel[i + 1] * dt);
        arr[i + 2] += p.vel[i + 2] * dt;
        p.vel[i] *= 0.9; p.vel[i + 1] = p.vel[i + 1] * 0.9 - 0.6 * dt; p.vel[i + 2] *= 0.9;
      }
      pos.needsUpdate = true;
      mat.opacity = 0.9 * (1 - k);
      return true;
    });
  }

  /** Faint ghosts behind fast balls, so speed reads at a glance. */
  private trail(b: Ball, show: boolean) {
    let ghosts = this.trails.get(b.id);
    const speed = Math.hypot(b.vx, b.vy);
    if (!show || speed < 1300) { ghosts?.forEach((g) => (g.visible = false)); return; }
    if (!ghosts) {
      ghosts = [0, 1, 2, 3].map((i) => {
        const key = `${b.kind}${b.n ?? ''}:${i}`;
        let mat = this.trailMats.get(key);
        if (!mat) {
          mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(b.kind === 'pool' ? poolColor(b.n ?? 1) : BALL_COLORS[b.kind].base), transparent: true, depthWrite: false, opacity: 0 });
          this.trailMats.set(key, mat);
        }
        const g = new THREE.Mesh(this.ballGeo, mat);
        this.ballGroup.add(g);
        return g;
      });
      this.trails.set(b.id, ghosts);
    }
    const k = Math.min(1, (speed - 1300) / 3000);
    const R = this.table.R * M;
    ghosts.forEach((g, i) => {
      const t = (i + 1) * 0.012;
      g.visible = true;
      g.position.copy(this.v(b.x - b.vx * t, b.y - b.vy * t, R));
      g.scale.setScalar(1 - i * 0.12);
      (g.material as THREE.MeshBasicMaterial).opacity = [0.32, 0.2, 0.12, 0.06][i] * k;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Scene

  private addLights() {
    this.scene.add(new THREE.HemisphereLight(0xfff0dc, 0x1a120c, 0.25));
    const key = new THREE.DirectionalLight(0xfff1de, 1.1);
    key.position.set(0.25, 5, 0.35);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -2.3; sc.right = 2.3; sc.top = 1.4; sc.bottom = -1.4; sc.near = 1; sc.far = 8;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.01;
    key.shadow.radius = 3;
    this.scene.add(key);
    // Three lamps over the table make the warm pools on the cloth and the highlights on the balls.
    for (const x of [-1.15, 0, 1.15]) {
      const s = new THREE.SpotLight(0xffe2b8, 3.2, 4, 0.95, 0.9, 1.5);
      s.position.set(x, 1.35, 0);
      s.target.position.set(x, 0, 0);
      this.scene.add(s, s.target);
    }
  }

  private rebuild() {
    for (const o of [...this.tableGroup.children]) disposeTree(o);
    this.tableGroup.clear();
    for (const m of this.ballMeshes.values()) this.ballGroup.remove(m);
    for (const m of this.shadowMeshes.values()) this.ballGroup.remove(m);
    this.ballMeshes.clear();
    this.shadowMeshes.clear();
    this.ballGeo?.dispose();
    this.ballGeo = new THREE.SphereGeometry(this.table.R * M, 48, 32);
    this.buildTable();
    this.buildDAndRing();
    this.resize();
  }

  private buildTable() {
    const t = this.table;
    const th = this.theme;
    const g = this.tableGroup;
    const L = t.L, W = t.W;
    const sx = (x: number) => (x - L / 2) * M;
    const sy = (y: number) => (y - W / 2) * M;

    // ---- Bed: slate and cloth, with the pocket holes cut through.
    const bedShape = new THREE.Shape();
    const e = RAIL - 20;
    bedShape.moveTo(sx(-e), sy(-e));
    bedShape.lineTo(sx(L + e), sy(-e));
    bedShape.lineTo(sx(L + e), sy(W + e));
    bedShape.lineTo(sx(-e), sy(W + e));
    bedShape.closePath();
    for (const pk of t.pockets) {
      const hole = new THREE.Path();
      hole.absarc(sx(pk.hx), sy(pk.hy), pk.hr * M, 0, Math.PI * 2, true);
      bedShape.holes.push(hole);
    }
    const clothTex = clothTexture(t, th);
    const x0 = sx(-CUSHION), y0 = sy(-CUSHION), cw = (L + 2 * CUSHION) * M, ch = (W + 2 * CUSHION) * M;
    clothTex.repeat.set(1 / cw, 1 / ch);
    clothTex.offset.set(-x0 / cw, -y0 / ch);
    const bed = new THREE.Mesh(flat(bedShape, 0.03), new THREE.MeshStandardMaterial({ map: clothTex, roughness: 0.93, metalness: 0 }));
    bed.receiveShadow = true;
    g.add(bed);

    // ---- Cushions: one prism per cushion, its ends cut along the jaws.
    const cushionMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(th.cushion), roughness: 0.9 });
    const cushions = t.segments.slice(0, 6);
    const jaws = t.segments.slice(6);
    for (const c of cushions) {
      const ex = c.bx - c.ax, ey = c.by - c.ay;
      const len = Math.hypot(ex, ey);
      // Outward normal points away from the playing area.
      let nx = -ey / len, ny = ex / len;
      const midX = (c.ax + c.bx) / 2, midY = (c.ay + c.by) / 2;
      if ((L / 2 - midX) * nx + (W / 2 - midY) * ny > 0) { nx = -nx; ny = -ny; }
      const endFor = (px: number, py: number) => {
        const j = jaws.find((s) => Math.abs(s.ax - px) < 0.01 && Math.abs(s.ay - py) < 0.01);
        let jx = nx, jy = ny;
        if (j) {
          const jl = Math.hypot(j.bx - j.ax, j.by - j.ay);
          jx = (j.bx - j.ax) / jl; jy = (j.by - j.ay) / jl;
        }
        const k = CUSHION / (jx * nx + jy * ny);
        return [px + jx * k, py + jy * k];
      };
      const [a2x, a2y] = endFor(c.ax, c.ay);
      const [b2x, b2y] = endFor(c.bx, c.by);
      const shape = new THREE.Shape();
      shape.moveTo(sx(c.ax), sy(c.ay));
      shape.lineTo(sx(c.bx), sy(c.by));
      shape.lineTo(sx(b2x), sy(b2y));
      shape.lineTo(sx(a2x), sy(a2y));
      shape.closePath();
      const mesh = new THREE.Mesh(flat(shape, CUSHION_H, 0.0035), cushionMat);
      mesh.position.y = CUSHION_H;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
    }

    // ---- Wooden rail: a rounded frame whose inner edge bulges around each pocket.
    const outer = new THREE.Shape();
    roundedRect(outer, sx(-RAIL), sy(-RAIL), (L + RAIL * 2) * M, (W + RAIL * 2) * M, 0.07);
    outer.holes.push(innerRailPath(t, sx, sy));
    const woodTex = woodTexture(th);
    woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping;
    woodTex.repeat.set(0.6, 4);
    const railMat = new THREE.MeshPhysicalMaterial({ map: woodTex, roughness: 0.5, clearcoat: 0.45, clearcoatRoughness: 0.35, envMapIntensity: 0.35 });
    const rail = new THREE.Mesh(flat(outer, 0.13, 0.009), railMat);
    rail.position.y = RAIL_TOP;
    rail.castShadow = true;
    rail.receiveShadow = true;
    g.add(rail);

    // Apron under the rail.
    const apronMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(th.railDark), roughness: 0.6 });
    const apron = new THREE.Mesh(new THREE.BoxGeometry((L + RAIL * 2 - 30) * M, 0.2, (W + RAIL * 2 - 30) * M), apronMat);
    apron.position.y = -0.19;
    g.add(apron);

    // ---- Pockets: leather cups, and metal plates on the rail.
    const cupMat = new THREE.MeshStandardMaterial({ color: 0x0b0806, roughness: 1, side: THREE.DoubleSide });
    const plateMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(th.trim).multiplyScalar(0.75), metalness: 0.7, roughness: 0.55, envMapIntensity: 0.3 });
    for (const pk of t.pockets) {
      const r = pk.hr * M;
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.9, 0.16, 40, 1, true), cupMat);
      cup.position.set(sx(pk.hx), -0.08, sy(pk.hy));
      g.add(cup);
      const bottom = new THREE.Mesh(new THREE.CircleGeometry(r, 40), new THREE.MeshBasicMaterial({ color: 0x000000 }));
      bottom.rotation.x = -Math.PI / 2;
      bottom.position.set(sx(pk.hx), -0.07, sy(pk.hy));
      g.add(bottom);
      // Plate arc centred on the pocket's outward direction.
      const out = Math.atan2(pk.ny, pk.nx);
      const span = pk.nx !== 0 && pk.ny !== 0 ? 2.5 : 2.1;
      const ring = new THREE.RingGeometry(r + 0.003, r + 0.034, 40, 1, -out - span / 2, span);
      ring.rotateX(-Math.PI / 2);
      const plate = new THREE.Mesh(ring, plateMat);
      plate.position.set(sx(pk.hx), RAIL_TOP + 0.0095, sy(pk.hy));
      g.add(plate);
    }

    // Pool tables carry diamond sights inlaid in the rails.
    if (t.game === 'pool8') {
      const pearl = new THREE.MeshStandardMaterial({ color: 0xf4efe4, roughness: 0.3, metalness: 0.1 });
      const dot = new THREE.CircleGeometry(0.0075, 20).rotateX(-Math.PI / 2).scale(1, 1, 0.55);
      const mid = (RAIL + CUSHION) / 2;
      const at = (x: number, y: number, along: boolean) => {
        const d = new THREE.Mesh(dot, pearl);
        d.position.set(sx(x), RAIL_TOP + 0.0096, sy(y));
        if (!along) d.rotation.y = Math.PI / 2;
        g.add(d);
      };
      for (let i = 1; i < 8; i++) {
        if (i === 4) continue;
        at((L * i) / 8, -mid, true);
        at((L * i) / 8, W + mid, true);
      }
      for (let j = 1; j < 4; j++) {
        at(-mid, (W * j) / 4, false);
        at(L + mid, (W * j) / 4, false);
      }
    }

    // Soft shadow of the whole table on the floor (seen in tilted views).
    const floorShadow = new THREE.Mesh(
      new THREE.PlaneGeometry((L + 900) * M, (W + 900) * M),
      new THREE.MeshBasicMaterial({ map: this.shadowTex, transparent: true, opacity: 0.75, depthWrite: false }),
    );
    floorShadow.rotation.x = -Math.PI / 2;
    floorShadow.position.y = -0.3;
    g.add(floorShadow);
  }

  private buildGuides() {
    const mk = (color: number, opacity: number, dashed: boolean) => {
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.rotateX(-Math.PI / 2);
      geo.translate(0.5, 0, 0);
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, depthWrite: false,
        map: dashed ? dashTexture() : null,
      });
      if (mat.map) mat.map.wrapS = THREE.RepeatWrapping;
      const m = new THREE.Mesh(geo, mat);
      m.renderOrder = 2;
      m.visible = false;
      this.guideGroup.add(m);
      return m;
    };
    this.ribbons = [mk(0xffffff, 0.8, true), mk(0xffffff, 0.9, false), mk(0x9fd0ff, 0.75, true)];
    this.ghost = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false }));
    this.ghostRing = new THREE.Mesh(new THREE.RingGeometry(0.92, 1.04, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }));
    this.guideGroup.add(this.ghost, this.ghostRing);
  }

  private buildDAndRing() {
    if (this.dMesh) { this.guideGroup.remove(this.dMesh); this.dMesh.geometry.dispose(); }
    if (this.placeRing) { this.guideGroup.remove(this.placeRing); this.placeRing.geometry.dispose(); }
    const t = this.table;
    const shape = new THREE.Shape();
    if (t.game === 'pool8') {
      // The kitchen: everything behind the head string.
      const x0 = -t.L / 2 * M, x1 = (t.baulkX - t.L / 2) * M, y0 = -t.W / 2 * M, y1 = t.W / 2 * M;
      shape.moveTo(x0, y0); shape.lineTo(x1, y0); shape.lineTo(x1, y1); shape.lineTo(x0, y1); shape.closePath();
    } else {
      const cx = (t.dCenter.x - t.L / 2) * M, cy = (t.dCenter.y - t.W / 2) * M;
      shape.moveTo(cx, cy - t.dRadius * M);
      shape.absarc(cx, cy, t.dRadius * M, -Math.PI / 2, Math.PI / 2, true);
      shape.closePath();
    }
    const geo = new THREE.ShapeGeometry(shape, 32);
    geo.rotateX(Math.PI / 2);
    this.dMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide }));
    this.dMesh.position.y = 0.0008;
    this.dMesh.visible = false;
    const R = t.R * M;
    this.placeRing = new THREE.Mesh(new THREE.RingGeometry(R * 1.45, R * 1.7, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }));
    this.placeRing.visible = false;
    this.guideGroup.add(this.dMesh, this.placeRing);
  }

  // -------------------------------------------------------------------------------------------
  // Balls and cue

  private materialFor(b: Ball, labels: boolean): THREE.MeshPhysicalMaterial {
    const kind = b.kind;
    const key = kind === 'pool' ? `pool:${b.n}` : `${kind}:${labels && kind !== 'cue' ? 1 : 0}`;
    let m = this.materials.get(key);
    if (!m) {
      const c = BALL_COLORS[kind === 'pool' ? 'black' : kind];
      const map = kind === 'pool' ? poolBallTexture(b.n ?? 1) : kind === 'cue' ? cueBallTexture() : labels ? labelTexture(c.base, c.label, c.ink) : null;
      m = new THREE.MeshPhysicalMaterial({
        color: map ? 0xffffff : new THREE.Color(c.base),
        map,
        roughness: 0.22,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.02,
        specularIntensity: 0.6,
      });
      this.materials.set(key, m);
    }
    return m;
  }

  private ballMesh(b: Ball, labels: boolean): THREE.Mesh {
    let mesh = this.ballMeshes.get(b.id);
    if (!mesh) {
      mesh = new THREE.Mesh(this.ballGeo, this.materialFor(b, labels));
      mesh.castShadow = true;
      mesh.matrixAutoUpdate = false;
      this.ballGroup.add(mesh);
      this.ballMeshes.set(b.id, mesh);
      const R = this.table.R * M;
      const sh = new THREE.Mesh(new THREE.PlaneGeometry(R * 3.4, R * 3.4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: this.shadowTex, transparent: true, opacity: 0.6, depthWrite: false }));
      sh.renderOrder = 1;
      this.ballGroup.add(sh);
      this.shadowMeshes.set(b.id, sh);
    }
    if (labels !== this.labelsOn) mesh.material = this.materialFor(b, labels);
    return mesh;
  }

  private placeBall(mesh: THREE.Mesh, x: number, y: number, h: number, o: number[], scale = 1) {
    // Physics frame (x, y, z-down) to scene frame (X, Z, -Y).
    const m = new THREE.Matrix4().set(
      o[0], -o[2], o[1], 0,
      -o[6], o[8], -o[7], 0,
      o[3], -o[5], o[4], 0,
      0, 0, 0, 1,
    );
    m.scale(new THREE.Vector3(scale, scale, scale));
    const p = this.v(x, y, h);
    m.setPosition(p);
    mesh.matrix.copy(m);
    mesh.matrixWorldNeedsUpdate = true;
  }

  private cueMesh(skin: string): THREE.Mesh {
    let mesh = this.cueMeshes.get(skin);
    if (!mesh) {
      const geo = new THREE.CylinderGeometry(0.0056, 0.0148, CUE_LEN, 28, 1);
      const mat = new THREE.MeshPhysicalMaterial({ map: cueTexture(skin), roughness: 0.32, clearcoat: 0.7, clearcoatRoughness: 0.2 });
      const s = cueSkin(skin);
      if (s.glow) { mat.emissive = new THREE.Color(s.glow); mat.emissiveIntensity = 0.25; mat.emissiveMap = mat.map; }
      mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.visible = false;
      this.scene.add(mesh);
      this.cueMeshes.set(skin, mesh);
    }
    return mesh;
  }

  private placeCue(c: CueDraw) {
    const mesh = this.cueMesh(c.skin);
    mesh.visible = true;
    const mat = mesh.material as THREE.MeshPhysicalMaterial;
    mat.transparent = c.alpha < 1;
    mat.opacity = c.alpha;
    const R = this.table.R;
    const back = c.offsetMm !== undefined ? c.offsetMm : 8 + c.pull * MAX_PULL_MM;
    const gap = back * M;
    const d = new THREE.Vector3(c.dx, 0, c.dy).normalize();
    const side = new THREE.Vector3(-d.z, 0, d.x);
    // Tip touches where the spin control says, on the back of the ball.
    const contact = this.v(c.x, c.y, R * M)
      .addScaledVector(d, -R * M)
      .addScaledVector(side, (c.spinX ?? 0) * R * M * 0.5)
      .add(new THREE.Vector3(0, (c.spinY ?? 0) * R * M * 0.5, 0));
    const axis = new THREE.Vector3(d.x * Math.cos(CUE_ELEV), -Math.sin(CUE_ELEV), d.z * Math.cos(CUE_ELEV)).normalize();
    const tip = contact.addScaledVector(axis, -gap);
    const center = tip.clone().addScaledVector(axis, -CUE_LEN / 2);
    mesh.position.copy(center);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  }

  private ribbon(i: number, x0: number, y0: number, x1: number, y1: number, width: number) {
    const r = this.ribbons[i];
    const a = this.v(x0, y0, 0.0012), b = this.v(x1, y1, 0.0012);
    const len = a.distanceTo(b);
    if (len < 0.002) { r.visible = false; return; }
    r.visible = true;
    r.position.copy(a);
    r.rotation.set(0, -Math.atan2(b.z - a.z, b.x - a.x), 0);
    r.scale.set(len, 1, width * M);
    const map = (r.material as THREE.MeshBasicMaterial).map;
    if (map) map.repeat.set(len / 0.04, 1);
  }

  // -------------------------------------------------------------------------------------------

  draw(f: Frame) {
    const R = this.table.R;
    const seen = new Set<number>();
    for (const b of f.balls) {
      const mesh = this.ballMesh(b, f.labels);
      const sh = this.shadowMeshes.get(b.id)!;
      seen.add(b.id);
      this.trail(b, b.on && f.moving);
      if (b.on) {
        mesh.visible = true;
        sh.visible = true;
        this.placeBall(mesh, b.x, b.y, R * M, f.orient(b.id));
        sh.position.copy(this.v(b.x + R * 0.12, b.y + R * 0.18, 0.0006));
        (sh.material as THREE.MeshBasicMaterial).opacity = 0.6;
        continue;
      }
      const pot = f.pots.find((p) => p.id === b.id);
      const s = pot ? potPath(pot, (f.now - pot.t0) / 1000, R) : null;
      if (s) {
        // Keep going the way it was going, curl into the middle of the hole and fall.
        mesh.visible = true;
        this.placeBall(mesh, s.x, s.y, (R + s.drop) * M, f.orient(b.id));
        sh.visible = s.drop > -R;
        sh.position.copy(this.v(s.x + R * 0.12, s.y + R * 0.18, 0.0006));
        (sh.material as THREE.MeshBasicMaterial).opacity = 0.6 * Math.max(0, 1 + s.drop / R);
      } else {
        mesh.visible = false;
        sh.visible = false;
      }
    }
    for (const [id, m] of this.ballMeshes) if (!seen.has(id)) { m.visible = false; this.shadowMeshes.get(id)!.visible = false; }
    this.labelsOn = f.labels;

    for (const m of this.cueMeshes.values()) m.visible = false;
    if (f.cue) this.placeCue(f.cue);

    // Guide.
    for (const r of this.ribbons) r.visible = false;
    this.ghost.visible = false;
    this.ghostRing.visible = false;
    if (f.guide && f.guide.mode !== 'off') {
      const g = f.guide, p = g.pred;
      const endX = p.kind === 'none' ? g.from.x + g.dx * 1200 : p.gx - g.dx * R;
      const endY = p.kind === 'none' ? g.from.y + g.dy * 1200 : p.gy - g.dy * R;
      this.ribbon(0, g.from.x + g.dx * R, g.from.y + g.dy * R, endX, endY, 3.5);
      if (g.mode !== 'line' && p.kind !== 'none') {
        this.ghost.visible = true;
        this.ghost.position.copy(this.v(p.gx, p.gy, R * M));
        this.ghost.scale.setScalar(R * M);
        this.ghostRing.visible = true;
        this.ghostRing.position.copy(this.v(p.gx, p.gy, 0.0014));
        this.ghostRing.scale.setScalar(R * M);
      }
      if (g.mode === 'full' && p.kind === 'ball' && p.ballId !== null) {
        const ob = f.balls[p.ballId];
        // Short stubs: enough to read the angle, not enough to aim the whole shot for you.
        const len = 70 + 190 * Math.max(0, p.fullness);
        this.ribbon(1, ob.x + p.ox * R, ob.y + p.oy * R, ob.x + p.ox * (R + len), ob.y + p.oy * (R + len), 4.5);
        if (p.cx || p.cy) {
          const cl = 50 + 120 * (1 - Math.max(0, p.fullness));
          this.ribbon(2, p.gx, p.gy, p.gx + p.cx * cl, p.gy + p.cy * cl, 3.5);
        }
      } else if (g.mode === 'full' && p.kind === 'cushion') {
        this.ribbon(2, p.gx, p.gy, p.gx + p.cx * 150, p.gy + p.cy * 150, 3.5);
      }
    }

    this.dMesh.visible = !!f.placing && f.placing.zone !== 'table';
    this.placeRing.visible = !!f.placing;
    if (f.placing) {
      const ok = f.placing.valid;
      (this.dMesh.material as THREE.MeshBasicMaterial).color.set(ok ? 0xffffff : 0xff6655);
      (this.placeRing.material as THREE.MeshBasicMaterial).color.set(ok ? 0xffffff : 0xff6655);
      const c = f.balls[0];
      this.placeRing.position.copy(this.v(c.x, c.y, 0.0015));
    }

    const dtFx = Math.min(0.1, (f.now - this.lastNow) / 1000 || 0);
    this.updateCamera(f);
    this.updateFx(f.now, dtFx);
    this.gl.render(this.scene, this.camera);
  }
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers

function flat(shape: THREE.Shape, depth: number, bevel = 0): THREE.ExtrudeGeometry {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 40,
  });
  // Lay the shape on the table: shape (x, y) -> scene (X, Z), extruded downwards.
  geo.rotateX(Math.PI / 2);
  return geo;
}

function roundedRect(s: THREE.Shape | THREE.Path, x: number, y: number, w: number, h: number, r: number) {
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
}

/** The rail's inner edge: the cushion backs, swelling outwards around every pocket hole. */
function innerRailPath(t: TableGeometry, sx: (x: number) => number, sy: (y: number) => number): THREE.Path {
  const L = t.L, W = t.W, c = CUSHION;
  // Walk the rectangle [-c, L+c] x [-c, W+c] clockwise (in screen terms) and detour around holes.
  const corners = [[-c, -c], [L + c, -c], [L + c, W + c], [-c, W + c]];
  const pts: Array<[number, number]> = [];
  const pushArc = (pk: TableGeometry['pockets'][number], from: [number, number], to: [number, number]) => {
    const a0 = Math.atan2(from[1] - pk.hy, from[0] - pk.hx);
    let a1 = Math.atan2(to[1] - pk.hy, to[0] - pk.hx);
    const outA = Math.atan2(pk.ny, pk.nx);
    // Choose the direction that passes through the outward side of the hole.
    const norm = (a: number) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const ccwSpan = norm(a1 - a0);
    const outFromA0 = norm(outA - a0);
    if (outFromA0 > ccwSpan) a1 = a0 - norm(a0 - a1);
    else a1 = a0 + ccwSpan;
    for (let i = 0; i <= 24; i++) {
      const a = a0 + ((a1 - a0) * i) / 24;
      pts.push([pk.hx + Math.cos(a) * pk.hr, pk.hy + Math.sin(a) * pk.hr]);
    }
  };
  const hits = (pk: TableGeometry['pockets'][number], ax: number, ay: number, bx: number, by: number) => {
    // Intersections of the circle with an axis-aligned edge, ordered from a to b.
    const out: Array<[number, number]> = [];
    if (ay === by) {
      const d = pk.hr * pk.hr - (ay - pk.hy) * (ay - pk.hy);
      if (d <= 0) return out;
      const r = Math.sqrt(d);
      for (const x of [pk.hx - r, pk.hx + r]) if ((x - ax) * (x - bx) <= 0) out.push([x, ay]);
      out.sort((p, q) => Math.abs(p[0] - ax) - Math.abs(q[0] - ax));
    } else {
      const d = pk.hr * pk.hr - (ax - pk.hx) * (ax - pk.hx);
      if (d <= 0) return out;
      const r = Math.sqrt(d);
      for (const y of [pk.hy - r, pk.hy + r]) if ((y - ay) * (y - by) <= 0) out.push([ax, y]);
      out.sort((p, q) => Math.abs(p[1] - ay) - Math.abs(q[1] - ay));
    }
    return out;
  };
  // Corner pockets swallow the rectangle's corners, so start from the first exit point.
  for (let e = 0; e < 4; e++) {
    const [ax, ay] = corners[e];
    const [bx, by] = corners[(e + 1) % 4];
    // Holes touching this edge, ordered along the edge.
    const events: Array<{ pk: TableGeometry['pockets'][number]; p: [number, number]; enter: boolean }> = [];
    for (const pk of t.pockets) {
      const h = hits(pk, ax, ay, bx, by);
      const startInside = (ax - pk.hx) ** 2 + (ay - pk.hy) ** 2 < pk.hr * pk.hr;
      const endInside = (bx - pk.hx) ** 2 + (by - pk.hy) ** 2 < pk.hr * pk.hr;
      if (startInside && h.length === 1) events.push({ pk, p: h[0], enter: false });
      else if (endInside && h.length === 1) events.push({ pk, p: h[0], enter: true });
      else if (h.length === 2) { events.push({ pk, p: h[0], enter: true }, { pk, p: h[1], enter: false }); }
    }
    events.sort((p, q) => Math.hypot(p.p[0] - ax, p.p[1] - ay) - Math.hypot(q.p[0] - ax, q.p[1] - ay));
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev.enter) { pts.push(ev.p); continue; }
      // Entering a hole: find where we leave it (same edge or the next edge for corners).
      const exit = events.slice(i + 1).find((x) => x.pk === ev.pk && !x.enter);
      if (exit) {
        pushArc(ev.pk, ev.p, exit.p);
        i = events.indexOf(exit);
      } else {
        // Corner: the exit is on the next edge.
        const [cx2, cy2] = corners[(e + 1) % 4];
        const [dx2, dy2] = corners[(e + 2) % 4];
        const nh = hits(ev.pk, cx2, cy2, dx2, dy2);
        if (nh.length) pushArc(ev.pk, ev.p, nh[0]);
      }
    }
  }
  const path = new THREE.Path();
  pts.forEach(([x, y], i) => (i === 0 ? path.moveTo(sx(x), sy(y)) : path.lineTo(sx(x), sy(y))));
  path.closePath();
  return path;
}

/** A dark hall with three glowing lamp canopies: gives every ball one soft TV-style highlight. */
function hallEnvironment(): THREE.Scene {
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(new THREE.BoxGeometry(14, 7, 14), new THREE.MeshBasicMaterial({ color: 0x150e0a, side: THREE.BackSide })));
  const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.9, 0.75).multiplyScalar(5), side: THREE.DoubleSide });
  for (const x of [-1.2, 0, 1.2]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55), lamp);
    p.rotation.x = Math.PI / 2;
    p.position.set(x, 2.2, 0);
    env.add(p);
  }
  // Faint warm walls so the dark side of a ball isn't dead black.
  const wall = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 0.22, 0.14), side: THREE.DoubleSide });
  for (const [x, z, ry] of [[0, -6, 0], [0, 6, 0], [-6, 0, Math.PI / 2], [6, 0, Math.PI / 2]] as const) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(10, 1.2), wall);
    p.position.set(x, 1.2, z);
    p.rotation.y = ry;
    env.add(p);
  }
  return env;
}

/**
 * Where a potted ball is `t` seconds after it dropped. Horizontally it carries its speed, damped
 * towards the centre of the hole (a critically damped spring, so there is no snap or overshoot).
 * Vertically it starts falling once it is over the hole. Returns null once it is out of sight.
 */
function potPath(p: PotAnim, t: number, R: number): { x: number; y: number; drop: number } | null {
  if (t < 0) t = 0;
  const w = 16;
  const e = Math.exp(-w * t);
  const ax = p.x - p.hx, ay = p.y - p.hy;
  const bx = p.vx + w * ax, by = p.vy + w * ay;
  const x = p.hx + (ax + bx * t) * e;
  const y = p.hy + (ay + by * t) * e;
  // Over the lip: fall under gravity (mm/s^2) after the tiniest roll over the edge.
  const fallT = Math.max(0, t - 0.025);
  const drop = -0.5 * 9810 * fallT * fallT;
  if (drop < -R * 5 || t > 1.2) return null;
  return { x, y, drop };
}

function disposeTree(o: THREE.Object3D) {
  o.traverse((n) => {
    const mesh = n as THREE.Mesh;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats) {
      (m as THREE.MeshStandardMaterial).map?.dispose();
      m.dispose();
    }
  });
}

function clonePose(p: Pose): Pose {
  return { pos: p.pos.clone(), target: p.target.clone(), up: p.up.clone() };
}

// ---------------------------------------------------------------------------------------------
// Procedural textures

function canvasTex(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function clothTexture(t: TableGeometry, th: TableTheme): THREE.CanvasTexture {
  const W = 2048, H = Math.round(2048 * ((t.W + 2 * CUSHION) / (t.L + 2 * CUSHION)));
  const tex = canvasTex(W, H, (ctx) => {
    const s = W / (t.L + 2 * CUSHION);
    const X = (x: number) => (x + CUSHION) * s;
    const Y = (y: number) => (y + CUSHION) * s;
    ctx.fillStyle = th.cloth;
    ctx.fillRect(0, 0, W, H);
    // Gentle brightening in the middle where the cloth is brushed towards the black.
    const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.6);
    g.addColorStop(0, hexA(th.clothLight, 0.35));
    g.addColorStop(1, hexA(th.clothLight, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // Nap.
    const rnd = mulberry(5);
    for (let i = 0; i < 26000; i++) {
      ctx.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.04)';
      ctx.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 4, 1);
    }
    // Markings.
    ctx.strokeStyle = th.lines;
    ctx.fillStyle = th.lines;
    ctx.lineWidth = 2.2 * s * 1.2;
    if (t.game === 'pool8') {
      // Head and foot spots, and a faint head string.
      for (const p of [t.footSpot, { x: t.baulkX, y: t.W / 2 }]) {
        ctx.beginPath();
        ctx.arc(X(p.x), Y(p.y), 6 * s, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(X(t.baulkX), Y(0));
      ctx.lineTo(X(t.baulkX), Y(t.W));
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }
    ctx.beginPath();
    ctx.moveTo(X(t.baulkX), Y(0));
    ctx.lineTo(X(t.baulkX), Y(t.W));
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(X(t.dCenter.x), Y(t.dCenter.y), t.dRadius * s, Math.PI / 2, (Math.PI * 3) / 2);
    ctx.stroke();
    ctx.fillStyle = th.lines;
    for (const p of Object.values(t.spots)) {
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), 4.5 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  tex.flipY = false;
  return tex;
}

function woodTexture(th: TableTheme): THREE.CanvasTexture {
  return canvasTex(512, 1024, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 512, 0);
    g.addColorStop(0, th.railDark);
    g.addColorStop(0.5, th.rail);
    g.addColorStop(1, th.railDark);
    ctx.fillStyle = th.rail;
    ctx.fillRect(0, 0, 512, 1024);
    const rnd = mulberry(11);
    for (let i = 0; i < 220; i++) {
      const x = rnd() * 512;
      const w = 1 + rnd() * 5;
      const dark = rnd() < 0.6;
      ctx.strokeStyle = dark ? `rgba(0,0,0,${0.05 + rnd() * 0.16})` : `${hexA(th.railLight, 0.08 + rnd() * 0.2)}`;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      for (let y = 0; y <= 1024; y += 32) ctx.lineTo(x + Math.sin(y / (60 + rnd() * 40) + i) * (3 + rnd() * 6), y);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 1024);
  });
}

function cueBallTexture(): THREE.CanvasTexture {
  return canvasTex(512, 256, (ctx) => {
    ctx.fillStyle = '#f4eedf';
    ctx.fillRect(0, 0, 512, 256);
    ctx.fillStyle = '#c4232a';
    // Six spots on the axes of an equirectangular map: four round the equator and the poles.
    for (const u of [0, 128, 256, 384, 512]) {
      ctx.beginPath();
      ctx.ellipse(u, 128, 17, 17, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillRect(0, 0, 512, 11);
    ctx.fillRect(0, 245, 512, 11);
  });
}

/** A pool ball: solid colour, or white with a coloured band (9-15), and its number in a white disc. */
function poolBallTexture(n: number): THREE.CanvasTexture {
  const color = poolColor(n);
  const stripe = n > 8;
  return canvasTex(1024, 512, (ctx) => {
    ctx.fillStyle = stripe ? '#f6f1e6' : color;
    ctx.fillRect(0, 0, 1024, 512);
    if (stripe) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 512 * 0.3, 1024, 512 * 0.4);
    }
    for (const u of [256, 768]) {
      ctx.fillStyle = '#f8f5ee';
      ctx.beginPath();
      ctx.ellipse(u, 256, 62, 62, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#141414';
      ctx.font = `800 ${n > 9 ? 64 : 76}px Inter, Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(n), u, 262);
      if (n === 6 || n === 9) ctx.fillRect(u - 18, 300, 36, 6);
    }
  });
}

function labelTexture(base: string, label: string, ink: string): THREE.CanvasTexture {
  return canvasTex(512, 256, (ctx) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 512, 256);
    for (const u of [128, 384]) {
      ctx.fillStyle = ink === '#fff' ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.6)';
      ctx.beginPath();
      ctx.ellipse(u, 128, 34, 46, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = ink;
      ctx.font = '700 70px "Barlow Condensed", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, u, 132);
    }
  });
}

function cueTexture(id: string): THREE.CanvasTexture {
  const s = cueSkin(id);
  const H = 2048;
  const at = (mm: number) => (mm / 1450) * H;
  return canvasTex(64, H, (ctx) => {
    const band = (a: number, b: number, color: string) => { ctx.fillStyle = color; ctx.fillRect(0, at(a), 64, at(b) - at(a)); };
    band(0, 7, '#3b6fb6');
    band(7, 26, '#f3ecdc');
    band(26, 900, s.shaft);
    // Shaft grain.
    const rnd = mulberry(3);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(120,80,30,${0.04 + rnd() * 0.06})`;
      ctx.fillRect(rnd() * 64, at(26), 1 + rnd() * 2, at(900) - at(26));
    }
    band(900, 912, s.inlay);
    band(912, 1420, s.butt);
    // Classic splice points running up from the butt.
    ctx.fillStyle = s.buttDark;
    for (let k = 0; k < 4; k++) {
      const x = (k * 64) / 4;
      ctx.beginPath();
      ctx.moveTo(x, at(1420));
      ctx.lineTo(x + 8, at(1010));
      ctx.lineTo(x + 16, at(1420));
      ctx.fill();
    }
    if (s.stripe) for (let u = 960; u < 1390; u += 70) band(u, u + 22, s.stripe);
    band(1180, 1190, s.inlay);
    band(1420, 1450, '#121212');
  });
}

function glowTexture(): THREE.CanvasTexture {
  return canvasTex(64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  });
}

function dashTexture(): THREE.CanvasTexture {
  return canvasTex(64, 8, (ctx) => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 36, 8);
  });
}

function blobTexture(): THREE.CanvasTexture {
  return canvasTex(128, 128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    g.addColorStop(0, 'rgba(0,0,0,0.85)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.45)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });
}

function mulberry(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}
