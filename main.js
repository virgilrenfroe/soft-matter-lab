import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const errEl = document.getElementById('err');
function showErr(msg) {
  if (!errEl) return;
  errEl.style.display = 'block';
  errEl.textContent = String(msg);
}
window.addEventListener('error', (e) => showErr(e.message || e.error || e));
window.addEventListener('unhandledrejection', (e) => showErr(e.reason));

const params = new URLSearchParams(location.search);
const embed = params.get('embed') === '1';
const stillParam = params.get('still') === '1';
if (embed) document.documentElement.classList.add('embed');

let reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
try {
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
    reducedMotion = e.matches;
  });
} catch (_) {
  /* older Safari */
}
function motionOK() {
  return !reducedMotion && !stillParam;
}

const isNarrow = () => window.innerWidth < 700;
const pixelCap = () => {
  const dpr = window.devicePixelRatio || 1;
  if (isNarrow()) return Math.min(dpr, 1.5);
  return Math.min(dpr, 2);
};
const narrowAtStart = isNarrow();

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
  alpha: false,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(pixelCap());
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.setClearColor(0x0c0a08, 1);
renderer.domElement.style.pointerEvents = 'none';

const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
const envMap = pmrem.fromScene(room, 0.04).texture;
room.dispose?.();
pmrem.dispose();

const scenes = [];
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const grabPlane = new THREE.Plane();
const grabHit = new THREE.Vector3();
const camForward = new THREE.Vector3();

function makeScene(element, opts = {}) {
  if (!element) throw new Error('Missing specimen viewport');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(opts.bg ?? 0x14110e);
  scene.environment = envMap;
  const camera = new THREE.PerspectiveCamera(opts.fov ?? 40, 1, 0.08, 50);
  camera.position.set(opts.px ?? 0, opts.py ?? 0.6, opts.pz ?? 3.4);
  const controls = new OrbitControls(camera, element);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = opts.minDist ?? 1.6;
  controls.maxDistance = opts.maxDist ?? 8;
  controls.target.set(opts.tx ?? 0, opts.ty ?? 0, opts.tz ?? 0);
  controls.update();
  scene.userData = { element, camera, controls, update: null };
  scenes.push(scene);
  return scene;
}

function addKeyLight(scene, color = 0xffe6d0, intensity = 2.5) {
  const key = new THREE.DirectionalLight(color, intensity);
  key.position.set(2.6, 4.2, 2.2);
  scene.add(key);
  const fill = new THREE.HemisphereLight(0xb8d4ff, 0x2a1a10, 0.72);
  scene.add(fill);
  return key;
}

function ndcFromEvent(event, element) {
  const rect = element.getBoundingClientRect();
  ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  return ndc;
}

/* ——— Wave basin: analytic traveling wave + ripple field ——— */

class WaveBasin {
  constructor(cols, rows, width, depth) {
    this.cols = cols;
    this.rows = rows;
    this.width = width;
    this.depth = depth;
    this.count = cols * rows;
    this.h = new Float32Array(this.count);
    this.v = new Float32Array(this.count);
    this.baseX = new Float32Array(this.count);
    this.baseZ = new Float32Array(this.count);
    this.acc = 0;
    this.phase = 1.15;
    this.speed = 2.15;
    this.liveUntil = 0;
    this.mapError = 0;

    const geo = new THREE.PlaneGeometry(width, depth, cols - 1, rows - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < this.count; i++) {
      this.baseX[i] = pos.getX(i);
      this.baseZ[i] = pos.getZ(i);
    }
    const colors = new Float32Array(this.count * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.geo = geo;

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.16,
      metalness: 0.04,
      envMapIntensity: 1.05,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;

    this.cLow = new THREE.Color(0x0f4e58);
    this.cMid = new THREE.Color(0x2fbfb4);
    this.cHigh = new THREE.Color(0xf4fffb);
    this.tmp = new THREE.Color();
    this._checkMap();
  }

  _checkMap() {
    for (let i = 0; i < this.count; i++) this.h[i] = this.baseX[i];
    let maxErr = 0;
    const sample = Math.max(1, Math.floor(this.count / 40));
    for (let i = 0; i < this.count; i += sample) {
      const got = this.heightAt(this.baseX[i], this.baseZ[i], 0);
      maxErr = Math.max(maxErr, Math.abs(got - this.baseX[i]));
    }
    this.h.fill(0);
    this.mapError = maxErr;
  }

  indexAt(x, z) {
    const fx = ((x + this.width / 2) / this.width) * (this.cols - 1);
    const fz = ((z + this.depth / 2) / this.depth) * (this.rows - 1);
    return { fx, fz };
  }

  envelope(x, z) {
    const u = (x + this.width / 2) / this.width;
    const nz = z / (this.depth * 0.5);
    const enter = Math.min(1, Math.max(0, u / 0.07));
    const exit = Math.min(1, Math.max(0, (1 - u) / 0.16));
    const ez = Math.cos(Math.max(-1, Math.min(1, nz)) * Math.PI * 0.5);
    return enter * exit * (0.72 + 0.28 * ez);
  }

  analytic(x, z, amp) {
    const omega = Math.PI * 2 * 0.9;
    // tempo is applied by the caller via amp already scaled; wavenumber uses this.tempo
    const tempo = this._tempo ?? 0.9;
    const k = (Math.PI * 2 * tempo) / this.speed;
    return amp * Math.sin(k * x - this.phase) * this.envelope(x, z);
  }

  heightAt(x, z, amp) {
    const { fx, fz } = this.indexAt(x, z);
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const tz = fz - z0;
    const sample = (ix, iz) => {
      const cx = Math.max(0, Math.min(this.cols - 1, ix));
      const cz = Math.max(0, Math.min(this.rows - 1, iz));
      return this.h[cz * this.cols + cx];
    };
    const h00 = sample(x0, z0);
    const h10 = sample(x0 + 1, z0);
    const h01 = sample(x0, z0 + 1);
    const h11 = sample(x0 + 1, z0 + 1);
    const ripple = (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
    return ripple + this.analytic(x, z, amp);
  }

  drop(x, z, mag) {
    const radius = Math.min(this.width, this.depth) * 0.16;
    const sigma = radius * 0.45;
    const r2 = radius * radius;
    for (let i = 0; i < this.count; i++) {
      const dx = this.baseX[i] - x;
      const dz = this.baseZ[i] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < r2) {
        const w = Math.exp(-d2 / (2 * sigma * sigma));
        this.v[i] += mag * w;
      }
    }
    this.liveUntil = performance.now() + 5200;
  }

  substep(dt, dampUser) {
    const { cols, rows, h, v } = this;
    const c2 = this.speed * this.speed;
    const dx = this.width / (cols - 1);
    const dz = this.depth / (rows - 1);
    const invDx2 = 1 / (dx * dx);
    const invDz2 = 1 / (dz * dz);
    const damp = 0.99915 - dampUser * 0.0105;
    if (!this.scratch) this.scratch = new Float32Array(h.length);

    for (let iy = 1; iy < rows - 1; iy++) {
      for (let ix = 1; ix < cols - 1; ix++) {
        const id = iy * cols + ix;
        const lap =
          (h[id + 1] + h[id - 1] - 2 * h[id]) * invDx2 +
          (h[id + cols] + h[id - cols] - 2 * h[id]) * invDz2;
        let d = damp;
        const right = cols - 1 - ix;
        const edge = Math.min(ix, right, iy, rows - 1 - iy);
        if (edge < 7) d *= 0.86 + 0.02 * edge;
        v[id] = v[id] * d + c2 * lap * dt;
        let next = h[id] + v[id] * dt;
        if (next > 0.55) next = 0.55;
        if (next < -0.4) next = -0.4;
        this.scratch[id] = next;
      }
    }
    for (let iy = 1; iy < rows - 1; iy++) {
      for (let ix = 1; ix < cols - 1; ix++) {
        const id = iy * cols + ix;
        h[id] = this.scratch[id];
      }
    }
    for (let ix = 0; ix < cols; ix++) {
      h[ix] = 0;
      v[ix] = 0;
      const id = (rows - 1) * cols + ix;
      h[id] = 0;
      v[id] = 0;
    }
    for (let iy = 0; iy < rows; iy++) {
      const a = iy * cols;
      const b = a + cols - 1;
      h[a] = v[a] = 0;
      h[b] = v[b] = 0;
    }
  }

  step(frameDt, opts) {
    this._tempo = opts.tempo;
    const driveAmp = opts.drive ? opts.amp : 0;
    if (opts.advance) this.phase += Math.PI * 2 * opts.tempo * frameDt;
    const integrate = opts.ripples;
    if (integrate) {
      this.acc += Math.min(frameDt, 0.033);
      const hdt = 1 / 90;
      let n = 0;
      while (this.acc >= hdt && n < 4) {
        this.substep(hdt, opts.damp);
        this.acc -= hdt;
        n++;
      }
    }
    this.write(driveAmp);
    return driveAmp;
  }

  write(amp) {
    const pos = this.geo.attributes.position;
    const col = this.geo.attributes.color;
    for (let i = 0; i < this.count; i++) {
      const y = this.h[i] + this.analytic(this.baseX[i], this.baseZ[i], amp);
      pos.setY(i, y);
      const t = Math.max(-1, Math.min(1, y / 0.22));
      if (t >= 0) this.tmp.copy(this.cMid).lerp(this.cHigh, t);
      else this.tmp.copy(this.cMid).lerp(this.cLow, -t);
      col.setXYZ(i, this.tmp.r, this.tmp.g, this.tmp.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.geo.computeVertexNormals();
  }
}

function addTank(scene, width, depth) {
  const wood = new THREE.MeshStandardMaterial({ color: 0x6d4b32, roughness: 0.68, metalness: 0.05 });
  const inner = new THREE.MeshStandardMaterial({ color: 0x071416, roughness: 0.92, metalness: 0.02 });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(width + 0.28, 0.1, depth + 0.28), inner);
  floor.position.y = -0.32;
  scene.add(floor);
  const wallH = 0.52;
  const t = 0.09;
  const walls = [
    [width + 0.28, wallH, t, 0, -0.02, -depth / 2 - 0.04],
    [width + 0.28, wallH, t, 0, -0.02, depth / 2 + 0.04],
    [t, wallH, depth + 0.1, -width / 2 - 0.04, -0.02, 0],
    [t, wallH, depth + 0.1, width / 2 + 0.04, -0.02, 0],
  ];
  for (const w of walls) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w[0], w[1], w[2]), wood);
    mesh.position.set(w[3], w[4], w[5]);
    scene.add(mesh);
  }
  return wood;
}

