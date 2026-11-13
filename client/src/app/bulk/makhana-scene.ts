import {
  ACESFilmicToneMapping,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer
} from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/* =========================================================
   MAKHANA 3D SCENE
   Purpose: show what the buyer is choosing. Blossoms are drawn at
   their real relative size (4 to 7 Suta) and the quality toggle
   changes the finish (Normal keeps a few dark specks, Handpicked
   is clean and whiter).

   - 'pile'   : a small pile on a brass plate; grows/shrinks with the
                selected Suta grade. Plate size is fixed, so the size
                difference is easy to read.
   - 'lineup' : all four grades side by side (hero).

   Performance: lazy-loaded, pauses off-screen / in background tabs,
   caps pixel ratio, and renders on demand with reduced motion.
   ========================================================= */

export type SceneMode = 'pile' | 'lineup';
export type SceneGrade = '4' | '5' | '6' | '7';
export type SceneQuality = 'normal' | 'handpicked';

export interface SceneOptions {
  mode: SceneMode;
  interactive: boolean;
  lowPower: boolean;
  reducedMotion: boolean;
}

/** Relative blossom diameter per grade (matches the 10-24 mm range). */
export const GRADE_SCALE: Record<SceneGrade, number> = {
  '4': 0.74,
  '5': 0.92,
  '6': 1.12,
  '7': 1.4
};

const GRADES: SceneGrade[] = ['4', '5', '6', '7'];

interface Blossom {
  group: Group;
  mesh: Mesh;
  specks: Group;
  blob: Mesh;
  variation: number;
  grade: SceneGrade;
  /** current / target size factor */
  size: number;
  target: number;
  /** transient "pop" when the size changes */
  pop: number;
  bobPhase: number;
  slot: { x: number; z: number; lift: number };
}

const NORMAL_COLOR = new Color('#efe0c0');
const HANDPICKED_COLOR = new Color('#fffdf5');