const FLOAT_COLORS = [0xff5a1f, 0xffc857, 0xf4efe6, 0x7ec8ff, 0xc8f542];

function addFloats(scene, xs, z, radius) {
  const floats = [];
  const mastPos = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    mastPos.push(x, -0.22, z, x, 0.42, z);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 20, 14),
      new THREE.MeshStandardMaterial({
        color: FLOAT_COLORS[i % FLOAT_COLORS.length],
        emissive: FLOAT_COLORS[i % FLOAT_COLORS.length],
        emissiveIntensity: 0.38,
        roughness: 0.38,
        metalness: 0.08,
      })
    );
    mesh.position.set(x, radius, z);
    scene.add(mesh);
    floats.push({ mesh, x, z });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(mastPos, 3));
  scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
    color: 0xf4efe6,
    transparent: true,
    opacity: 0.38,
  })));
  return floats;
}

/* ——— Cloth: position-based sheet ——— */

class SoftCloth {
  constructor(nx, ny, width, height, topY) {
    this.nx = nx;
    this.ny = ny;
    this.count = nx * ny;
    this.pos = new Float32Array(this.count * 3);
    this.prev = new Float32Array(this.count * 3);
    this.rest = new Float32Array(this.count * 3);
    this.inv = new Float32Array(this.count);
    this.pin = new Uint8Array(this.count);
    this.constraints = [];
    this.grab = -1;
    this.gust = 0;
    this.holdUntil = 0;

    const id = (i, j) => j * nx + i;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const o = id(i, j) * 3;
        const x = (i / (nx - 1) - 0.5) * width;
        const y = topY - (j / (ny - 1)) * height;
        this.rest[o] = this.pos[o] = this.prev[o] = x;
        this.rest[o + 1] = this.pos[o + 1] = this.prev[o + 1] = y;
        this.rest[o + 2] = this.pos[o + 2] = this.prev[o + 2] = 0;
        if (j === 0) this.pin[id(i, j)] = 1;
        this.inv[id(i, j)] = this.pin[id(i, j)] ? 0 : 1;
      }
    }
    const link = (a, b) => {
      const dx = this.rest[a * 3] - this.rest[b * 3];
      const dy = this.rest[a * 3 + 1] - this.rest[b * 3 + 1];
      const dz = this.rest[a * 3 + 2] - this.rest[b * 3 + 2];
      this.constraints.push({ a, b, rest: Math.hypot(dx, dy, dz) });
    };
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (i + 1 < nx) link(id(i, j), id(i + 1, j));
        if (j + 1 < ny) link(id(i, j), id(i, j + 1));
        if (i + 1 < nx && j + 1 < ny) {
          link(id(i, j), id(i + 1, j + 1));
          link(id(i + 1, j), id(i, j + 1));
        }
        if (i + 2 < nx) link(id(i, j), id(i + 2, j));
        if (j + 2 < ny) link(id(i, j), id(i, j + 2));
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.count * 3), 3));
    const colors = new Float32Array(this.count * 3);
    const light = new THREE.Color(0xe9dfd0);
    const dark = new THREE.Color(0xcbbba3);
    const hem = new THREE.Color(0xb7a48c);
    const tmp = new THREE.Color();
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        tmp.copy(i % 2 === 0 ? dark : light);
        if (j > ny - 3) tmp.lerp(hem, 0.55);
        const o = (j * nx + i) * 3;
        colors[o] = tmp.r;
        colors[o + 1] = tmp.g;
        colors[o + 2] = tmp.b;
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const indices = [];
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = id(i, j);
        const b = id(i + 1, j);
        const c = id(i, j + 1);
        const d = id(i + 1, j + 1);
        indices.push(a, c, b, b, c, d);
      }
    }
    geo.setIndex(indices);
    geo.computeVertexNormals();
    this.geo = geo;
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.84,
        metalness: 0,
        sheen: 0.7,
        sheenRoughness: 0.55,
        sheenColor: new THREE.Color(0xfff3e4),
        side: THREE.DoubleSide,
        envMapIntensity: 0.45,
      })
    );
    this.mesh.frustumCulled = false;

    this.markers = [];
    const markerIdx = [
      id(Math.floor(nx * 0.5), Math.min(ny - 2, Math.floor(ny * 0.72))),
      id(Math.max(1, Math.floor(nx * 0.22)), Math.min(ny - 2, Math.floor(ny * 0.48))),
      id(Math.min(nx - 2, Math.floor(nx * 0.78)), Math.min(ny - 2, Math.floor(ny * 0.58))),
    ];
    const markerColors = [0xff5a1f, 0x7ec8ff, 0xc8f542];
    for (let m = 0; m < markerIdx.length; m++) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.058, 14, 10),
        new THREE.MeshStandardMaterial({
          color: markerColors[m],
          emissive: markerColors[m],
          emissiveIntensity: 0.42,
          roughness: 0.4,
        })
      );
      this.markers.push({ mesh, index: markerIdx[m] });
    }
    this.topY = topY;
    this.width = width;
  }

  reset() {
    this.pos.set(this.rest);
    this.prev.set(this.rest);
    this.grab = -1;
    this.gust = 0;
    for (let i = 0; i < this.count; i++) this.inv[i] = this.pin[i] ? 0 : 1;
  }

  grabAt(index) {
    if (this.pin[index]) return false;
    this.grab = index;
    this.inv[index] = 0;
    return true;
  }

  moveGrab(x, y, z) {
    if (this.grab < 0) return;
    const o = this.grab * 3;
    this.prev[o] = this.pos[o];
    this.prev[o + 1] = this.pos[o + 1];
    this.prev[o + 2] = this.pos[o + 2];
    this.pos[o] = Math.max(-1.8, Math.min(1.8, x));
    this.pos[o + 1] = Math.max(-2.4, Math.min(this.topY + 0.4, y));
    this.pos[o + 2] = Math.max(-1.8, Math.min(1.8, z));
    this._solve(this._stiff || 0.8, 2);
  }

  releaseGrab() {
    if (this.grab < 0) return;
    const i = this.grab;
    this.grab = -1;
    if (!this.pin[i]) this.inv[i] = 1;
    this.holdUntil = performance.now() + 1400;
  }

  _solve(stiff, iters) {
    const { pos, inv, constraints } = this;
    for (let k = 0; k < iters; k++) {
      for (let n = 0; n < constraints.length; n++) {
        const c = constraints[n];
        const ia = c.a * 3;
        const ib = c.b * 3;
        const wa = inv[c.a];
        const wb = inv[c.b];
        const w = wa + wb;
        if (w === 0) continue;
        let dx = pos[ib] - pos[ia];
        let dy = pos[ib + 1] - pos[ia + 1];
        let dz = pos[ib + 2] - pos[ia + 2];
        const dist = Math.hypot(dx, dy, dz) || 1e-6;
        const diff = (dist - c.rest) / dist;
        let corr = (diff * stiff) / w;
        if (corr > 0.8) corr = 0.8;
        if (corr < -0.8) corr = -0.8;
        if (wa) {
          pos[ia] += dx * corr * wa;
          pos[ia + 1] += dy * corr * wa;
          pos[ia + 2] += dz * corr * wa;
        }
        if (wb) {
          pos[ib] -= dx * corr * wb;
          pos[ib + 1] -= dy * corr * wb;
          pos[ib + 2] -= dz * corr * wb;
        }
      }
      for (let i = 0; i < this.count; i++) {
        if (!this.pin[i]) continue;
        const o = i * 3;
        pos[o] = this.rest[o];
        pos[o + 1] = this.rest[o + 1];
        pos[o + 2] = this.rest[o + 2];
      }
    }
  }

  step(dt, opts) {
    this._stiff = opts.stiff;
    const wind = opts.wind + this.gust;
    this.gust *= Math.exp(-dt * 2.4);
    const damp = opts.damp;
    const t = opts.time;
    const flutterOn = opts.flutter;
    for (let i = 0; i < this.count; i++) {
      if (this.inv[i] === 0) continue;
      const o = i * 3;
      const x = this.pos[o];
      const y = this.pos[o + 1];
      const z = this.pos[o + 2];
      const flutter = flutterOn ? Math.sin(t * 2.6 + x * 3.1 + y * 0.7) * wind * 1.6 : 0;
      const ax = flutterOn ? Math.sin(t * 1.7 + y * 2.2) * wind * 0.8 : 0;
      const ay = -5.5;
      const az = wind * 7.5 + flutter;
      const vx = (x - this.prev[o]) * damp;
      const vy = (y - this.prev[o + 1]) * damp;
      const vz = (z - this.prev[o + 2]) * damp;
      this.prev[o] = x;
      this.prev[o + 1] = y;
      this.prev[o + 2] = z;
      this.pos[o] = x + vx + ax * dt * dt;
      this.pos[o + 1] = y + vy + ay * dt * dt;
      this.pos[o + 2] = z + vz + az * dt * dt;
    }
    const iters = opts.stiff > 0.75 ? 4 : 3;
    this._solve(opts.stiff, iters);
    let bad = false;
    for (let i = 0; i < this.count; i++) {
      const o = i * 3;
      if (!Number.isFinite(this.pos[o]) || Math.abs(this.pos[o + 2]) > 8) bad = true;
    }
    if (bad) this.reset();
  }

  sync() {
    const attr = this.geo.attributes.position;
    attr.array.set(this.pos);
    attr.needsUpdate = true;
    this.geo.computeVertexNormals();
    for (const m of this.markers) {
      const o = m.index * 3;
      m.mesh.position.set(this.pos[o], this.pos[o + 1], this.pos[o + 2]);
    }
  }
}

/* ——— Channel flow ——— */

class ChannelFlow {
  constructor(count) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.lane = new Float32Array(count);
    this.R = 0.42;
    this.obstacleX = 0.15;
    this.release();
  }

  release() {
    const lanes = 11;
    for (let i = 0; i < this.count; i++) {
      const lane = ((i % lanes) / (lanes - 1)) * 2 - 1;
      this.lane[i] = lane;
      const x = -2.9 + (i / this.count) * 5.6;
      const z = lane * 0.92;
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = 0.1;
      this.pos[i * 3 + 2] = z;
    }
  }

  velocity(x, z, speed, swirl) {
    const cx = x - this.obstacleX;
    const cz = z;
    const r2 = cx * cx + cz * cz;
    const R2 = this.R * this.R;
    if (r2 < R2 * 0.92) {
      const r = Math.sqrt(r2) || 0.001;
      return { x: (cx / r) * 0.9, z: (cz / r) * 0.9 };
    }
    const inv = 1 / Math.max(r2, 0.04);
    const inv2 = inv * inv;
    let vx = speed * (1 - R2 * (cx * cx - cz * cz) * inv2);
    let vz = -speed * R2 * (2 * cx * cz) * inv2;
    if (swirl > 0) {
      const r = Math.sqrt(r2);
      const s = swirl * 0.7 * Math.exp(-r * 0.45);
      vx += (-cz / r) * s;
      vz += (cx / r) * s;
    }
    return { x: vx, z: vz };
  }

  step(dt, speed, swirl) {
    const half = 1.05;
    for (let i = 0; i < this.count; i++) {
      const o = i * 3;
      let x = this.pos[o];
      let z = this.pos[o + 2];
      const v = this.velocity(x, z, speed, swirl);
      x += v.x * dt;
      z += v.z * dt;
      if (z > half) z = half;
      if (z < -half) z = -half;
      if (x > 3.05) {
        x = -3.05;
        z = this.lane[i] * 0.92;
      }
      this.pos[o] = x;
      this.pos[o + 2] = z;
    }
  }
}

function circleTexture() {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.85)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ——— Sessile drop: fixed volume, skin pulls toward the spherical cap ——— */

class SessileDrop {
  constructor(latBands, segs, volume) {
    this.latBands = latBands;
    this.segs = segs;
    this.volume = volume;
    this.count = latBands * segs + 1;
    this.apex = this.count - 1;
    this.pos = new Float32Array(this.count * 3);
    this.prev = new Float32Array(this.count * 3);
    this.target = new Float32Array(this.count * 3);
    this.inv = new Float32Array(this.count);
    this.inv.fill(1);
    this.constraints = [];
    this.grab = -1;
    this.holdX = 0;
    this.holdY = 0;
    this.holdZ = 0;
    this.theta = 1;
    this.R = 1;
    this.yc = 0;
    this.height = 0.5;
    this.baseR = 0.5;
    this.footR = 0.5;
    this.wetting = 0.18;
    this.nextDent = -1;
    this._link();
    this.setWetting(0.18);
    this.pos.set(this.target);
    this.prev.set(this.target);
    this._buildGeo();
    this._buildMarkers();
  }