export class MakhanaScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(32, 1, 0.1, 60);
  private readonly root = new Group();
  private readonly blossoms: Blossom[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];

  private readonly material = new MeshStandardMaterial({
    vertexColors: true,
    color: NORMAL_COLOR.clone(),
    roughness: 0.84,
    metalness: 0
  });
  private readonly speckMaterial = new MeshStandardMaterial({ color: '#3b2716', roughness: 0.9 });

  private grade: SceneGrade = '6';
  private quality: SceneQuality = 'normal';
  private qualityMix = 0;
  private qualityTarget = 0;

  private rotation = 0;
  private velocity = 0;
  private dragging = false;
  private lastX = 0;
  private tiltX = 0;
  private tiltY = 0;
  private tiltTargetX = 0;
  private tiltTargetY = 0;

  private raf = 0;
  private lastTime = 0;
  private visible = true;
  private disposed = false;
  private dirty = true;

  private readonly resizeObserver: ResizeObserver;
  private readonly intersectionObserver: IntersectionObserver;
  private readonly cleanups: Array<() => void> = [];

  constructor(private readonly canvas: HTMLCanvasElement, private readonly options: SceneOptions) {
    // Throws when WebGL is unavailable. The caller shows the static fallback.
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: !options.lowPower,
      alpha: true,
      powerPreference: 'low-power'
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(0x000000, 0);

    this.buildLights();
    this.buildGeometry();
    this.buildBlossoms();

    this.scene.add(this.root);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);

    this.intersectionObserver = new IntersectionObserver(entries => {
      this.visible = entries.some(e => e.isIntersecting);
      if (this.visible) {
        this.dirty = true;
      }
    });
    this.intersectionObserver.observe(canvas);

    if (options.interactive) {
      this.bindPointer();
    }

    this.resize();
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(t => this.frame(t));
  }

  /* ---------- Public API ---------- */

  setGrade(grade: SceneGrade): void {
    if (grade === this.grade) {
      return;
    }

    this.grade = grade;

    if (this.options.mode === 'pile') {
      for (const b of this.blossoms) {
        b.grade = grade;
        b.target = GRADE_SCALE[grade];
        b.pop = 0.16;
      }
    }

    this.resize();
    this.dirty = true;
  }

  setQuality(quality: SceneQuality): void {
    this.quality = quality;
    this.qualityTarget = quality === 'handpicked' ? 1 : 0;
    this.dirty = true;
  }

  /** Call after the canvas has been moved to a different parent element. */
  reattach(): void {
    this.resizeObserver.disconnect();
    this.resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
    this.resize();
  }

  /** Spin the scene a little, e.g. driven by page scroll. */
  nudge(amount: number): void {
    this.velocity = Math.max(-2.5, Math.min(2.5, this.velocity + amount));
    this.dirty = true;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    this.cleanups.forEach(fn => fn());

    for (const g of this.geometries) {
      g.dispose();
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.material.dispose();
    this.speckMaterial.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /* ---------- Scene construction ---------- */

  private buildLights(): void {
    this.scene.add(new HemisphereLight(0xfff3dc, 0x7a5c30, 1.0));

    const key = new DirectionalLight(0xfff0d0, 2.6);
    key.position.set(4, 7, 5);
    this.scene.add(key);

    const fill = new DirectionalLight(0xbfe3cf, 0.7);
    fill.position.set(-6, 2, -2);
    this.scene.add(fill);

    const rim = new DirectionalLight(0xffd9a0, 1.4);
    rim.position.set(-2, 4, -7);
    this.scene.add(rim);
  }

  /** Three lumpy, smooth-shaded blossom shapes so the pile looks organic. */
  private buildGeometry(): void {
    const widthSeg = this.options.lowPower ? 28 : 44;
    const heightSeg = this.options.lowPower ? 20 : 30;

    for (let variant = 0; variant < 3; variant++) {
      const seed = 1.3 + variant * 2.1;

      let geometry: BufferGeometry = new SphereGeometry(0.5, widthSeg, heightSeg);
      geometry.deleteAttribute('uv');
      geometry.deleteAttribute('normal');
      geometry = mergeVertices(geometry, 1e-4);

      const position = geometry.getAttribute('position') as BufferAttribute;
      const colors = new Float32Array(position.count * 3);
      const v = new Vector3();

      for (let i = 0; i < position.count; i++) {
        v.fromBufferAttribute(position, i).normalize();

        const bump =
          1 +
          0.11 * Math.sin(v.x * 3.1 + seed) * Math.sin(v.y * 2.7 + seed * 1.7) * Math.sin(v.z * 3.3 + seed * 0.6) +
          0.05 * Math.sin(v.x * 7 + seed * 2) * Math.sin(v.y * 6.1) * Math.cos(v.z * 6.6 + seed);

        position.setXYZ(i, v.x * 0.5 * bump, v.y * 0.5 * bump * 0.94, v.z * 0.5 * bump);

        const shade = 0.93 + 0.07 * Math.sin(v.x * 11 + seed) * Math.sin(v.z * 9.7 + seed);
        colors[i * 3] = shade;
        colors[i * 3 + 1] = shade * 0.985;
        colors[i * 3 + 2] = shade * 0.96;
      }

      geometry.setAttribute('color', new BufferAttribute(colors, 3));
      geometry.computeVertexNormals();
      this.geometries.push(geometry);
    }
  }

  private buildBlossoms(): void {
    const blobTexture = this.makeBlobTexture();
    this.disposables.push(blobTexture);

    const specksGeometry = new SphereGeometry(0.034, 8, 6);
    this.geometries.push(specksGeometry);

    const blobGeometry = new CircleGeometry(0.62, 32);
    blobGeometry.rotateX(-Math.PI / 2);
    this.geometries.push(blobGeometry);

    if (this.options.mode === 'pile') {
      const plateGeometry = new CylinderGeometry(2.75, 2.85, 0.1, this.options.lowPower ? 40 : 72);
      const plateMaterial = new MeshStandardMaterial({ color: '#c4a15a', metalness: 0.55, roughness: 0.38 });
      const plate = new Mesh(plateGeometry, plateMaterial);
      plate.position.y = -0.05;
      this.geometries.push(plateGeometry);
      this.disposables.push(plateMaterial);
      this.root.add(plate);
    }

    const slots = this.options.mode === 'pile' ? this.pileSlots() : this.lineupSlots();

    slots.forEach((slot, index) => {
      const grade = this.options.mode === 'pile' ? this.grade : GRADES[index];
      const variation = this.options.mode === 'pile' ? 0.92 + ((index * 37) % 17) / 100 : 1;

      const mesh = new Mesh(this.geometries[index % 3], this.material);
      const group = new Group();
      group.add(mesh);
      mesh.rotation.set(index * 1.7, index * 2.3, index * 0.6);

      const specks = new Group();
      for (let i = 0; i < 6; i++) {
        const dot = new Mesh(specksGeometry, this.speckMaterial);
        const a = (i + index * 0.7) * 2.399963;
        const y = 0.85 - (i / 5) * 1.7;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        dot.position.set(Math.cos(a) * r, y, Math.sin(a) * r).multiplyScalar(0.492);
        dot.scale.set(1.3, 0.6, 1.3);
        dot.lookAt(dot.position.clone().multiplyScalar(2));
        specks.add(dot);
      }
      group.add(specks);

      const blobMaterial = new MeshBasicMaterial({
        map: blobTexture,
        transparent: true,
        depthWrite: false,
        opacity: 0.55
      });
      this.disposables.push(blobMaterial);
      const blob = new Mesh(blobGeometry, blobMaterial);

      this.root.add(blob);
      this.root.add(group);

      const size = GRADE_SCALE[grade];
      this.blossoms.push({
        group,
        mesh,
        specks,
        blob,
        variation,
        grade,
        size,
        target: size,
        pop: 0,
        bobPhase: index * 1.3,
        slot
      });
    });
  }

  /** Five around, one resting on top, in unit blossom diameters. */
  private pileSlots(): Array<{ x: number; z: number; lift: number }> {
    const slots: Array<{ x: number; z: number; lift: number }> = [];

    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2 + 0.35;
      slots.push({ x: Math.cos(angle) * 0.95, z: Math.sin(angle) * 0.95, lift: 0.5 });
    }

    slots.push({ x: 0, z: 0, lift: 0.78 });
    return slots;
  }

  /** x positions are computed from the real sizes so nothing overlaps. */
  private lineupSlots(): Array<{ x: number; z: number; lift: number }> {
    const gap = 0.45;
    const radii = GRADES.map(g => GRADE_SCALE[g] * 0.5);
    const total = radii.reduce((sum, r) => sum + r * 2, 0) + gap * (GRADES.length - 1);

    let cursor = -total / 2;
    return radii.map((r, i) => {
      const x = cursor + r;
      cursor += r * 2 + gap;
      return { x, z: i % 2 === 0 ? 0.25 : -0.25, lift: r + 0.04 };
    });
  }

  private makeBlobTexture(): CanvasTexture {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');

    if (ctx) {
      const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
      g.addColorStop(0, 'rgba(40,24,8,0.75)');
      g.addColorStop(0.55, 'rgba(40,24,8,0.28)');
      g.addColorStop(1, 'rgba(40,24,8,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
    }

    return new CanvasTexture(c);
  }

  /* ---------- Interaction ---------- */

  private bindPointer(): void {
    const canvas = this.canvas;
    canvas.style.touchAction = 'pan-y';
    canvas.style.cursor = 'grab';

    const down = (e: PointerEvent): void => {
      this.dragging = true;
      this.lastX = e.clientX;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    };

    const move = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      this.tiltTargetX = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
      this.tiltTargetY = ((e.clientY - rect.top) / rect.height - 0.5) * 2;

      if (this.dragging) {
        const dx = e.clientX - this.lastX;
        this.lastX = e.clientX;
        this.rotation += dx * 0.012;
        this.velocity = dx * 0.012 * 60;
        this.dirty = true;
      }
    };

    const up = (e: PointerEvent): void => {
      this.dragging = false;
      canvas.style.cursor = 'grab';
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    };

    const leave = (): void => {
      this.tiltTargetX = 0;
      this.tiltTargetY = 0;
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', leave);

    this.cleanups.push(() => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('pointerleave', leave);
    });
  }

  /* ---------- Sizing ---------- */

  private resize(): void {
    const host = this.canvas.parentElement ?? this.canvas;
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, this.options.lowPower ? 1.5 : 2);

    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;

    // Frame the content: the pile is a fixed plate; the lineup is as wide as its blossoms.
    const fov = (this.camera.fov * Math.PI) / 180;
    const aspect = this.camera.aspect;
    let extentX: number;
    let extentY: number;
    let elevation: number;
    let targetY: number;

    if (this.options.mode === 'pile') {
      extentX = 6.1;
      extentY = 4.6;
      elevation = 0.5;
      targetY = 0.55;
    } else {
      extentX = 6.1;
      extentY = 2.7;
      elevation = 0.18;
      targetY = 0.55;
    }

    const distance = Math.max(extentY / (2 * Math.tan(fov / 2)), extentX / (2 * Math.tan(fov / 2) * aspect));
    this.camera.position.set(0, targetY + Math.sin(elevation) * distance, Math.cos(elevation) * distance);
    this.camera.lookAt(0, targetY, 0);
    this.camera.updateProjectionMatrix();

    this.dirty = true;
  }

  /* ---------- Frame loop ---------- */

  private frame(time: number): void {
    if (this.disposed) {
      return;
    }

    this.raf = requestAnimationFrame(t => this.frame(t));

    const dt = Math.min(0.05, (time - this.lastTime) / 1000);
    this.lastTime = time;

    if (!this.visible || document.hidden) {
      return;
    }

    const animate = !this.options.reducedMotion;
    let moving = this.dirty;

    // Size transition and quality finish.
    const ease = 1 - Math.exp(-dt * 7);

    for (const b of this.blossoms) {
      const before = b.size;
      b.size += (b.target - b.size) * ease;
      b.pop *= Math.exp(-dt * 6);

      if (Math.abs(b.size - before) > 1e-4 || b.pop > 1e-3) {
        moving = true;
      }
    }

    const qualityBefore = this.qualityMix;
    this.qualityMix += (this.qualityTarget - this.qualityMix) * ease;
    if (Math.abs(this.qualityMix - qualityBefore) > 1e-4) {
      moving = true;
    }

    this.material.color.copy(NORMAL_COLOR).lerp(HANDPICKED_COLOR, this.qualityMix);
    const speckScale = Math.max(0.0001, 1 - this.qualityMix);

    // Rotation: drag + inertia, then idle motion.
    // The pile spins freely; the lineup must stay readable, so it sways and springs back.
    if (!this.dragging) {
      this.rotation += this.velocity * dt;
      this.velocity *= Math.exp(-dt * 2.6);

      if (this.options.mode === 'pile') {
        if (animate) {
          this.rotation += dt * 0.35;
        }
      } else {
        this.rotation -= this.rotation * (1 - Math.exp(-dt * 1.8));
      }
    }

    this.tiltX += (this.tiltTargetX - this.tiltX) * ease * 0.6;
    this.tiltY += (this.tiltTargetY - this.tiltY) * ease * 0.6;

    const sway = animate && this.options.mode === 'lineup' ? Math.sin(time / 1000 * 0.55) * 0.2 : 0;
    const maxLineupTurn = 0.7;
    const turn = this.options.mode === 'lineup'
      ? Math.max(-maxLineupTurn, Math.min(maxLineupTurn, this.rotation))
      : this.rotation;

    this.root.rotation.y = turn + sway + this.tiltX * (this.options.mode === 'lineup' ? 0.15 : 0.25);
    this.root.rotation.x = this.tiltY * 0.06;

    if (animate || moving) {
      const t = time / 1000;

      for (const b of this.blossoms) {
        const scale = b.size * b.variation * (1 + b.pop);
        const bob = animate && this.options.mode === 'lineup' ? Math.sin(t * 1.3 + b.bobPhase) * 0.06 : 0;
        const lift = this.options.mode === 'pile' ? b.slot.lift * b.size * b.variation : b.slot.lift;
        const spread = this.options.mode === 'pile' ? b.size : 1;

        b.group.position.set(b.slot.x * spread, lift + bob, b.slot.z * spread);
        b.group.scale.setScalar(scale);
        b.specks.scale.setScalar(speckScale);

        b.blob.position.set(b.group.position.x, 0.004, b.group.position.z);
        b.blob.scale.setScalar(scale * 1.25);
        const height = Math.max(0, b.group.position.y - scale * 0.5);
        (b.blob.material as MeshBasicMaterial).opacity = Math.max(0.15, 0.55 - height * 0.4);
      }

      moving = true;
    }

    if (moving || Math.abs(this.velocity) > 0.001 || this.dragging) {
      this.renderer.render(this.scene, this.camera);
      this.dirty = false;
    }
  }
}

/** Heuristic for slower phones and tablets: fewer polygons and a lower pixel ratio. */
export function isLowPowerDevice(): boolean {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return (
    window.innerWidth < 760 ||
    (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) ||
    (navigator.hardwareConcurrency !== undefined && navigator.hardwareConcurrency <= 4)
  );
}