  _link() {
    const { segs, latBands, apex } = this;
    const id = (r, s) => r * segs + ((s % segs) + segs) % segs;
    const link = (a, b) => this.constraints.push({ a, b, rest: 1 });
    for (let r = 0; r < latBands; r++) {
      for (let s = 0; s < segs; s++) {
        link(id(r, s), id(r, s + 1));
        if (r + 1 < latBands) {
          link(id(r, s), id(r + 1, s));
          link(id(r, s), id(r + 1, s + 1));
        } else {
          link(id(r, s), apex);
        }
      }
    }
  }

  setWetting(w) {
    const clamped = Math.max(0, Math.min(1, w));
    const deg = 150 - clamped * 132;
    const theta = (deg * Math.PI) / 180;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const shape = (1 - cosT) * (1 - cosT) * (2 + cosT);
    const R = Math.cbrt((3 * this.volume) / (Math.PI * Math.max(shape, 1e-5)));
    const yc = -R * cosT;
    this.wetting = clamped;
    this.theta = theta;
    this.R = R;
    this.yc = yc;
    this.baseR = R * sinT;
    this.height = R * (1 - cosT);
    const { segs, latBands, target } = this;
    for (let r = 0; r < latBands; r++) {
      const alpha = theta * (1 - r / latBands);
      const rad = R * Math.sin(alpha);
      const y = Math.max(0, yc + R * Math.cos(alpha));
      for (let s = 0; s < segs; s++) {
        const phi = (s / segs) * Math.PI * 2;
        const o = (r * segs + s) * 3;
        target[o] = rad * Math.cos(phi);
        target[o + 1] = y;
        target[o + 2] = rad * Math.sin(phi);
      }
    }
    const ao = this.apex * 3;
    target[ao] = 0;
    target[ao + 1] = Math.max(0, yc + R);
    target[ao + 2] = 0;
    for (let n = 0; n < this.constraints.length; n++) {
      const c = this.constraints[n];
      const ia = c.a * 3;
      const ib = c.b * 3;
      const dx = target[ia] - target[ib];
      const dy = target[ia + 1] - target[ib + 1];
      const dz = target[ia + 2] - target[ib + 2];
      c.rest = Math.hypot(dx, dy, dz);
    }
  }

  _buildGeo() {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(this.count * 3);
    positions.set(this.pos);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const colors = new Float32Array(this.count * 3);
    const c0 = new THREE.Color(0x0c5f73);
    const c1 = new THREE.Color(0x49d0dc);
    const c2 = new THREE.Color(0xf3fffd);
    const tmp = new THREE.Color();
    for (let r = 0; r < this.latBands; r++) {
      const t = r / Math.max(1, this.latBands - 1);
      if (t < 0.55) tmp.copy(c0).lerp(c1, t / 0.55);
      else tmp.copy(c1).lerp(c2, (t - 0.55) / 0.45);
      for (let s = 0; s < this.segs; s++) {
        const o = (r * this.segs + s) * 3;
        colors[o] = tmp.r;
        colors[o + 1] = tmp.g;
        colors[o + 2] = tmp.b;
      }
    }
    const ao = this.apex * 3;
    colors[ao] = c2.r;
    colors[ao + 1] = c2.g;
    colors[ao + 2] = c2.b;
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const indices = [];
    const id = (r, s) => r * this.segs + ((s % this.segs) + this.segs) % this.segs;
    for (let r = 0; r < this.latBands - 1; r++) {
      for (let s = 0; s < this.segs; s++) {
        const a = id(r, s);
        const b = id(r, s + 1);
        const c = id(r + 1, s);
        const d = id(r + 1, s + 1);
        indices.push(a, b, d, a, d, c);
      }
    }
    const rTop = this.latBands - 1;
    for (let s = 0; s < this.segs; s++) {
      indices.push(id(rTop, s), id(rTop, s + 1), this.apex);
    }
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal;
    const side = Math.min(this.count - 2, Math.floor(this.latBands / 2) * this.segs);
    const outward =
      nrm.getX(side) * this.pos[side * 3] +
      nrm.getY(side) * (this.pos[side * 3 + 1] - this.yc) +
      nrm.getZ(side) * this.pos[side * 3 + 2];
    if (outward < 0) {
      for (let i = 0; i < indices.length; i += 3) {
        const swap = indices[i];
        indices[i] = indices[i + 1];
        indices[i + 1] = swap;
      }
      geo.setIndex(indices);
      geo.computeVertexNormals();
    }
    this.geo = geo;
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.14,
        metalness: 0.02,
        clearcoat: 0.55,
        clearcoatRoughness: 0.2,
        envMapIntensity: 1.15,
        side: THREE.DoubleSide,
      })
    );
    this.mesh.frustumCulled = false;

    const foot = new THREE.BufferGeometry();
    foot.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.segs * 2 * 3), 3));
    const footIndex = [];
    for (let s = 0; s < this.segs; s++) {
      const s2 = (s + 1) % this.segs;
      const i0 = s * 2;
      const o0 = i0 + 1;
      const i1 = s2 * 2;
      const o1 = i1 + 1;
      footIndex.push(i0, o0, o1, i0, o1, i1);
    }
    foot.setIndex(footIndex);
    this.footGeo = foot;
    this.footMesh = new THREE.Mesh(
      foot,
      new THREE.MeshStandardMaterial({
        color: 0xff9d2c,
        emissive: 0xff9d2c,
        emissiveIntensity: 0.55,
        roughness: 0.4,
      })
    );
    this.footMesh.frustumCulled = false;

    const cap = new THREE.BufferGeometry();
    cap.setAttribute('position', new THREE.BufferAttribute(new Float32Array((this.segs + 1) * 3), 3));
    const capIndex = [];
    for (let s = 0; s < this.segs; s++) {
      capIndex.push(0, s + 1, ((s + 1) % this.segs) + 1);
    }
    cap.setIndex(capIndex);
    cap.computeVertexNormals();
    this.capGeo = cap;
    this.capMesh = new THREE.Mesh(
      cap,
      new THREE.MeshStandardMaterial({
        color: 0x0c5f73,
        roughness: 0.28,
        metalness: 0.02,
        envMapIntensity: 0.6,
        side: THREE.DoubleSide,
      })
    );
    this.capMesh.frustumCulled = false;
  }

  _buildMarkers() {
    this.markers = [];
    const markerColors = [0xffc857, 0xff5a1f, 0x7ec8ff, 0xc8f542, 0xf4efe6];
    const mid = Math.max(1, Math.floor(this.latBands * 0.46));
    const specs = [this.apex];
    for (let k = 0; k < 4; k++) {
      specs.push(mid * this.segs + Math.floor(((k + 0.5) * this.segs) / 4));
    }
    for (let m = 0; m < specs.length; m++) {
      const color = markerColors[m % markerColors.length];
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.052, 14, 10),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.42,
          roughness: 0.38,
        })
      );
      this.markers.push({ mesh, index: specs[m] });
    }
  }

  snap() {
    this.pos.set(this.target);
    this.prev.set(this.target);
    this.grab = -1;
    for (let i = 0; i < this.count; i++) this.inv[i] = 1;
  }

  grabAt(index) {
    if (index < 0 || index >= this.count) return false;
    this.grab = index;
    this.inv[index] = 0;
    const o = index * 3;
    this.holdX = this.pos[o];
    this.holdY = this.pos[o + 1];
    this.holdZ = this.pos[o + 2];
    return true;
  }

  moveGrab(x, y, z) {
    if (this.grab < 0) return;
    this.holdX = Math.max(-1.7, Math.min(1.7, x));
    this.holdY = Math.max(0.02, Math.min(1.65, y));
    this.holdZ = Math.max(-1.7, Math.min(1.7, z));
    if (this.grab < this.segs) this.holdY = 0;
    this._pinGrab();
    this._solve(0.72, 2);
    this._project();
    this._pinGrab();
  }

  _pinGrab() {
    if (this.grab < 0) return;
    const o = this.grab * 3;
    this.pos[o] = this.holdX;
    this.pos[o + 1] = this.holdY;
    this.pos[o + 2] = this.holdZ;
  }

  releaseGrab() {
    if (this.grab < 0) return;
    this.inv[this.grab] = 1;
    this.grab = -1;
  }

  dent() {
    const amp = Math.min(0.28, Math.max(0.04, this.height * 0.36));
    const ao = this.apex * 3;
    this.pos[ao + 1] = Math.max(0.03, this.pos[ao + 1] - amp);
    const r = this.latBands - 1;
    for (let s = 0; s < this.segs; s++) {
      const o = (r * this.segs + s) * 3;
      const rad = Math.hypot(this.pos[o], this.pos[o + 2]) || 1e-4;
      const push = amp * 0.42;
      this.pos[o] += (this.pos[o] / rad) * push;
      this.pos[o + 2] += (this.pos[o + 2] / rad) * push;
      this.pos[o + 1] = Math.max(0, this.pos[o + 1] - amp * 0.32);
    }
    this.prev.set(this.pos);
  }

  _pull(beta) {
    const { pos, target, count, grab, segs } = this;
    for (let i = 0; i < count; i++) {
      if (i === grab) continue;
      const o = i * 3;
      pos[o] += (target[o] - pos[o]) * beta;
      pos[o + 2] += (target[o + 2] - pos[o + 2]) * beta;
      if (i < segs) pos[o + 1] = 0;
      else pos[o + 1] += (target[o + 1] - pos[o + 1]) * beta;
    }
  }

  _project() {
    const { segs, pos, count } = this;
    for (let s = 0; s < segs; s++) pos[s * 3 + 1] = 0;
    for (let i = 0; i < count; i++) {
      const o = i * 3;
      if (pos[o + 1] < 0) pos[o + 1] = 0;
      if (pos[o + 1] > 1.85) pos[o + 1] = 1.85;
      if (pos[o] > 1.85) pos[o] = 1.85;
      if (pos[o] < -1.85) pos[o] = -1.85;
      if (pos[o + 2] > 1.85) pos[o + 2] = 1.85;
      if (pos[o + 2] < -1.85) pos[o + 2] = -1.85;
    }
  }

  _solve(stiff, iters) {
    const { pos, inv, constraints } = this;
    for (let k = 0; k < iters; k++) {
      for (let n = 0; n < constraints.length; n++) {
        const c = constraints[n];
        const ia = c.a * 3;
        const ib = c.b * 3;
        const wa = inv[c.a];
        const wb = inv[c.b];
        const w = wa + wb;
        if (w === 0 || c.rest <= 1e-5) continue;
        let dx = pos[ib] - pos[ia];
        let dy = pos[ib + 1] - pos[ia + 1];
        let dz = pos[ib + 2] - pos[ia + 2];
        const dist = Math.hypot(dx, dy, dz) || 1e-6;
        const diff = (dist - c.rest) / dist;
        let corr = (diff * stiff) / w;
        if (corr > 0.65) corr = 0.65;
        if (corr < -0.65) corr = -0.65;
        if (wa) {
          pos[ia] += dx * corr * wa;
          pos[ia + 1] += dy * corr * wa;
          pos[ia + 2] += dz * corr * wa;
        }
        if (wb) {
          pos[ib] -= dx * corr * wb;
          pos[ib + 1] -= dy * corr * wb;
          pos[ib + 2] -= dz * corr * wb;
        }
      }
      this._project();
      this._pinGrab();
    }
  }

  step(dt, opts) {
    if (!opts.motion && this.grab < 0) {
      this.pos.set(this.target);
      this.prev.set(this.target);
      return;
    }
    const sub = Math.min(Math.max(dt, 0.001), 0.033);
    const held = this.grab >= 0 ? 0.42 : 1;
    const beta60 = Math.min(0.42, (0.04 + Math.max(0, opts.skin) * 0.18) * held);
    const beta = 1 - Math.pow(1 - beta60, sub * 60);
    this._pull(beta);
    this._solve(Math.min(0.92, 0.42 + opts.skin * 0.34), opts.skin > 0.75 ? 4 : 3);
    this._pinGrab();
    const y = this.pos[this.apex * 3 + 1];
    if (!Number.isFinite(y) || y > 2.4) this.snap();
  }

  sync() {
    const attr = this.geo.attributes.position;
    attr.array.set(this.pos);
    attr.needsUpdate = true;
    this.geo.computeVertexNormals();
    const yc = this.yc;
    for (const m of this.markers) {
      const o = m.index * 3;
      const x = this.pos[o];
      const y = this.pos[o + 1];
      const z = this.pos[o + 2];
      let nx = x;
      let ny = y - yc;
      let nz = z;
      const len = Math.hypot(nx, ny, nz) || 1;
      const lift = 0.05;
      m.mesh.position.set(x + (nx / len) * lift, y + (ny / len) * lift, z + (nz / len) * lift);
    }
    let rSum = 0;
    const ribbon = 0.016;
    const footAttr = this.footGeo.attributes.position;
    for (let s = 0; s < this.segs; s++) {
      const o = s * 3;
      const x = this.pos[o];
      const z = this.pos[o + 2];
      const rad = Math.hypot(x, z) || 1e-4;
      rSum += rad;
      const nx = x / rad;
      const nz = z / rad;
      footAttr.setXYZ(s * 2, x - nx * ribbon, 0.008, z - nz * ribbon);
      footAttr.setXYZ(s * 2 + 1, x + nx * ribbon, 0.008, z + nz * ribbon);
    }
    footAttr.needsUpdate = true;
    this.footR = rSum / this.segs;
    const capAttr = this.capGeo.attributes.position;
    let cx = 0;
    let cz = 0;
    for (let s = 0; s < this.segs; s++) {
      cx += this.pos[s * 3];
      cz += this.pos[s * 3 + 2];
    }
    cx /= this.segs;
    cz /= this.segs;
    capAttr.setXYZ(0, cx, 0.006, cz);
    for (let s = 0; s < this.segs; s++) {
      capAttr.setXYZ(s + 1, this.pos[s * 3], 0.006, this.pos[s * 3 + 2]);
    }
    capAttr.needsUpdate = true;
    this.capGeo.computeVertexNormals();
  }
}

/* ——— Build specimens ——— */

const waveCols = narrowAtStart ? 40 : 68;
const waveRows = narrowAtStart ? 24 : 40;
const waveW = 4.2;
const waveD = 2.35;
const basin = new WaveBasin(waveCols, waveRows, waveW, waveD);

const waveScene = makeScene(document.querySelector('[data-scene="wave"]'), {
  bg: 0x101614,
  px: 0.95,
  py: 1.62,
  pz: 2.35,
  tx: 0,
  ty: -0.02,
  tz: -0.05,
  fov: 38,
  minDist: 1.8,
  maxDist: 7,
});
addTank(waveScene, waveW, waveD);
addKeyLight(waveScene, 0xfff0e2, 2.7);
waveScene.add(basin.mesh);
const paddleMat = new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.45, metalness: 0.08, emissive: 0xff5a1f, emissiveIntensity: 0.25 });
const paddle = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.28, waveD * 0.62), paddleMat);
paddle.position.set(-waveW / 2 + 0.16, -0.02, 0);
waveScene.add(paddle);
const waveFloats = addFloats(waveScene, [-1.35, -0.68, 0.0, 0.68, 1.35], 0.02, 0.095);
basin.write(0.16);

const clothNX = narrowAtStart ? 14 : 22;
const clothNY = narrowAtStart ? 10 : 15;
const cloth = new SoftCloth(clothNX, clothNY, 2.05, 2.28, 1.08);
for (let i = 0; i < 100; i++) {
  cloth.step(1 / 60, { wind: 0.62, stiff: 0.82, damp: 0.9, flutter: false, time: i / 60 });
}
cloth.sync();

const clothScene = makeScene(document.querySelector('[data-scene="cloth"]'), {
  bg: 0x14110e,
  px: 1.72,
  py: 0.62,
  pz: 2.28,
  tx: 0,
  ty: -0.18,
  tz: 0.38,
  fov: 38,
  minDist: 1.7,
  maxDist: 7.5,
});
clothScene.userData.controls.enabled = false;
addKeyLight(clothScene, 0xffe6d0, 2.5);
const rod = new THREE.Mesh(
  new THREE.CylinderGeometry(0.028, 0.028, 2.35, 16),
  new THREE.MeshStandardMaterial({ color: 0xd5dbe3, roughness: 0.28, metalness: 1 })
);
rod.rotation.z = Math.PI / 2;
rod.position.y = 1.08;
clothScene.add(rod);
const pinMat = new THREE.MeshStandardMaterial({ color: 0xe8eef5, roughness: 0.22, metalness: 1 });
for (let i = 0; i < clothNX; i += 2) {
  const pin = new THREE.Mesh(new THREE.SphereGeometry(0.038, 12, 10), pinMat);
  pin.position.set(cloth.rest[i * 3], 1.08, 0);
  clothScene.add(pin);
}
clothScene.add(cloth.mesh);
for (const m of cloth.markers) clothScene.add(m.mesh);
const clothFloor = new THREE.Mesh(
  new THREE.CircleGeometry(2.3, 40),
  new THREE.MeshStandardMaterial({ color: 0x1a1714, roughness: 0.92, metalness: 0.04, envMapIntensity: 0.3 })
);
clothFloor.rotation.x = -Math.PI / 2;
clothFloor.position.y = -1.48;
clothScene.add(clothFloor);

const flowCount = narrowAtStart ? 160 : 480;
const flow = new ChannelFlow(flowCount);
const flowScene = makeScene(document.querySelector('[data-scene="flow"]'), {
  bg: 0x101418,
  px: 0.2,
  py: 3.15,
  pz: 3.05,
  tx: 0,
  ty: 0,
  tz: 0,
  fov: 40,
  minDist: 2.2,
  maxDist: 8,
});
addKeyLight(flowScene, 0xe7f0ff, 2.3);
const bed = new THREE.Mesh(
  new THREE.BoxGeometry(6.7, 0.08, 2.7),
  new THREE.MeshStandardMaterial({ color: 0x1a2228, roughness: 0.86, metalness: 0.08 })
);
bed.position.y = -0.04;
flowScene.add(bed);
const wallMat = new THREE.MeshStandardMaterial({ color: 0x6d4b32, roughness: 0.7, metalness: 0.04 });
for (const z of [-1.32, 1.32]) {
  const wall = new THREE.Mesh(new THREE.BoxGeometry(6.7, 0.22, 0.08), wallMat);
  wall.position.set(0, 0.08, z);
  flowScene.add(wall);
}
const post = new THREE.Mesh(
  new THREE.CylinderGeometry(flow.R, flow.R, 0.58, 28),
  new THREE.MeshStandardMaterial({ color: 0xc47a52, roughness: 0.55, metalness: 0.08 })
);
post.position.set(flow.obstacleX, 0.28, 0);
flowScene.add(post);

const inkColors = [0xff5a1f, 0xffc857, 0x7ec8ff, 0xc8f542, 0xf4efe6, 0xff8fab];
const flowColors = new Float32Array(flowCount * 3);
const ink = new THREE.Color();
for (let i = 0; i < flowCount; i++) {
  ink.set(inkColors[i % inkColors.length]);
  flowColors[i * 3] = ink.r;
  flowColors[i * 3 + 1] = ink.g;
  flowColors[i * 3 + 2] = ink.b;
}
const flowGeo = new THREE.BufferGeometry();
flowGeo.setAttribute('position', new THREE.BufferAttribute(flow.pos, 3));
flowGeo.setAttribute('color', new THREE.BufferAttribute(flowColors, 3));
const points = new THREE.Points(
  flowGeo,
  new THREE.PointsMaterial({
    size: narrowAtStart ? 0.11 : 0.078,
    map: circleTexture(),
    vertexColors: true,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    sizeAttenuation: true,
  })
);
points.frustumCulled = false;
flowScene.add(points);

const tracerCount = 5;
const tracers = [];
for (let i = 0; i < tracerCount; i++) {
  const color = inkColors[i];
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.095, 16, 12),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.45,
      roughness: 0.35,
    })
  );
  const lane = (i / (tracerCount - 1)) * 2 - 1;
  mesh.position.set(-2.4 + i * 0.35, 0.14, lane * 0.72);
  mesh.userData.lane = lane;
  mesh.userData.homeZ = lane * 0.72;
  flowScene.add(mesh);
  tracers.push(mesh);
}

/* Centerpiece: smaller analytic wave + smaller cloth */
const cmpWave = new WaveBasin(narrowAtStart ? 36 : 52, narrowAtStart ? 20 : 28, 4.0, 2.2);
cmpWave.phase = 0.8;
const cmpWaveScene = makeScene(document.querySelector('[data-scene="compare-wave"]'), {
  bg: 0x12110e,
  px: 0.85,
  py: 1.7,
  pz: 2.45,
  fov: 40,
  minDist: 1.8,
  maxDist: 7,
});
addTank(cmpWaveScene, 4.0, 2.2);
addKeyLight(cmpWaveScene, 0xfff0e2, 2.5);
cmpWaveScene.add(cmpWave.mesh);
const cmpPaddle = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.26, 1.3), paddleMat);
cmpPaddle.position.set(-2 + 0.16, -0.02, 0);
cmpWaveScene.add(cmpPaddle);
const cmpFloats = addFloats(cmpWaveScene, [-1.2, 0, 1.2], 0, 0.07);
cmpWave.write(0.15);

const cmpCloth = new SoftCloth(narrowAtStart ? 12 : 16, narrowAtStart ? 9 : 12, 1.7, 2.0, 0.95);
for (let i = 0; i < 80; i++) {
  cmpCloth.step(1 / 60, { wind: 0.55, stiff: 0.84, damp: 0.9, flutter: false, time: i / 60 });
}
cmpCloth.sync();
const cmpClothScene = makeScene(document.querySelector('[data-scene="compare-cloth"]'), {
  bg: 0x12110e,
  px: 1.35,
  py: 0.48,
  pz: 2.05,
  ty: -0.12,
  tz: 0.28,
  fov: 40,
  minDist: 1.6,
  maxDist: 7,
});
addKeyLight(cmpClothScene, 0xffe6d0, 2.4);
const cmpRod = rod.clone();
cmpRod.position.y = 0.95;
cmpRod.scale.set(1, 0.78, 1);
cmpClothScene.add(cmpRod);
cmpClothScene.add(cmpCloth.mesh);
for (const m of cmpCloth.markers) cmpClothScene.add(m.mesh);

const dropBands = narrowAtStart ? 11 : 16;
const dropSegs = narrowAtStart ? 16 : 28;
const drop = new SessileDrop(dropBands, dropSegs, 0.62);
drop.sync();

const dropScene = makeScene(document.querySelector('[data-scene="drop"]'), {
  bg: 0x121418,
  px: 1.25,
  py: 1.12,
  pz: 2.72,
  tx: 0,
  ty: 0.28,
  tz: 0,
  fov: 38,
  minDist: 1.45,
  maxDist: 7.2,
});
dropScene.userData.controls.enabled = false;
dropScene.userData.controls.maxPolarAngle = Math.PI * 0.48;
addKeyLight(dropScene, 0xfff1e4, 2.55);
const dropRim = new THREE.DirectionalLight(0x8ec8ff, 0.85);
dropRim.position.set(-2.4, 1.6, -1.8);
dropScene.add(dropRim);
const dropPlinth = new THREE.Mesh(
  new THREE.BoxGeometry(3.55, 0.18, 3.55),
  new THREE.MeshStandardMaterial({ color: 0x6d4b32, roughness: 0.68, metalness: 0.05 })
);
dropPlinth.position.y = -0.15;
dropScene.add(dropPlinth);
const dropPlate = new THREE.Mesh(
  new THREE.BoxGeometry(3.25, 0.055, 3.25),
  new THREE.MeshStandardMaterial({ color: 0xc5ced6, roughness: 0.24, metalness: 0.08, envMapIntensity: 0.75 })
);
dropPlate.position.y = -0.028;
dropScene.add(dropPlate);
dropScene.add(drop.mesh);
dropScene.add(drop.capMesh);
dropScene.add(drop.footMesh);
for (const m of drop.markers) dropScene.add(m.mesh);

/* ——— UI state ——— */

const ui = {
  waveAmp: 0.16,
  waveTempo: 0.9,
  waveDamp: 0.22,
  waveDrive: true,
  clothWind: 0.62,
  clothStiff: 0.78,
  clothDamp: 0.972,
  clothMode: 'pull',
  flowSpeed: 0.72,
  flowSwirl: 0.22,
  dropWet: 0.18,
  dropSkin: 0.86,
  dropMode: 'poke',
  drive: true,
};

function bindRange(id, format, apply) {
  const el = document.getElementById(id);
  const out = document.getElementById(id + '-out');
  const sync = () => {
    const v = Number(el.value);
    out.textContent = format(v);
    apply(v);
  };
  el.addEventListener('input', sync);
  sync();
}

bindRange('wave-amp', (v) => v.toFixed(2), (v) => { ui.waveAmp = v; });
bindRange('wave-tempo', (v) => v.toFixed(2), (v) => { ui.waveTempo = v; });
bindRange('wave-damp', (v) => v.toFixed(2), (v) => { ui.waveDamp = v; });
bindRange('cloth-wind', (v) => v.toFixed(2), (v) => { ui.clothWind = v; });
bindRange('cloth-stiff', (v) => v.toFixed(2), (v) => { ui.clothStiff = v; });
bindRange('cloth-damp', (v) => v.toFixed(2), (v) => { ui.clothDamp = v; });
bindRange('flow-speed', (v) => v.toFixed(2), (v) => { ui.flowSpeed = v; });
bindRange('flow-swirl', (v) => v.toFixed(2), (v) => { ui.flowSwirl = v; });
bindRange('drop-wet', (v) => v.toFixed(2), (v) => {
  ui.dropWet = v;
  drop.setWetting(v);
  syncDropShapeChips();
});
bindRange('drop-skin', (v) => v.toFixed(2), (v) => { ui.dropSkin = v; });

function syncDropShapeChips() {
  const bead = ui.dropWet < 0.34;
  const wet = ui.dropWet > 0.72;
  document.querySelectorAll('[data-drop]').forEach((b) => {
    const on = (b.dataset.drop === 'bead' && bead) || (b.dataset.drop === 'wet' && wet);
    b.setAttribute('aria-pressed', String(on));
  });
}

document.querySelectorAll('[data-drop]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const wet = document.getElementById('drop-wet');
    const skin = document.getElementById('drop-skin');
    if (btn.dataset.drop === 'bead') {
      wet.value = '0.12';
      skin.value = '0.96';
    } else {
      wet.value = '0.92';
      skin.value = '0.7';
    }
    wet.dispatchEvent(new Event('input'));
    skin.dispatchEvent(new Event('input'));
  });
});

document.querySelectorAll('[data-drop-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    ui.dropMode = btn.dataset.dropMode;
    dropScene.userData.controls.enabled = ui.dropMode === 'orbit';
    dropScene.userData.element.classList.toggle('mode-pull', ui.dropMode === 'poke');
    if (ui.dropMode !== 'poke') drop.releaseGrab();
    document.querySelectorAll('[data-drop-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  });
});

const dropEl = document.querySelector('[data-scene="drop"]');
dropEl.addEventListener('pointerdown', (e) => {
  if (ui.dropMode !== 'poke') return;
  ndcFromEvent(e, dropEl);
  raycaster.setFromCamera(ndc, dropScene.userData.camera);
  const hits = raycaster.intersectObject(drop.mesh, false);
  if (!hits.length || !hits[0].face) return;
  const face = hits[0].face;
  const p = hits[0].point;
  let best = face.a;
  let bestD = Infinity;
  for (const idx of [face.a, face.b, face.c]) {
    const o = idx * 3;
    const d = (drop.pos[o] - p.x) ** 2 + (drop.pos[o + 1] - p.y) ** 2 + (drop.pos[o + 2] - p.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = idx;
    }
  }
  if (!drop.grabAt(best)) return;
  dropEl.setPointerCapture(e.pointerId);
  e.preventDefault();
});
dropEl.addEventListener('pointermove', (e) => {
  if (drop.grab < 0 || ui.dropMode !== 'poke') return;
  ndcFromEvent(e, dropEl);
  raycaster.setFromCamera(ndc, dropScene.userData.camera);
  const o = drop.grab * 3;
  grabHit.set(drop.pos[o], drop.pos[o + 1], drop.pos[o + 2]);
  dropScene.userData.camera.getWorldDirection(camForward);
  grabPlane.setFromNormalAndCoplanarPoint(camForward, grabHit);
  if (!raycaster.ray.intersectPlane(grabPlane, grabHit)) return;
  drop.moveGrab(grabHit.x, grabHit.y, grabHit.z);
  drop.sync();
});
function endDropGrab() {
  drop.releaseGrab();
}
dropEl.addEventListener('pointerup', endDropGrab);
dropEl.addEventListener('pointercancel', endDropGrab);

document.querySelectorAll('[data-wave]').forEach((btn) => {
  btn.addEventListener('click', () => {
    ui.waveDrive = btn.dataset.wave === 'continuous';
    document.querySelectorAll('[data-wave]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  });
});

document.getElementById('wave-drop').addEventListener('click', () => {
  basin.drop(0.15, 0.05, 1.1 + ui.waveAmp * 3);
});

const waveEl = document.querySelector('[data-scene="wave"]');
let waveDown = null;
waveEl.addEventListener('pointerdown', (e) => {
  waveDown = { x: e.clientX, y: e.clientY };
});
waveEl.addEventListener('pointerup', (e) => {
  if (!waveDown) return;
  const dx = e.clientX - waveDown.x;
  const dy = e.clientY - waveDown.y;
  waveDown = null;
  if (dx * dx + dy * dy > 64) return;
  ndcFromEvent(e, waveEl);
  raycaster.setFromCamera(ndc, waveScene.userData.camera);
  const hits = raycaster.intersectObject(basin.mesh, false);
  let x = 0.1;
  let z = 0;
  if (hits.length) {
    x = hits[0].point.x;
    z = hits[0].point.z;
  }
  basin.drop(x, z, 1.15 + ui.waveAmp * 3.2);
});

document.querySelectorAll('[data-cloth-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    ui.clothMode = btn.dataset.clothMode;
    clothScene.userData.controls.enabled = ui.clothMode === 'orbit';
    const el = clothScene.userData.element;
    el.classList.toggle('mode-pull', ui.clothMode === 'pull');
    document.querySelectorAll('[data-cloth-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  });
});

document.getElementById('cloth-gust').addEventListener('click', () => {
  cloth.gust = Math.max(cloth.gust, 1.7);
  cloth.holdUntil = performance.now() + 1800;
});
document.getElementById('cloth-reset').addEventListener('click', () => {
  cloth.reset();
  for (let i = 0; i < 40; i++) {
    cloth.step(1 / 60, { wind: ui.clothWind, stiff: ui.clothStiff, damp: 0.9, flutter: false, time: 0 });
  }
  cloth.sync();
});

const clothEl = document.querySelector('[data-scene="cloth"]');
clothEl.addEventListener('pointerdown', (e) => {
  if (ui.clothMode !== 'pull') return;
  ndcFromEvent(e, clothEl);
  raycaster.setFromCamera(ndc, clothScene.userData.camera);
  const hits = raycaster.intersectObject(cloth.mesh, false);
  if (!hits.length || !hits[0].face) return;
  const face = hits[0].face;
  const p = hits[0].point;
  let best = face.a;
  let bestD = Infinity;
  for (const idx of [face.a, face.b, face.c]) {
    const o = idx * 3;
    const d = (cloth.pos[o] - p.x) ** 2 + (cloth.pos[o + 1] - p.y) ** 2 + (cloth.pos[o + 2] - p.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = idx;
    }
  }
  if (!cloth.grabAt(best)) return;
  clothEl.setPointerCapture(e.pointerId);
  e.preventDefault();
});
clothEl.addEventListener('pointermove', (e) => {
  if (cloth.grab < 0 || ui.clothMode !== 'pull') return;
  ndcFromEvent(e, clothEl);
  raycaster.setFromCamera(ndc, clothScene.userData.camera);
  const o = cloth.grab * 3;
  grabHit.set(cloth.pos[o], cloth.pos[o + 1], cloth.pos[o + 2]);
  clothScene.userData.camera.getWorldDirection(camForward);
  grabPlane.setFromNormalAndCoplanarPoint(camForward, grabHit);
  if (!raycaster.ray.intersectPlane(grabPlane, grabHit)) return;
  cloth.moveGrab(grabHit.x, grabHit.y, grabHit.z);
  cloth.sync();
});
function endClothGrab() {
  cloth.releaseGrab();
}
clothEl.addEventListener('pointerup', endClothGrab);
clothEl.addEventListener('pointercancel', endClothGrab);

document.getElementById('flow-reset').addEventListener('click', () => {
  flow.release();
  flowGeo.attributes.position.needsUpdate = true;
  for (let i = 0; i < tracers.length; i++) {
    const lane = tracers[i].userData.lane;
    tracers[i].position.set(-2.7, 0.14, lane * 0.72);
  }
});

let driveOn = true;
const driveEl = document.getElementById('cmp-drive');
const driveOut = document.getElementById('cmp-drive-out');
function syncDrive() {
  driveOn = Number(driveEl.value) === 1;
  driveOut.textContent = driveOn ? 'ON' : 'OFF';
  ui.drive = driveOn;
}
driveEl.addEventListener('input', syncDrive);
driveEl.addEventListener('change', syncDrive);
syncDrive();

function placeFloats(floats, field, amp) {
  for (const f of floats) {
    const y = field.heightAt(f.x, f.z, amp);
    const radius = f.mesh.geometry.parameters?.radius ?? 0.08;
    f.mesh.position.y = y + radius;
  }
}

waveScene.userData.update = (_t, dt) => {
  const advance = motionOK() && ui.waveDrive;
  const ripples = motionOK() || performance.now() < basin.liveUntil;
  const amp = basin.step(dt, {
    amp: ui.waveAmp,
    tempo: ui.waveTempo,
    damp: ui.waveDamp,
    drive: ui.waveDrive,
    advance,
    ripples,
  });
  placeFloats(waveFloats, basin, amp);
  const bob = Math.sin(basin.phase);
  paddle.position.x = -waveW / 2 + 0.14 + bob * 0.05 * (ui.waveDrive ? 1 : 0);
  paddle.position.y = -0.02 + bob * ui.waveAmp * 0.15;
};

clothScene.userData.update = (t, dt) => {
  const active = motionOK() || cloth.grab >= 0 || cloth.gust > 0.02 || performance.now() < cloth.holdUntil;
  if (active) {
    cloth.step(Math.min(dt, 0.033), {
      wind: ui.clothWind,
      stiff: ui.clothStiff,
      damp: ui.clothDamp,
      flutter: motionOK(),
      time: t,
    });
  }
  cloth.sync();
};

flowScene.userData.update = (_t, dt) => {
  if (!motionOK() || ui.flowSpeed <= 0) return;
  const step = Math.min(dt, 0.033);
  flow.step(step, ui.flowSpeed, ui.flowSwirl);
  flowGeo.attributes.position.needsUpdate = true;
  for (const tr of tracers) {
    let x = tr.position.x;
    let z = tr.position.z;
    const v = flow.velocity(x, z, ui.flowSpeed, ui.flowSwirl);
    x += v.x * step;
    z += v.z * step;
    if (z > 1.05) z = 1.05;
    if (z < -1.05) z = -1.05;
    if (x > 3.05) {
      x = -3.05;
      z = tr.userData.homeZ;
    }
    tr.position.x = x;
    tr.position.z = z;
  }
};

cmpWaveScene.userData.update = (_t, dt) => {
  const advance = motionOK() && ui.drive;
  const amp = cmpWave.step(dt, {
    amp: 0.15,
    tempo: 0.85,
    damp: 0.2,
    drive: true,
    advance,
    ripples: false,
  });
  placeFloats(cmpFloats, cmpWave, amp);
  cmpPaddle.position.x = -2 + 0.14 + Math.sin(cmpWave.phase) * 0.045;
};

cmpClothScene.userData.update = (t, dt) => {
  if (!(motionOK() && ui.drive)) {
    cmpCloth.sync();
    return;
  }
  cmpCloth.step(Math.min(dt, 0.033), {
    wind: 0.42 + Math.sin(t * 0.7) * 0.18,
    stiff: 0.84,
    damp: 0.97,
    flutter: true,
    time: t,
  });
  cmpCloth.sync();
};

dropScene.userData.update = (t, dt) => {
  const motion = motionOK();
  if (motion && drop.grab < 0) {
    if (drop.nextDent < 0) drop.nextDent = t + 1.7;
    else if (t >= drop.nextDent) {
      drop.dent();
      drop.nextDent = t + 4.8;
    }
  }
  drop.step(Math.min(dt, 0.033), { skin: ui.dropSkin, motion });
  drop.sync();
};

/* ——— Render loop (single context, scissor per element) ——— */
let visible = !document.hidden;
document.addEventListener('visibilitychange', () => {
  visible = !document.hidden;
  if (visible) {
    last = performance.now();
    renderer.setAnimationLoop(animate);
  } else {
    renderer.setAnimationLoop(null);
  }
});

function updateSize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const pr = pixelCap();
  if (canvas.width !== Math.floor(w * pr) || canvas.height !== Math.floor(h * pr)) {
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
  }
}

window.addEventListener('resize', () => {
  updateSize();
});

let last = performance.now();
let frameCount = 0;

function animate(now) {
  if (!visible) return;
  frameCount += 1;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  updateSize();

  renderer.setScissorTest(false);
  renderer.setClearColor(0x0c0a08, 1);
  renderer.clear();
  renderer.setScissorTest(true);

  const time = now * 0.001;
  for (const scene of scenes) {
    const element = scene.userData.element;
    const rect = element.getBoundingClientRect();
    const canvasH = renderer.domElement.clientHeight;
    const canvasW = renderer.domElement.clientWidth;
    if (
      rect.bottom < 0 ||
      rect.top > canvasH ||
      rect.right < 0 ||
      rect.left > canvasW ||
      rect.width === 0 ||
      rect.height === 0
    ) {
      continue;
    }
    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    const left = rect.left;
    const bottom = canvasH - rect.bottom;
    const camera = scene.userData.camera;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (scene.userData.update) scene.userData.update(time, dt);
    scene.userData.controls.update();
    renderer.setViewport(left, bottom, width, height);
    renderer.setScissor(left, bottom, width, height);
    renderer.render(scene, camera);
  }
}

window.__SML = {
  renderer,
  canvas,
  scenes,
  basin,
  cloth,
  flow,
  drop,
  ui,
  get frameCount() { return frameCount; },
  get reducedMotion() { return reducedMotion; },
  get still() { return stillParam; },
  get embed() { return embed; },
  motionOK,
  webglContexts: () => document.querySelectorAll('canvas').length,
};

updateSize();
renderer.setAnimationLoop(animate);
