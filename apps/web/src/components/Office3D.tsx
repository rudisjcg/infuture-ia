import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import * as THREE from "three";
import {
  Buildings,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  Coffee,
  Crosshair,
  Cube,
  CubeFocus,
  CursorClick,
  Desktop,
  Gps,
  GridFour,
  HardDrives,
  Info,
  PencilSimple,
  Plus,
  PresentationChart,
  Robot,
  UserFocus,
  UsersThree,
} from "@phosphor-icons/react";
import "./Office3D.css";
import {
  ALL_ZONE_KEYS,
  CHARACTER_TEMPLATES,
  ZONE_LAYOUT,
  type CharLive,
  type CharSummary,
  type OfficeConfig,
  type Template,
  type ZoneKey,
  type ZoneOrHall,
} from "./officeModel";
export * from "./officeModel";
import {
  CreateOfficeDialog,
  EditOfficeDialog,
  updateOffice,
  type OfficeUpdate,
  DEFAULT_OFFICE_ID,
  OfficeDashboard,
  createOffice,
  defaultOffice,
  deleteOffice,
  loadOffices,
  useLiveData,
  type DashScope,
  type NewOffice,
  type OfficeSource,
} from "./OfficeHub";

/*
 * 2.5D virtual office. Faithful port of docs/mockups/office-virtual-2-5d.html
 * (same constants, colors, sizes and camera values) to React + three.
 */

// ============================================================================
// Office configuration and grid constants
// ============================================================================
const OFFICE_SIZE = 20; // 20x20 m (-10..+10 on X and Z)
const HALF_SIZE = OFFICE_SIZE / 2;

type CameraMode = "iso" | "top" | "follow";
type RenderMode = "hybrid" | "sprite" | "mesh3d";
type Dir = "up" | "left" | "down" | "right";

type Avatar3D = {
  root: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  torso: THREE.Mesh;
  head: THREE.Group;
};

type Character = CharSummary & {
  group: THREE.Group;
  sprite: THREE.Sprite;
  baseDisc: THREE.Mesh;
  avatar: Avatar3D;
  heading: number;
  textures: { right: THREE.CanvasTexture[]; left: THREE.CanvasTexture[] };
  labelEl: HTMLDivElement;
  position: THREE.Vector3;
  targetPos: THREE.Vector3;
  hasTarget: boolean;
  speed: number;
  facingLeft: boolean;
  animTimer: number;
  patrolCooldown: number;
  isMovingNow: boolean;
  zone: ZoneOrHall;
};

type Engine = {
  setCameraMode: (m: CameraMode) => void;
  setPatrol: (on: boolean) => void;
  setRenderMode: (m: RenderMode) => void;
  select: (id: number) => void;
  /** Adds a character and returns the template used, so it can be persisted. */
  spawn: () => Template;
  sendToZone: (z: ZoneKey) => void;
  setActivePosition: (x: number, z: number, clamp: boolean) => void;
  centerOnActive: () => void;
  setTouchKey: (d: Dir, on: boolean) => void;
  minimapClick: (normX: number, normZ: number) => void;
  snapshot: () => CharLive[];
};

function worldToGrid(x: number, z: number) {
  const col = Math.min(19, Math.max(0, Math.floor(x + HALF_SIZE)));
  const row = Math.min(19, Math.max(0, Math.floor(z + HALF_SIZE)));
  return { col, row };
}

function detectZoneIn(keys: ZoneKey[], x: number, z: number): ZoneOrHall {
  for (const key of keys) {
    const zone = ZONE_LAYOUT[key];
    if (Math.hypot(x - zone.x, z - zone.z) <= zone.radius) return key;
  }
  return "hallway";
}

// ============================================================================
// Real 3D character (used by the "Pure 3D" render mode)
// ============================================================================
function createAvatar3D(template: Template, charId: number): Avatar3D {
  const mat = (color: string | number, rough = 0.7) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough });
  const skinMat = mat(template.skin);
  const shirtMat = mat(template.shirt);
  const pantsMat = mat(0x1e293b);
  const shoeMat = mat(0x0f172a);
  const hairMat = mat(template.hair, 0.9);
  const accentMat = mat(template.color, 0.4);
  const mesh = (geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
    const me = new THREE.Mesh(geo, m);
    me.position.set(x, y, z);
    me.castShadow = true;
    me.userData = { charId };
    return me;
  };
  const root = new THREE.Group();
  root.userData = { charId };

  // Legs pivot at the hip so they can swing.
  const makeLeg = (side: number) => {
    const g = new THREE.Group();
    g.position.set(0.12 * side, 0.62, 0);
    g.add(mesh(new THREE.BoxGeometry(0.17, 0.52, 0.2), pantsMat, 0, -0.27, 0));
    g.add(mesh(new THREE.BoxGeometry(0.19, 0.09, 0.28), shoeMat, 0, -0.56, 0.04));
    root.add(g);
    return g;
  };
  const legL = makeLeg(-1);
  const legR = makeLeg(1);

  const torso = mesh(new THREE.BoxGeometry(0.5, 0.56, 0.28), shirtMat, 0, 0.9, 0);
  root.add(torso);
  // Collar / badge strip in the character's accent color.
  root.add(mesh(new THREE.BoxGeometry(0.22, 0.06, 0.02), accentMat, 0, 1.12, 0.15));

  const makeArm = (side: number) => {
    const g = new THREE.Group();
    g.position.set(0.33 * side, 1.13, 0);
    g.add(mesh(new THREE.BoxGeometry(0.14, 0.44, 0.16), shirtMat, 0, -0.2, 0));
    g.add(mesh(new THREE.BoxGeometry(0.12, 0.1, 0.13), skinMat, 0, -0.46, 0));
    root.add(g);
    return g;
  };
  const armL = makeArm(-1);
  const armR = makeArm(1);

  const head = new THREE.Group();
  head.position.set(0, 1.42, 0);
  head.add(mesh(new THREE.BoxGeometry(0.4, 0.4, 0.38), skinMat));
  head.add(mesh(new THREE.BoxGeometry(0.44, 0.13, 0.42), hairMat, 0, 0.22, -0.01));
  head.add(mesh(new THREE.BoxGeometry(0.44, 0.3, 0.1), hairMat, 0, 0.06, -0.17));
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x0f172a });
  head.add(mesh(new THREE.BoxGeometry(0.06, 0.07, 0.02), eyeMat, -0.09, 0.03, 0.195));
  head.add(mesh(new THREE.BoxGeometry(0.06, 0.07, 0.02), eyeMat, 0.09, 0.03, 0.195));

  if (template.accessory === "glasses") {
    const glassMat = mat(0x38bdf8, 0.2);
    head.add(mesh(new THREE.BoxGeometry(0.13, 0.1, 0.02), glassMat, -0.09, 0.03, 0.205));
    head.add(mesh(new THREE.BoxGeometry(0.13, 0.1, 0.02), glassMat, 0.09, 0.03, 0.205));
    head.add(mesh(new THREE.BoxGeometry(0.06, 0.02, 0.02), glassMat, 0, 0.05, 0.205));
  } else if (template.accessory === "headphones") {
    head.add(mesh(new THREE.BoxGeometry(0.5, 0.05, 0.08), accentMat, 0, 0.3, 0));
    head.add(mesh(new THREE.BoxGeometry(0.07, 0.16, 0.14), accentMat, -0.23, 0.02, 0));
    head.add(mesh(new THREE.BoxGeometry(0.07, 0.16, 0.14), accentMat, 0.23, 0.02, 0));
  } else if (template.accessory === "cap") {
    head.add(mesh(new THREE.BoxGeometry(0.46, 0.1, 0.44), accentMat, 0, 0.27, 0));
    head.add(mesh(new THREE.BoxGeometry(0.4, 0.03, 0.18), accentMat, 0, 0.23, 0.27));
  } else if (template.accessory === "badge") {
    root.add(mesh(new THREE.BoxGeometry(0.1, 0.13, 0.02), mat(0xf8fafc), 0.12, 0.95, 0.15));
  }
  root.add(head);
  root.visible = false;
  return { root, armL, armR, legL, legR, torso, head };
}

function stateText(t: TFunction, c: Character) {
  const zone = t(`office.zones.${c.zone}`);
  return c.isMovingNow ? t("office.stateWalking", { zone }) : t("office.stateIn", { zone });
}

function initials(name: string) {
  return name.substring(0, 2).toUpperCase();
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );

// ============================================================================
// Procedural 2D sprite frames (idle / walk x right / left)
// ============================================================================
function createCharacterSpriteSheetFrame(template: Template, frameIndex: number, facingLeft: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 160;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  if (facingLeft) {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  const walkOffset = frameIndex === 1 ? -4 : frameIndex === 2 ? 4 : 0;
  const bodyBob = frameIndex === 1 || frameIndex === 2 ? -3 : 0;

  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  ctx.beginPath();
  ctx.ellipse(64, 148, 28, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#1e293b";
  ctx.beginPath();
  ctx.roundRect(44, 105 + (walkOffset > 0 ? -5 : 0), 16, 36, 6);
  ctx.fill();
  ctx.fillStyle = "#0f172a";
  ctx.beginPath();
  ctx.roundRect(42, 135 + (walkOffset > 0 ? -5 : 0), 20, 10, 4);
  ctx.fill();

  ctx.fillStyle = "#334155";
  ctx.beginPath();
  ctx.roundRect(68, 105 + (walkOffset < 0 ? -5 : 0), 16, 36, 6);
  ctx.fill();
  ctx.fillStyle = "#0f172a";
  ctx.beginPath();
  ctx.roundRect(68, 135 + (walkOffset < 0 ? -5 : 0), 20, 10, 4);
  ctx.fill();

  ctx.fillStyle = template.shirt;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(36, 62 + bodyBob, 56, 50, 14);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#f8fafc";
  ctx.beginPath();
  ctx.roundRect(66, 74 + bodyBob, 14, 18, 3);
  ctx.fill();
  ctx.fillStyle = template.color;
  ctx.fillRect(68, 77 + bodyBob, 10, 5);

  ctx.fillStyle = template.shirt;
  ctx.beginPath();
  ctx.roundRect(24, 66 + bodyBob - walkOffset * 0.8, 14, 34, 7);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(90, 66 + bodyBob + walkOffset * 0.8, 14, 34, 7);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = template.skin;
  ctx.beginPath();
  ctx.roundRect(38, 18 + bodyBob, 52, 46, 18);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = template.hair;
  ctx.beginPath();
  ctx.roundRect(36, 12 + bodyBob, 56, 20, [16, 16, 4, 4]);
  ctx.fill();

  ctx.fillStyle = "#0f172a";
  ctx.beginPath();
  ctx.arc(56, 42 + bodyBob, 4.2, 0, Math.PI * 2);
  ctx.arc(76, 42 + bodyBob, 4.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(57.5, 40.5 + bodyBob, 1.5, 0, Math.PI * 2);
  ctx.arc(77.5, 40.5 + bodyBob, 1.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#7c2d12";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(66, 48 + bodyBob, 6, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();

  if (template.accessory === "glasses") {
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 2.5;
    ctx.strokeRect(48, 36 + bodyBob, 15, 11);
    ctx.strokeRect(68, 36 + bodyBob, 15, 11);
    ctx.beginPath();
    ctx.moveTo(63, 41 + bodyBob);
    ctx.lineTo(68, 41 + bodyBob);
    ctx.stroke();
  } else if (template.accessory === "headphones") {
    ctx.strokeStyle = template.color;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(64, 36 + bodyBob, 30, Math.PI, 0);
    ctx.stroke();
    ctx.fillStyle = template.color;
    ctx.fillRect(31, 32 + bodyBob, 8, 18);
    ctx.fillRect(89, 32 + bodyBob, 8, 18);
  } else if (template.accessory === "cap") {
    ctx.fillStyle = template.color;
    ctx.beginPath();
    ctx.roundRect(34, 10 + bodyBob, 66, 12, 6);
    ctx.fill();
  }
  ctx.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

// ============================================================================
// Scene engine: everything imperative lives here, React only renders the HUD.
// ============================================================================
type EngineDom = {
  root: HTMLDivElement;
  canvasHost: HTMLDivElement;
  labels: HTMLDivElement;
  minimap: HTMLCanvasElement;
};

type EngineCallbacks = {
  t: () => TFunction;
  onSelect: (id: number) => void;
  onCharacters: (list: CharSummary[]) => void;
  onZoneOpen: (zone: ZoneKey) => void;
};

function createEngine(
  dom: EngineDom,
  cb: EngineCallbacks,
  office: OfficeConfig,
  initialRender: RenderMode,
): { api: Engine; dispose: () => void } {
  const q = <T extends Element>(sel: string) => dom.root.querySelector<T>(sel);
  const ZONE_KEYS: ZoneKey[] = ALL_ZONE_KEYS.filter((k) => office.zones.includes(k));
  const OFFICE_ZONES = ZONE_LAYOUT;
  const detectZone = (x: number, z: number) => detectZoneIn(ZONE_KEYS, x, z);
  const themeColor = new THREE.Color(office.theme);

  // r128 rendered without color management and with "legacy" light units; reproduce that look.
  const prevColorManagement = THREE.ColorManagement.enabled;
  THREE.ColorManagement.enabled = false;

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  const clock = new THREE.Clock();

  let cameraMode: CameraMode = "iso";
  const camSpherical = { radius: 22, theta: Math.PI / 4, phi: Math.PI / 3.2 };
  const camTarget = new THREE.Vector3(0, 0, 0);
  let isDraggingCamera = false;
  let isPanningCamera = false;
  let pointerDownPos = { x: 0, y: 0 };
  let prevPointerPos = { x: 0, y: 0 };

  const characters: Character[] = [];
  let activeCharId = 0;
  let globalPatrolEnabled = true;
  let renderMode: RenderMode = initialRender;

  const keysPressed = {
    w: false,
    a: false,
    s: false,
    d: false,
    up: false,
    left: false,
    down: false,
    right: false,
  };
  const touchKeys: Record<Dir, boolean> = { up: false, left: false, down: false, right: false };
  const furnitureColliders: { x: number; z: number; radius: number }[] = [];
  const hoveredFloorPoint = new THREE.Vector3();

  const width = () => Math.max(1, dom.canvasHost.clientWidth);
  const height = () => Math.max(1, dom.canvasHost.clientHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x090d16);
  scene.fog = new THREE.FogExp2(0x090d16, 0.015);

  const camera = new THREE.PerspectiveCamera(42, width() / height(), 0.1, 120);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setSize(width(), height());
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  dom.canvasHost.appendChild(renderer.domElement);

  // Legacy (r128) light intensities expressed in physical units: x PI, point-light decay 1.
  const L = Math.PI;
  scene.add(new THREE.AmbientLight(0xdbeafe, 0.65 * L));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.85 * L);
  dirLight.position.set(14, 24, 16);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 60;
  const d = 14;
  dirLight.shadow.camera.left = -d;
  dirLight.shadow.camera.right = d;
  dirLight.shadow.camera.top = d;
  dirLight.shadow.camera.bottom = -d;
  dirLight.shadow.bias = -0.0005;
  scene.add(dirLight);

  const addPoint = (color: number, intensity: number, dist: number, x: number, y: number, z: number) => {
    const p = new THREE.PointLight(color, intensity * L, dist, 1);
    p.position.set(x, y, z);
    scene.add(p);
  };
  addPoint(0x6366f1, 0.8, 10, -5, 3, -5);
  addPoint(0xf59e0b, 0.7, 9, -5, 3, 5);
  addPoint(0x0ea5e9, 0.9, 9, 6, 3, 5);

  // ---------------------------------------------------------------- environment
  const floorCanvas = document.createElement("canvas");
  floorCanvas.width = 1024;
  floorCanvas.height = 1024;
  const fctx = floorCanvas.getContext("2d")!;
  fctx.fillStyle = "#131c2e";
  fctx.fillRect(0, 0, 1024, 1024);
  const cells = 20;
  const step = 1024 / cells;
  for (let x = 0; x < cells; x++) {
    for (let z = 0; z < cells; z++) {
      fctx.fillStyle = (x + z) % 2 === 0 ? "#162032" : "#111827";
      fctx.fillRect(x * step, z * step, step, step);
      fctx.strokeStyle = "rgba(51, 65, 85, 0.45)";
      fctx.lineWidth = 2;
      fctx.strokeRect(x * step, z * step, step, step);
    }
  }
  fctx.strokeStyle = `rgba(${Math.round(themeColor.r * 255)}, ${Math.round(themeColor.g * 255)}, ${Math.round(themeColor.b * 255)}, 0.4)`;
  fctx.lineWidth = 4;
  fctx.beginPath();
  fctx.moveTo(512, 0);
  fctx.lineTo(512, 1024);
  fctx.moveTo(0, 512);
  fctx.lineTo(1024, 512);
  fctx.stroke();
  const floorTex = new THREE.CanvasTexture(floorCanvas);
  floorTex.wrapS = THREE.ClampToEdgeWrapping;
  floorTex.wrapT = THREE.ClampToEdgeWrapping;

  const floorMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(OFFICE_SIZE, OFFICE_SIZE),
    new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.8, metalness: 0.1 }),
  );
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.receiveShadow = true;
  floorMesh.name = "office_floor";
  scene.add(floorMesh);

  const baseMesh = new THREE.Mesh(
    new THREE.BoxGeometry(OFFICE_SIZE + 0.6, 0.5, OFFICE_SIZE + 0.6),
    new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.9 }),
  );
  baseMesh.position.y = -0.26;
  scene.add(baseMesh);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.7 });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.22,
    roughness: 0.1,
    transmission: 0.5,
  });

  const northWall = new THREE.Mesh(new THREE.BoxGeometry(OFFICE_SIZE + 0.4, 2.8, 0.3), wallMat);
  northWall.position.set(0, 1.4, -HALF_SIZE - 0.15);
  northWall.castShadow = true;
  northWall.receiveShadow = true;
  scene.add(northWall);

  const westWall = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.8, OFFICE_SIZE + 0.4), wallMat);
  westWall.position.set(-HALF_SIZE - 0.15, 1.4, 0);
  westWall.castShadow = true;
  westWall.receiveShadow = true;
  scene.add(westWall);

  const zoneRugs: THREE.Mesh[] = [];
  function addZoneRug(key: ZoneKey) {
    const r = OFFICE_ZONES[key].rug;
    const rug = new THREE.Mesh(
      r.round ? new THREE.CircleGeometry(r.w, 40) : new THREE.PlaneGeometry(r.w, r.d),
      new THREE.MeshStandardMaterial({ color: r.color, roughness: 0.9, transparent: true, opacity: 0.45 }),
    );
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(r.x, 0.01, r.z);
    rug.receiveShadow = true;
    rug.userData = { zoneKey: key };
    scene.add(rug);
    zoneRugs.push(rug);
  }
  ZONE_KEYS.forEach(addZoneRug);

  function createWorkstation(x: number, z: number, rotY: number) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = rotY;
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.6 });
    const legMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: 0.5 });
    const screenMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 0.6,
    });

    const top = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.08, 1.0), woodMat);
    top.position.y = 0.75;
    top.castShadow = true;
    top.receiveShadow = true;
    group.add(top);
    for (const [lx, lz] of [
      [-0.95, -0.4],
      [0.95, -0.4],
      [-0.95, 0.4],
      [0.95, 0.4],
    ] as const) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.75, 0.08), legMat);
      leg.position.set(lx, 0.375, lz);
      leg.castShadow = true;
      group.add(leg);
    }
    for (const side of [-1, 1]) {
      const monitor = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.4, 0.05), legMat);
      monitor.position.set(0.35 * side, 1.05, -0.25);
      monitor.rotation.y = -0.15 * side;
      group.add(monitor);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.34), screenMat);
      glow.position.set(0.35 * side, 1.05, -0.22);
      glow.rotation.y = -0.15 * side;
      group.add(glow);
    }
    const chairSeat = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.08, 0.55),
      new THREE.MeshStandardMaterial({ color: 0x4f46e5 }),
    );
    chairSeat.position.set(0, 0.45, 0.65);
    chairSeat.castShadow = true;
    group.add(chairSeat);
    const chairBack = new THREE.Mesh(
      new THREE.BoxGeometry(0.52, 0.55, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x4338ca }),
    );
    chairBack.position.set(0, 0.75, 0.9);
    chairBack.castShadow = true;
    group.add(chairBack);
    scene.add(group);
    furnitureColliders.push({ x, z, radius: 1.05 });
  }

  function createMeetingRoom(x: number, z: number) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    const tableTop = new THREE.Mesh(
      new THREE.BoxGeometry(3.8, 0.1, 1.8),
      new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.4 }),
    );
    tableTop.position.y = 0.76;
    tableTop.castShadow = true;
    tableTop.receiveShadow = true;
    group.add(tableTop);
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 1.4, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x0f172a }),
    );
    board.position.set(0, 1.6, -4.8);
    group.add(board);
    const boardScreen = new THREE.Mesh(
      new THREE.PlaneGeometry(3.0, 1.25),
      new THREE.MeshStandardMaterial({ color: 0x10b981, emissive: 0x059669, emissiveIntensity: 0.45 }),
    );
    boardScreen.position.set(0, 1.6, -4.74);
    group.add(boardScreen);
    const chairMat = new THREE.MeshStandardMaterial({ color: 0x10b981 });
    for (const cx of [-1.2, 0, 1.2]) {
      for (const cz of [-1.25, 1.25]) {
        const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.5), chairMat);
        seat.position.set(cx, 0.225, cz);
        seat.castShadow = true;
        group.add(seat);
      }
    }
    scene.add(group);
    furnitureColliders.push({ x, z, radius: 1.6 });
  }

  function createCoffeeBreakArea(x: number, z: number) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    const counter = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 0.9, 0.9),
      new THREE.MeshStandardMaterial({ color: 0x451a03, roughness: 0.7 }),
    );
    counter.position.set(-0.8, 0.45, 2.2);
    counter.castShadow = true;
    group.add(counter);
    const coffeeMachine = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.55, 0.5),
      new THREE.MeshStandardMaterial({ color: 0xdc2626, metalness: 0.5 }),
    );
    coffeeMachine.position.set(-1.4, 1.15, 2.2);
    coffeeMachine.castShadow = true;
    group.add(coffeeMachine);
    const sofa1 = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 0.55, 0.9),
      new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.8 }),
    );
    sofa1.position.set(0.5, 0.275, -1.2);
    sofa1.castShadow = true;
    group.add(sofa1);
    const roundTable = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 0.7, 0.45, 20),
      new THREE.MeshStandardMaterial({ color: 0xfef3c7 }),
    );
    roundTable.position.set(0.5, 0.225, 0.2);
    roundTable.castShadow = true;
    group.add(roundTable);
    scene.add(group);
    furnitureColliders.push({ x: x + 0.5, z: z + 0.2, radius: 0.85 });
  }

  function createServerZone(x: number, z: number) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    const rackMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: 0.7, roughness: 0.3 });
    const ledMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    const ledWarnMat = new THREE.MeshBasicMaterial({ color: 0x22c55e });
    for (let i = 0; i < 3; i++) {
      const rack = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.3, 1.1), rackMat);
      rack.position.set((i - 1) * 1.45, 1.15, 1.2);
      rack.castShadow = true;
      group.add(rack);
      for (let row = 0; row < 5; row++) {
        const led = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.08), row % 2 === 0 ? ledMat : ledWarnMat);
        led.position.set((i - 1) * 1.45, 0.5 + row * 0.35, 0.64);
        led.rotation.y = Math.PI;
        group.add(led);
      }
    }
    scene.add(group);
    furnitureColliders.push({ x, z: z + 1.2, radius: 1.8 });
  }

  function createPlant(x: number, z: number) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    const pot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.25, 0.5, 12),
      new THREE.MeshStandardMaterial({ color: 0x9a3412 }),
    );
    pot.position.y = 0.25;
    pot.castShadow = true;
    group.add(pot);
    const foliage = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.55, 1),
      new THREE.MeshStandardMaterial({ color: 0x16a34a, roughness: 0.8 }),
    );
    foliage.position.y = 0.85;
    foliage.castShadow = true;
    group.add(foliage);
    scene.add(group);
  }

  function createReception(x: number, z: number) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    const desk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 0.9, 0.95, 24, 1, false, 0, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.5 }),
    );
    desk.position.y = 0.475;
    desk.castShadow = true;
    group.add(desk);
    const logo = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.18, 0.05),
      new THREE.MeshStandardMaterial({ color: themeColor, emissive: themeColor, emissiveIntensity: 0.6 }),
    );
    logo.position.set(0, 0.6, 0.92);
    group.add(logo);
    scene.add(group);
    furnitureColliders.push({ x, z, radius: 1.0 });
  }

  if (ZONE_KEYS.includes("dev")) {
    createWorkstation(-6.5, -6.2, 0);
    createWorkstation(-3.5, -6.2, 0);
    createWorkstation(-6.5, -3.5, Math.PI);
    createWorkstation(-3.5, -3.5, Math.PI);
  }
  if (ZONE_KEYS.includes("meeting")) {
    createMeetingRoom(5.0, -5.0);
    const dividerGlass = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.2, 6.5), glassMat);
    dividerGlass.position.set(1.2, 1.1, -5.0);
    scene.add(dividerGlass);
  }
  if (ZONE_KEYS.includes("coffee")) createCoffeeBreakArea(-5.2, 5.2);
  if (ZONE_KEYS.includes("servers")) createServerZone(5.8, 5.2);
  if (ZONE_KEYS.includes("reception")) createReception(0, 0.6);
  createPlant(-9.0, -9.0);
  createPlant(9.0, -9.0);
  createPlant(-9.0, 9.0);
  createPlant(9.0, 9.0);
  createPlant(0.8, -1.8);
  createPlant(-1.2, 1.8);

  // ---------------------------------------------------------------- markers
  const activeRingMat = new THREE.MeshBasicMaterial({
    color: 0x6366f1,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
  });
  const activeRingMesh = new THREE.Mesh(new THREE.RingGeometry(0.48, 0.64, 32), activeRingMat);
  activeRingMesh.rotation.x = -Math.PI / 2;
  activeRingMesh.position.y = 0.03;
  scene.add(activeRingMesh);

  const targetMat = new THREE.MeshBasicMaterial({
    color: 0x10b981,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.0,
  });
  const targetMarkerMesh = new THREE.Mesh(new THREE.RingGeometry(0.25, 0.38, 24), targetMat);
  targetMarkerMesh.rotation.x = -Math.PI / 2;
  targetMarkerMesh.position.y = 0.04;
  scene.add(targetMarkerMesh);

  const pathLineMesh = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.05, 0), new THREE.Vector3(0, 0.05, 0)]),
    new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.65 }),
  );
  scene.add(pathLineMesh);

  // ---------------------------------------------------------------- characters
  const summaries = () => characters.map(({ id, name, roleKey, color }) => ({ id, name, roleKey, color }));

  function createCharacterInstance(template: Template, startX: number, startZ: number) {
    const id = characters.length;
    const group = new THREE.Group();
    group.position.set(startX, 0, startZ);
    const textures = {
      right: [0, 1, 2].map((f) => createCharacterSpriteSheetFrame(template, f, false)),
      left: [0, 1, 2].map((f) => createCharacterSpriteSheetFrame(template, f, true)),
    };
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: textures.right[0], transparent: true }));
    sprite.scale.set(1.5, 1.85, 1);
    sprite.position.y = 0.92;
    sprite.userData = { charId: id };
    group.add(sprite);

    const baseDisc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.46, 0.08, 24),
      new THREE.MeshStandardMaterial({ color: template.color, roughness: 0.3, metalness: 0.2 }),
    );
    baseDisc.position.y = 0.04;
    baseDisc.castShadow = true;
    baseDisc.receiveShadow = true;
    baseDisc.userData = { charId: id };
    baseDisc.visible = renderMode !== "sprite";
    group.add(baseDisc);

    const avatar = createAvatar3D(template, id);
    avatar.root.position.y = 0.08;
    group.add(avatar.root);
    sprite.visible = renderMode !== "mesh3d";
    avatar.root.visible = renderMode === "mesh3d";
    scene.add(group);

    const labelEl = document.createElement("div");
    labelEl.className = "ov-label";
    labelEl.addEventListener("click", (e) => {
      e.stopPropagation();
      selectCharacter(id);
    });
    dom.labels.appendChild(labelEl);

    const c: Character = {
      id,
      name: template.name,
      roleKey: template.roleKey,
      color: template.color,
      group,
      sprite,
      baseDisc,
      avatar,
      heading: 0,
      textures,
      labelEl,
      position: group.position,
      targetPos: new THREE.Vector3(startX, 0, startZ),
      hasTarget: false,
      speed: 4.2,
      facingLeft: false,
      animTimer: Math.random() * 10,
      patrolCooldown: 2 + Math.random() * 3,
      isMovingNow: false,
      zone: detectZone(startX, startZ),
    };
    characters.push(c);
    return c;
  }

  function clampToOfficeBounds(x: number, z: number) {
    const margin = 0.65;
    let cx = Math.max(-HALF_SIZE + margin, Math.min(HALF_SIZE - margin, x));
    let cz = Math.max(-HALF_SIZE + margin, Math.min(HALF_SIZE - margin, z));
    for (const col of furnitureColliders) {
      const dx = cx - col.x;
      const dz = cz - col.z;
      const dist = Math.hypot(dx, dz);
      if (dist < col.radius && dist > 0.001) {
        cx = col.x + (dx / dist) * col.radius;
        cz = col.z + (dz / dist) * col.radius;
      }
    }
    return { x: cx, z: cz };
  }

  function selectCharacter(id: number) {
    activeCharId = id;
    const c = characters[id];
    if (!c) return;
    activeRingMat.color.set(c.color);
    cb.onSelect(id);
    syncInspector();
  }

  function setTarget(c: Character, x: number, z: number) {
    c.targetPos.set(x, 0, z);
    c.hasTarget = true;
    targetMarkerMesh.position.set(x, 0.04, z);
    targetMat.opacity = 0.95;
  }

  // Per-frame HUD sync (same as the mockup's direct DOM updates; avoids 60fps React renders).
  function syncInspector() {
    const c = characters[activeCharId];
    if (!c) return;
    const t = cb.t();
    const xStr = c.position.x.toFixed(2);
    const yStr = c.position.y.toFixed(2);
    const zStr = c.position.z.toFixed(2);
    const grid = worldToGrid(c.position.x, c.position.z);
    const inputX = q<HTMLInputElement>("[data-ov=input-x]");
    const inputY = q<HTMLInputElement>("[data-ov=input-y]");
    const inputZ = q<HTMLInputElement>("[data-ov=input-z]");
    if (inputX && document.activeElement !== inputX) inputX.value = xStr;
    if (inputY) inputY.value = yStr;
    if (inputZ && document.activeElement !== inputZ) inputZ.value = zStr;
    const sx = q<HTMLInputElement>("[data-ov=slider-x]");
    const sz = q<HTMLInputElement>("[data-ov=slider-z]");
    if (sx) sx.value = String(c.position.x);
    if (sz) sz.value = String(c.position.z);
    const setText = (sel: string, text: string) => {
      const el = q<HTMLElement>(sel);
      if (el && el.textContent !== text) el.textContent = text;
    };
    setText("[data-ov=slider-x-val]", xStr);
    setText("[data-ov=slider-z-val]", zStr);
    setText("[data-ov=active-grid]", t("office.gridColRow", { col: grid.col, row: grid.row }));
    setText("[data-ov=active-state-text]", stateText(t, c));
    const dot = q<HTMLElement>("[data-ov=active-state-dot]");
    if (dot) dot.classList.toggle("is-moving", c.isMovingNow);
  }

  /** Faces the movement direction and swings arms/legs while walking (Pure 3D mode). */
  function animateAvatar(c: Character, vx: number, vz: number, dt: number) {
    const a = c.avatar;
    if (c.isMovingNow) {
      const target = Math.atan2(vx, vz);
      let diff = target - c.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      c.heading += diff * Math.min(1, dt * 12);
    }
    a.root.rotation.y = c.heading;
    const swing = c.isMovingNow ? Math.sin(c.animTimer * 1.5) * 0.7 : 0;
    const ease = Math.min(1, dt * 14);
    a.legL.rotation.x += (swing - a.legL.rotation.x) * ease;
    a.legR.rotation.x += (-swing - a.legR.rotation.x) * ease;
    a.armL.rotation.x += (-swing * 0.8 - a.armL.rotation.x) * ease;
    a.armR.rotation.x += (swing * 0.8 - a.armR.rotation.x) * ease;
    // Idle breathing; while walking the whole group already bobs.
    a.torso.scale.y = c.isMovingNow ? 1 : 1 + Math.sin(c.animTimer * 1.2) * 0.015;
    a.head.rotation.z = c.isMovingNow ? Math.sin(c.animTimer * 1.5) * 0.04 : 0;
  }

  function updateCharacters(dt: number) {
    let moveX = 0;
    let moveZ = 0;
    if (keysPressed.w || keysPressed.up || touchKeys.up) moveZ -= 1;
    if (keysPressed.s || keysPressed.down || touchKeys.down) moveZ += 1;
    if (keysPressed.a || keysPressed.left || touchKeys.left) moveX -= 1;
    if (keysPressed.d || keysPressed.right || touchKeys.right) moveX += 1;
    const isManualInput = moveX !== 0 || moveZ !== 0;
    const t = cb.t();

    for (const c of characters) {
      const isSelected = c.id === activeCharId;
      let vx = 0;
      let vz = 0;
      if (isSelected && isManualInput) {
        c.hasTarget = false;
        targetMat.opacity = 0;
        const len = Math.hypot(moveX, moveZ);
        const normX = moveX / len;
        const normZ = moveZ / len;
        if (cameraMode === "top") {
          vx = normX * c.speed;
          vz = normZ * c.speed;
        } else {
          const forward = new THREE.Vector3(
            Math.sin(camSpherical.theta),
            0,
            Math.cos(camSpherical.theta),
          ).normalize();
          const right = new THREE.Vector3(forward.z, 0, -forward.x);
          vx = (right.x * -normX + forward.x * normZ) * c.speed;
          vz = (right.z * -normX + forward.z * normZ) * c.speed;
        }
      } else if (c.hasTarget) {
        const dx = c.targetPos.x - c.position.x;
        const dz = c.targetPos.z - c.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.12) {
          vx = (dx / dist) * c.speed;
          vz = (dz / dist) * c.speed;
        } else {
          c.position.x = c.targetPos.x;
          c.position.z = c.targetPos.z;
          c.hasTarget = false;
          if (isSelected) targetMat.opacity = 0;
        }
      } else if (!isSelected && globalPatrolEnabled) {
        c.patrolCooldown -= dt;
        if (c.patrolCooldown <= 0) {
          const zoneKey = ZONE_KEYS[Math.floor(Math.random() * ZONE_KEYS.length)];
          const randomZone = zoneKey ? OFFICE_ZONES[zoneKey] : undefined;
          if (randomZone) {
            const clamped = clampToOfficeBounds(
              randomZone.x + (Math.random() - 0.5) * 2.6,
              randomZone.z + (Math.random() - 0.5) * 2.6,
            );
            c.targetPos.set(clamped.x, 0, clamped.z);
            c.hasTarget = true;
            c.patrolCooldown = 4 + Math.random() * 5;
          }
        }
      }

      c.isMovingNow = Math.hypot(vx, vz) > 0.05;
      const mat = c.sprite.material;
      if (c.isMovingNow) {
        const next = clampToOfficeBounds(c.position.x + vx * dt, c.position.z + vz * dt);
        c.position.x = next.x;
        c.position.z = next.z;
        if (Math.abs(vx) > 0.05) c.facingLeft = vx < 0;
        c.animTimer += dt * 9;
        const frameIdx = (Math.floor(c.animTimer) % 2) + 1;
        mat.map = c.textures[c.facingLeft ? "left" : "right"][frameIdx] ?? null;
        c.position.y = Math.abs(Math.sin(c.animTimer * 1.5)) * 0.14;
      } else {
        c.animTimer += dt * 2;
        mat.map = c.textures[c.facingLeft ? "left" : "right"][0] ?? null;
        c.position.y = 0;
      }
      if (renderMode === "mesh3d") animateAvatar(c, vx, vz, dt);
      c.zone = detectZone(c.position.x, c.position.z);

      const xyzEl = q<HTMLElement>(`[data-ov=xyz-${c.id}]`);
      const gridEl = q<HTMLElement>(`[data-ov=grid-${c.id}]`);
      const stateEl = q<HTMLElement>(`[data-ov=state-${c.id}]`);
      if (xyzEl && gridEl && stateEl) {
        const g = worldToGrid(c.position.x, c.position.z);
        xyzEl.textContent = `(${c.position.x.toFixed(1)}, ${c.position.z.toFixed(1)})`;
        gridEl.textContent = `[${g.col}, ${g.row}]`;
        stateEl.textContent = stateText(t, c);
      }
    }

    const activeChar = characters[activeCharId];
    if (activeChar) {
      activeRingMesh.position.x = activeChar.position.x;
      activeRingMesh.position.z = activeChar.position.z;
      activeRingMesh.rotation.z += dt * 1.5;
      if (activeChar.hasTarget) {
        const attr = pathLineMesh.geometry.attributes.position as THREE.BufferAttribute;
        const p = attr.array as Float32Array;
        p[0] = activeChar.position.x;
        p[1] = 0.06;
        p[2] = activeChar.position.z;
        p[3] = activeChar.targetPos.x;
        p[4] = 0.06;
        p[5] = activeChar.targetPos.z;
        attr.needsUpdate = true;
        pathLineMesh.visible = true;
      } else {
        pathLineMesh.visible = false;
      }
      syncInspector();
    }
    updateFloatingLabels();
  }

  const headWorldPos = new THREE.Vector3();
  function updateFloatingLabels() {
    const halfW = width() / 2;
    const halfH = height() / 2;
    const t = cb.t();
    for (const c of characters) {
      headWorldPos.set(c.position.x, c.position.y + 2.05, c.position.z).project(camera);
      if (headWorldPos.z > 1) {
        c.labelEl.style.display = "none";
        continue;
      }
      c.labelEl.style.display = "flex";
      c.labelEl.style.left = `${headWorldPos.x * halfW + halfW}px`;
      c.labelEl.style.top = `${-(headWorldPos.y * halfH) + halfH}px`;
      const isSelected = c.id === activeCharId;
      const grid = worldToGrid(c.position.x, c.position.z);
      c.labelEl.classList.toggle("is-active", isSelected);
      const html =
        `<div class="ov-label-row"><span class="ov-label-dot" style="background:${c.color}"></span>` +
        `<span class="ov-label-name">${escapeHtml(c.name)}</span>` +
        (isSelected ? `<span class="ov-label-you">${escapeHtml(t("office.you"))}</span>` : "") +
        `</div><div class="mono ov-label-coords">X:${c.position.x.toFixed(1)} Y:${c.position.y.toFixed(1)} Z:${c.position.z.toFixed(1)} ` +
        `<span class="ov-amber">[${grid.col},${grid.row}]</span></div>`;
      if (c.labelEl.innerHTML !== html) c.labelEl.innerHTML = html;
    }
  }

  // ---------------------------------------------------------------- minimap
  const mctx = dom.minimap.getContext("2d")!;
  function drawMinimap() {
    const t = cb.t();
    const w = dom.minimap.width;
    const h = dom.minimap.height;
    mctx.fillStyle = "#090d16";
    mctx.fillRect(0, 0, w, h);
    const s = w / 20;
    mctx.strokeStyle = "rgba(51, 65, 85, 0.35)";
    mctx.lineWidth = 1;
    for (let i = 0; i <= 20; i++) {
      mctx.beginPath();
      mctx.moveTo(i * s, 0);
      mctx.lineTo(i * s, h);
      mctx.moveTo(0, i * s);
      mctx.lineTo(w, i * s);
      mctx.stroke();
    }
    const mapCoord = (val: number) => ((val + HALF_SIZE) / OFFICE_SIZE) * w;
    for (const key of ZONE_KEYS) {
      const z = OFFICE_ZONES[key];
      const zx = mapCoord(z.x);
      const zz = mapCoord(z.z);
      mctx.fillStyle = z.color + "28";
      mctx.strokeStyle = z.color + "88";
      mctx.beginPath();
      mctx.arc(zx, zz, (z.radius / OFFICE_SIZE) * w, 0, Math.PI * 2);
      mctx.fill();
      mctx.stroke();
      // Label pill: clicking it opens the zone dashboard.
      mctx.font = "600 9px Inter";
      const lw = mctx.measureText(t(`office.zones.${key}`)).width + 8;
      mctx.fillStyle = "rgba(15, 23, 42, 0.85)";
      mctx.strokeStyle = z.color + "aa";
      mctx.beginPath();
      mctx.roundRect(zx - lw / 2, zz - 7, lw, 14, 7);
      mctx.fill();
      mctx.stroke();
      mctx.fillStyle = "#cbd5e1";
      mctx.textAlign = "center";
      mctx.fillText(t(`office.zones.${key}`), zx, zz + 3);
    }
    for (const c of characters) {
      const cx = mapCoord(c.position.x);
      const cz = mapCoord(c.position.z);
      if (c.hasTarget) {
        mctx.strokeStyle = c.color;
        mctx.setLineDash([3, 3]);
        mctx.beginPath();
        mctx.moveTo(cx, cz);
        mctx.lineTo(mapCoord(c.targetPos.x), mapCoord(c.targetPos.z));
        mctx.stroke();
        mctx.setLineDash([]);
      }
      mctx.fillStyle = c.color;
      mctx.beginPath();
      mctx.arc(cx, cz, c.id === activeCharId ? 6.5 : 4.5, 0, Math.PI * 2);
      mctx.fill();
      if (c.id === activeCharId) {
        mctx.strokeStyle = "#ffffff";
        mctx.lineWidth = 2;
        mctx.stroke();
      }
    }
  }

  // ---------------------------------------------------------------- camera
  const followTarget = new THREE.Vector3();
  function updateCameraTransform() {
    const c = characters[activeCharId];
    if (cameraMode === "follow" && c) {
      camTarget.lerp(followTarget.set(c.position.x, 0.5, c.position.z), 0.1);
    } else if (cameraMode === "top") {
      camSpherical.phi = 0.05;
    }
    const sinPhi = Math.sin(camSpherical.phi);
    camera.position.x = camTarget.x + camSpherical.radius * sinPhi * Math.sin(camSpherical.theta);
    camera.position.y = camTarget.y + camSpherical.radius * Math.cos(camSpherical.phi);
    camera.position.z = camTarget.z + camSpherical.radius * sinPhi * Math.cos(camSpherical.theta);
    camera.lookAt(camTarget);
  }

  // ---------------------------------------------------------------- input
  const domEl = renderer.domElement;
  const setNdc = (clientX: number, clientY: number) => {
    const rect = domEl.getBoundingClientRect();
    mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
  };
  const isTyping = () => {
    const el = document.activeElement;
    return (
      !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable)
    );
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (isTyping()) return;
    const k = e.key.toLowerCase();
    if (k === "w") keysPressed.w = true;
    if (k === "a") keysPressed.a = true;
    if (k === "s") keysPressed.s = true;
    if (k === "d") keysPressed.d = true;
    if (e.key === "ArrowUp") {
      keysPressed.up = true;
      e.preventDefault();
    }
    if (e.key === "ArrowLeft") {
      keysPressed.left = true;
      e.preventDefault();
    }
    if (e.key === "ArrowDown") {
      keysPressed.down = true;
      e.preventDefault();
    }
    if (e.key === "ArrowRight") {
      keysPressed.right = true;
      e.preventDefault();
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (k === "w") keysPressed.w = false;
    if (k === "a") keysPressed.a = false;
    if (k === "s") keysPressed.s = false;
    if (k === "d") keysPressed.d = false;
    if (e.key === "ArrowUp") keysPressed.up = false;
    if (e.key === "ArrowLeft") keysPressed.left = false;
    if (e.key === "ArrowDown") keysPressed.down = false;
    if (e.key === "ArrowRight") keysPressed.right = false;
  };
  const onMouseDown = (e: MouseEvent) => {
    pointerDownPos = { x: e.clientX, y: e.clientY };
    prevPointerPos = { x: e.clientX, y: e.clientY };
    if (e.button === 2 || e.shiftKey) isPanningCamera = true;
    else if (e.button === 0) isDraggingCamera = true;
  };
  const onMouseMove = (e: MouseEvent) => {
    setNdc(e.clientX, e.clientY);
    const floorHits = raycaster.intersectObject(floorMesh);
    if (floorHits.length > 0 && floorHits[0]) {
      const t = cb.t();
      hoveredFloorPoint.copy(floorHits[0].point);
      const g = worldToGrid(hoveredFloorPoint.x, hoveredFloorPoint.z);
      const xyz = q<HTMLElement>("[data-ov=hover-xyz]");
      const grid = q<HTMLElement>("[data-ov=hover-grid]");
      const zone = q<HTMLElement>("[data-ov=hover-zone]");
      if (xyz)
        xyz.textContent = t("office.hoverXZ", {
          x: hoveredFloorPoint.x.toFixed(2),
          z: hoveredFloorPoint.z.toFixed(2),
        });
      if (grid) grid.textContent = t("office.hoverGrid", { col: g.col, row: g.row });
      if (zone) zone.textContent = t(`office.zones.${detectZone(hoveredFloorPoint.x, hoveredFloorPoint.z)}`);
    }
    if (!isDraggingCamera && !isPanningCamera) return;
    const dx = e.clientX - prevPointerPos.x;
    const dy = e.clientY - prevPointerPos.y;
    prevPointerPos = { x: e.clientX, y: e.clientY };
    if (isDraggingCamera && cameraMode !== "top") {
      camSpherical.theta -= dx * 0.007;
      camSpherical.phi = Math.max(0.25, Math.min(Math.PI / 2.2, camSpherical.phi - dy * 0.006));
    } else if (isPanningCamera || (isDraggingCamera && cameraMode === "top")) {
      const panSpeed = 0.025;
      camTarget.x -= dx * panSpeed;
      camTarget.z -= dy * panSpeed;
    }
  };
  const onMouseUp = (e: MouseEvent) => {
    const moveDist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
    isDraggingCamera = false;
    isPanningCamera = false;
    if (moveDist < 6 && e.target === domEl && e.button === 0) handleSceneClick(e);
  };
  const onContextMenu = (e: MouseEvent) => e.preventDefault();
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    camSpherical.radius = Math.max(8, Math.min(38, camSpherical.radius + e.deltaY * 0.015));
  };
  function handleSceneClick(e: MouseEvent) {
    setNdc(e.clientX, e.clientY);
    // Sprites in 2D/hybrid mode, the 3D meshes (recursively) in Pure 3D mode.
    const targets = characters.map((c) => (renderMode === "mesh3d" ? c.avatar.root : c.sprite));
    const charHits = raycaster.intersectObjects(targets, true);
    for (const hit of charHits) {
      let obj: THREE.Object3D | null = hit.object;
      while (obj && obj.userData.charId === undefined) obj = obj.parent;
      const hitCharId = obj?.userData.charId as number | undefined;
      if (hitCharId !== undefined) {
        selectCharacter(hitCharId);
        return;
      }
    }
    const floorHits = raycaster.intersectObject(floorMesh);
    if (floorHits.length > 0 && floorHits[0]) {
      const pt = floorHits[0].point;
      const clamped = clampToOfficeBounds(pt.x, pt.z);
      const c = characters[activeCharId];
      if (c) setTarget(c, clamped.x, clamped.z);
    }
  }

  // Double-click on a zone rug opens that zone's dashboard (single clicks keep moving the character).
  const onDblClick = (e: MouseEvent) => {
    setNdc(e.clientX, e.clientY);
    const hit = raycaster.intersectObjects(zoneRugs)[0];
    const key = hit?.object.userData.zoneKey as ZoneKey | undefined;
    if (key) cb.onZoneOpen(key);
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  domEl.addEventListener("dblclick", onDblClick);
  domEl.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
  domEl.addEventListener("contextmenu", onContextMenu);
  domEl.addEventListener("wheel", onWheel, { passive: false });

  const resizeObserver = new ResizeObserver(() => {
    camera.aspect = width() / height();
    camera.updateProjectionMatrix();
    renderer.setSize(width(), height());
  });
  resizeObserver.observe(dom.canvasHost);

  // ---------------------------------------------------------------- boot
  updateCameraTransform();
  // Spread the office's people across its zones (the default office keeps the mockup's start spots).
  const DEFAULT_SPOTS = [
    [-4.5, -4.5],
    [4.2, -4.8],
    [5.5, 4.2],
    [-4.8, 4.5],
  ] as const;
  office.characters.forEach((tpl, i) => {
    const spot = office.isDefault ? DEFAULT_SPOTS[i] : undefined;
    if (spot) {
      createCharacterInstance(tpl, spot[0], spot[1]);
      return;
    }
    const zoneKey = ZONE_KEYS[i % Math.max(1, ZONE_KEYS.length)];
    const zone = zoneKey ? OFFICE_ZONES[zoneKey] : { x: 0, z: 0 };
    const p = clampToOfficeBounds(zone.x + (Math.random() - 0.5) * 2.4, zone.z + (Math.random() - 0.5) * 2.4);
    createCharacterInstance(tpl, p.x, p.z);
  });
  cb.onCharacters(summaries());
  if (characters.length > 0) selectCharacter(0);

  let raf = 0;
  const animate = () => {
    raf = requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1);
    updateCharacters(dt);
    updateCameraTransform();
    drawMinimap();
    if (targetMat.opacity > 0) {
      const s = 1 + Math.sin(clock.elapsedTime * 6) * 0.15;
      targetMarkerMesh.scale.set(s, s, 1);
    }
    renderer.render(scene, camera);
  };
  animate();

  const api: Engine = {
    setCameraMode(mode) {
      cameraMode = mode;
      if (mode === "iso") {
        camSpherical.phi = Math.PI / 3.2;
        camSpherical.theta = Math.PI / 4;
        camSpherical.radius = 22;
        camTarget.set(0, 0, 0);
      } else if (mode === "top") {
        camSpherical.phi = 0.02;
        camSpherical.theta = 0;
        camSpherical.radius = 24;
        camTarget.set(0, 0, 0);
      } else {
        camSpherical.phi = Math.PI / 3.4;
        camSpherical.radius = 14;
      }
    },
    setPatrol(on) {
      globalPatrolEnabled = on;
      if (!on) characters.forEach((c, idx) => idx !== activeCharId && (c.hasTarget = false));
    },
    setRenderMode(mode) {
      renderMode = mode;
      for (const c of characters) {
        c.baseDisc.visible = mode !== "sprite";
        c.sprite.visible = mode !== "mesh3d";
        c.avatar.root.visible = mode === "mesh3d";
      }
    },
    snapshot: () =>
      characters.map((c) => ({
        id: c.id,
        name: c.name,
        roleKey: c.roleKey,
        color: c.color,
        zone: c.zone,
        moving: c.isMovingNow,
      })),
    select: selectCharacter,
    spawn() {
      const template =
        CHARACTER_TEMPLATES[characters.length % CHARACTER_TEMPLATES.length] ?? CHARACTER_TEMPLATES[0]!;
      const randomX = parseFloat(((Math.random() - 0.5) * 6).toFixed(1));
      const randomZ = parseFloat(((Math.random() - 0.5) * 6).toFixed(1));
      const c = createCharacterInstance(
        { ...template, name: `${template.name} #${characters.length + 1}` },
        randomX,
        randomZ,
      );
      cb.onCharacters(summaries());
      selectCharacter(c.id);
      return { ...template, name: c.name };
    },
    sendToZone(key) {
      const zone = OFFICE_ZONES[key];
      const c = characters[activeCharId];
      if (!c) return;
      const dest = clampToOfficeBounds(
        zone.x + (Math.random() - 0.5) * 1.4,
        zone.z + (Math.random() - 0.5) * 1.4,
      );
      setTarget(c, dest.x, dest.z);
    },
    setActivePosition(x, z, clamp) {
      const c = characters[activeCharId];
      if (!c) return;
      const p = clamp ? clampToOfficeBounds(x, z) : { x, z };
      c.position.x = p.x;
      c.position.z = p.z;
      c.hasTarget = false;
      c.zone = detectZone(p.x, p.z);
      syncInspector();
    },
    centerOnActive() {
      const c = characters[activeCharId];
      if (c) camTarget.set(c.position.x, 0, c.position.z);
    },
    setTouchKey(dir, on) {
      touchKeys[dir] = on;
    },
    minimapClick(normX, normZ) {
      // A click on a zone's name opens its dashboard; anywhere else moves the active character.
      const w = dom.minimap.width;
      const px = normX * w;
      const pz = normZ * w;
      for (const key of ZONE_KEYS) {
        const z = OFFICE_ZONES[key];
        const zx = ((z.x + HALF_SIZE) / OFFICE_SIZE) * w;
        const zz = ((z.z + HALF_SIZE) / OFFICE_SIZE) * w;
        mctx.font = "600 9px Inter";
        const half = mctx.measureText(cb.t()(`office.zones.${key}`)).width / 2 + 4;
        if (Math.abs(px - zx) <= half && pz >= zz - 7 && pz <= zz + 7) {
          cb.onZoneOpen(key);
          return;
        }
      }
      const dest = clampToOfficeBounds(normX * OFFICE_SIZE - HALF_SIZE, normZ * OFFICE_SIZE - HALF_SIZE);
      const c = characters[activeCharId];
      if (c) setTarget(c, dest.x, dest.z);
    },
  };

  const dispose = () => {
    cancelAnimationFrame(raf);
    resizeObserver.disconnect();
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    domEl.removeEventListener("dblclick", onDblClick);
    domEl.removeEventListener("mousedown", onMouseDown);
    domEl.removeEventListener("contextmenu", onContextMenu);
    domEl.removeEventListener("wheel", onWheel);
    for (const c of characters) {
      c.labelEl.remove();
      c.textures.left.concat(c.textures.right).forEach((tex) => tex.dispose());
    }
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose();
    });
    floorTex.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    domEl.remove();
    THREE.ColorManagement.enabled = prevColorManagement;
  };

  return { api, dispose };
}

// ============================================================================
// React HUD
// ============================================================================
const RENDER_MODES: RenderMode[] = ["hybrid", "sprite", "mesh3d"];
const RENDER_LABEL: Record<RenderMode, string> = {
  hybrid: "office.renderHybrid",
  sprite: "office.renderSprite",
  mesh3d: "office.render3d",
};

const ZONE_ICON: Record<ZoneKey, { Icon: typeof Desktop; cls: string; label: string }> = {
  dev: { Icon: Desktop, cls: "ov-indigo", label: "office.sendDev" },
  meeting: { Icon: PresentationChart, cls: "ov-emerald", label: "office.sendMeeting" },
  coffee: { Icon: Coffee, cls: "ov-amber4", label: "office.sendCoffee" },
  servers: { Icon: HardDrives, cls: "ov-sky", label: "office.sendServers" },
  reception: { Icon: Buildings, cls: "ov-purple", label: "office.sendReception" },
};

/** Phosphor "radar" (duotone) icon; the installed @phosphor-icons/react version does not ship it. */
function RadarIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      width="1em"
      height="1em"
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="128" cy="128" r="96" opacity="0.2" />
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="16">
        <circle cx="128" cy="128" r="96" />
        <path d="M128,128,195.88,60.12" />
        <path d="M167.6,88.4A56,56,0,1,0,184,128" />
        <path d="M144,128a16,16,0,1,1-16-16" />
      </g>
    </svg>
  );
}

export function Office3D() {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const tRef = useRef(t);
  tRef.current = t;

  const [characters, setCharacters] = useState<CharSummary[]>([]);
  const [activeId, setActiveId] = useState(0);
  const [cameraMode, setCameraMode] = useState<CameraMode>("iso");
  const [patrol, setPatrol] = useState(true);
  const [renderMode, setRenderMode] = useState<RenderMode>("hybrid");

  // Offices: loaded from the API (/api/v1/offices) with a localStorage fallback.
  const [offices, setOffices] = useState<OfficeConfig[]>(() => [defaultOffice()]);
  const [officeSource, setOfficeSource] = useState<OfficeSource>("local");
  const [officeId, setOfficeId] = useState(DEFAULT_OFFICE_ID);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dash, setDash] = useState<DashScope | null>(null);
  const live = useLiveData();
  const office = offices.find((o) => o.id === officeId) ?? offices[0] ?? defaultOffice();
  const officeName = (o: OfficeConfig) => (o.isDefault ? t("office.offices.defaultName") : o.name);
  const stateRef = useRef({ renderMode, cameraMode, patrol });
  stateRef.current = { renderMode, cameraMode, patrol };

  useEffect(() => {
    let alive = true;
    void loadOffices().then(({ offices: list, source }) => {
      if (!alive) return;
      setOffices(list);
      setOfficeSource(source);
    });
    return () => {
      alive = false;
    };
  }, []);

  // (Re)build the whole scene whenever the office changes; the previous one is fully disposed.
  // Characters are not part of the key: a spawned sprite is persisted without rebuilding the scene.
  const officeKey = `${office.id}|${office.zones.join(",")}|${office.theme}`;
  useEffect(() => {
    const root = rootRef.current;
    const canvasHost = canvasRef.current;
    const labels = labelsRef.current;
    const minimap = minimapRef.current;
    if (!root || !canvasHost || !labels || !minimap) return;
    const s = stateRef.current;
    const { api, dispose } = createEngine(
      { root, canvasHost, labels, minimap },
      {
        t: () => tRef.current,
        onSelect: setActiveId,
        onCharacters: setCharacters,
        onZoneOpen: (zone) => setDash({ kind: "zone", zone }),
      },
      office,
      s.renderMode,
    );
    if (s.cameraMode !== "iso") api.setCameraMode(s.cameraMode);
    api.setPatrol(s.patrol);
    engineRef.current = api;
    setActiveId(0);
    return () => {
      engineRef.current = null;
      dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [officeKey]);

  const switchOffice = (id: string) => {
    setDash(null);
    setOfficeId(id);
  };
  const handleCreate = async (input: NewOffice) => {
    const { office: created, source } = await createOffice(input, officeSource, offices);
    setOffices((prev) => [...prev, created]);
    setOfficeSource(source);
    setCreating(false);
    switchOffice(created.id);
  };
  const applyUpdate = async (id: string, updates: OfficeUpdate) => {
    const { office: updated, source } = await updateOffice(id, updates, officeSource, offices);
    if (!updated) return;
    setOffices((prev) => prev.map((o) => (o.id === id ? updated : o)));
    setOfficeSource(source);
  };
  const handleEdit = async (updates: OfficeUpdate) => {
    setEditing(false);
    await applyUpdate(office.id, updates);
  };
  const spawnSprite = () => {
    const tpl = engineRef.current?.spawn();
    if (!tpl) return;
    // Persist the new sprite in the office (API, or localStorage when the API is down).
    void applyUpdate(office.id, { characters: [...office.characters, tpl].slice(0, 24) });
  };
  const handleDelete = async () => {
    if (office.isDefault) return;
    await deleteOffice(office.id, officeSource, offices);
    setOffices((prev) => prev.filter((o) => o.id !== office.id));
    switchOffice(DEFAULT_OFFICE_ID);
  };

  const engine = () => engineRef.current;
  const active = characters.find((c) => c.id === activeId);

  const changeCamera = (m: CameraMode) => {
    setCameraMode(m);
    engine()?.setCameraMode(m);
  };
  const togglePatrol = () => {
    const next = !patrol;
    setPatrol(next);
    engine()?.setPatrol(next);
  };
  const cycleRender = () => {
    const next = RENDER_MODES[(RENDER_MODES.indexOf(renderMode) + 1) % RENDER_MODES.length] ?? "hybrid";
    setRenderMode(next);
    engine()?.setRenderMode(next);
  };
  const manualCoordInput = () => {
    const root = rootRef.current;
    if (!root) return;
    const nx = parseFloat(root.querySelector<HTMLInputElement>("[data-ov=input-x]")?.value ?? "") || 0;
    const nz = parseFloat(root.querySelector<HTMLInputElement>("[data-ov=input-z]")?.value ?? "") || 0;
    engine()?.setActivePosition(nx, nz, true);
  };
  const sliderCoordInput = () => {
    const root = rootRef.current;
    if (!root) return;
    const nx = parseFloat(root.querySelector<HTMLInputElement>("[data-ov=slider-x]")?.value ?? "0");
    const nz = parseFloat(root.querySelector<HTMLInputElement>("[data-ov=slider-z]")?.value ?? "0");
    engine()?.setActivePosition(nx, nz, false);
  };
  const touch = (dir: Dir) => ({
    onMouseDown: () => engine()?.setTouchKey(dir, true),
    onMouseUp: () => engine()?.setTouchKey(dir, false),
    onMouseLeave: () => engine()?.setTouchKey(dir, false),
    onTouchStart: (e: React.TouchEvent) => {
      engine()?.setTouchKey(dir, true);
      e.preventDefault();
    },
    onTouchEnd: () => engine()?.setTouchKey(dir, false),
  });
  const camBtn = (m: CameraMode) => `ov-tbtn${cameraMode === m ? " is-on" : ""}`;

  return (
    <div className="ov" ref={rootRef}>
      <div className="ov-canvas" ref={canvasRef} />
      <div className="ov-labels" ref={labelsRef} />

      <header className="ov-header">
        <div className="ov-glass ov-brand">
          <div className="ov-brand-icon">
            <CubeFocus weight="duotone" />
          </div>
          <div>
            <div className="ov-row">
              <h1
                className="ov-title ov-clickable"
                onClick={() => setDash({ kind: "office" })}
                title={t("office.offices.info")}
              >
                {t("office.title")} · {officeName(office)}
              </h1>
              <span className="ov-live">{t("office.live")}</span>
            </div>
            <p className="ov-hint">{t("office.hint")}</p>
          </div>
        </div>

        <div className="ov-glass ov-toolbar ov-switcher">
          <Buildings weight="duotone" className="ov-indigo ov-switcher-icon" />
          <select
            className="ov-select"
            value={office.id}
            onChange={(e) => switchOffice(e.target.value)}
            aria-label={t("office.offices.label")}
            title={officeSource === "local" ? t("office.offices.localNote") : t("office.offices.label")}
          >
            {offices.map((o) => (
              <option key={o.id} value={o.id}>
                {officeName(o)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="ov-icon-btn"
            onClick={() => setDash({ kind: "office" })}
            title={t("office.offices.info")}
            aria-label={t("office.offices.info")}
          >
            <Info weight="bold" />
          </button>
          <button
            type="button"
            className="ov-icon-btn"
            onClick={() => setEditing(true)}
            title={t("office.edit.open")}
            aria-label={t("office.edit.open")}
          >
            <PencilSimple weight="bold" />
          </button>
          <button type="button" className="ov-tbtn is-on" onClick={() => setCreating(true)}>
            <Plus weight="bold" />
            <span>{t("office.offices.new")}</span>
          </button>
        </div>

        <div className="ov-glass ov-toolbar">
          <button type="button" className={camBtn("iso")} onClick={() => changeCamera("iso")}>
            <Cube weight="bold" />
            <span>{t("office.camIso")}</span>
          </button>
          <button type="button" className={camBtn("top")} onClick={() => changeCamera("top")}>
            <GridFour weight="bold" />
            <span>{t("office.camTop")}</span>
          </button>
          <button type="button" className={camBtn("follow")} onClick={() => changeCamera("follow")}>
            <Crosshair weight="bold" />
            <span>{t("office.camFollow")}</span>
          </button>
          <div className="ov-sep" />
          <button
            type="button"
            className={`ov-tbtn ov-patrol${patrol ? "" : " is-off"}`}
            onClick={togglePatrol}
            title={t("office.patrolTitle")}
          >
            <Robot weight="fill" />
            <span>{t(patrol ? "office.patrolOn" : "office.patrolOff")}</span>
          </button>
          <button
            type="button"
            className="ov-tbtn ov-render"
            onClick={cycleRender}
            title={t("office.renderTitle")}
          >
            <UserFocus weight="bold" />
            <span>{t(RENDER_LABEL[renderMode] as "office.renderHybrid")}</span>
          </button>
        </div>
      </header>

      <div className="ov-bottom">
        <div className="ov-glass ov-dpad">
          <span className="ov-caption">{t("office.dpad")}</span>
          <button type="button" className="ov-key" {...touch("up")}>
            <CaretUp weight="bold" />
          </button>
          <div className="ov-dpad-row">
            <button type="button" className="ov-key" {...touch("left")}>
              <CaretLeft weight="bold" />
            </button>
            <button
              type="button"
              className="ov-key ov-key-center"
              onClick={() => engine()?.centerOnActive()}
              title={t("office.center")}
            >
              <Gps weight="bold" />
            </button>
            <button type="button" className="ov-key" {...touch("right")}>
              <CaretRight weight="bold" />
            </button>
          </div>
          <button type="button" className="ov-key" {...touch("down")}>
            <CaretDown weight="bold" />
          </button>
        </div>

        <div className="ov-glass ov-telemetry">
          <div className="ov-between ov-tel-top">
            <span className="ov-inline">
              <CursorClick weight="fill" className="ov-indigo" /> {t("office.cursorFloor")}
            </span>
            <span className="ov-zone-badge" data-ov="hover-zone">
              {t("office.hoverInitialZone")}
            </span>
          </div>
          <div className="ov-between mono ov-tel-values">
            <span data-ov="hover-xyz">{t("office.hoverXZ", { x: "0.00", z: "0.00" })}</span>
            <span className="ov-indigo" data-ov="hover-grid">
              {t("office.hoverGrid", { col: 10, row: 10 })}
            </span>
          </div>
        </div>
      </div>

      <aside className="ov-glass ov-aside">
        <div className="ov-aside-head">
          <div className="ov-aside-head-left">
            <UsersThree weight="duotone" />
            <div>
              <h2 className="ov-h2">{t("office.inspectorTitle")}</h2>
              <p className="ov-sub">{t("office.inspectorSubtitle")}</p>
            </div>
          </div>
          <button type="button" className="ov-new" onClick={spawnSprite}>
            <Plus weight="bold" />
            <span>{t("office.newSprite")}</span>
          </button>
        </div>

        <div className="ov-scroll">
          <div className="ov-card">
            <div className="ov-between">
              <div className="ov-gap-25">
                <div className="ov-avatar" style={{ backgroundColor: active?.color }}>
                  {active ? initials(active.name) : ""}
                </div>
                <div>
                  <div className="ov-gap-15">
                    <span className="ov-name">
                      {active
                        ? `${active.name} (${t(`office.charRoles.${active.roleKey}` as "office.charRoles.fullstack")})`
                        : ""}
                    </span>
                    <span className="ov-active-tag">{t("office.active")}</span>
                  </div>
                  <p className="ov-state">
                    <span className="ov-state-dot" data-ov="active-state-dot" />
                    <span data-ov="active-state-text" />
                  </p>
                </div>
              </div>
              <div className="ov-right mono">
                <span className="ov-tiny-muted">{t("office.gridCell")}</span>
                <span className="ov-grid-cell" data-ov="active-grid" />
              </div>
            </div>

            <div className="ov-coords">
              <div className="ov-coord">
                <label className="ov-rose">
                  <span>{t("office.posX")}</span>
                  <span className="mono ov-unit">{t("office.unitM")}</span>
                </label>
                <input
                  data-ov="input-x"
                  type="number"
                  step="0.5"
                  min="-9.5"
                  max="9.5"
                  onChange={manualCoordInput}
                />
              </div>
              <div className="ov-coord">
                <label className="ov-emerald">
                  <span>{t("office.heightY")}</span>
                  <span className="mono ov-unit">{t("office.unitM")}</span>
                </label>
                <input data-ov="input-y" type="number" step="0.1" readOnly />
              </div>
              <div className="ov-coord">
                <label className="ov-sky">
                  <span>{t("office.posZ")}</span>
                  <span className="mono ov-unit">{t("office.unitM")}</span>
                </label>
                <input
                  data-ov="input-z"
                  type="number"
                  step="0.5"
                  min="-9.5"
                  max="9.5"
                  onChange={manualCoordInput}
                />
              </div>
            </div>

            <div className="ov-sliders">
              <div>
                <div className="ov-slider-head">
                  <span className="ov-slate4">{t("office.sliderX")}</span>
                  <span className="mono ov-rose ov-semibold" data-ov="slider-x-val">
                    0.0
                  </span>
                </div>
                <input
                  data-ov="slider-x"
                  type="range"
                  min="-9.2"
                  max="9.2"
                  step="0.1"
                  onInput={sliderCoordInput}
                />
              </div>
              <div>
                <div className="ov-slider-head">
                  <span className="ov-slate4">{t("office.sliderZ")}</span>
                  <span className="mono ov-sky ov-semibold" data-ov="slider-z-val">
                    0.0
                  </span>
                </div>
                <input
                  data-ov="slider-z"
                  type="range"
                  min="-9.2"
                  max="9.2"
                  step="0.1"
                  onInput={sliderCoordInput}
                />
              </div>
            </div>

            <div className="ov-zones">
              <span className="ov-caption">{t("office.sendTo")}</span>
              <div className="ov-zone-grid">
                {office.zones.map((z) => {
                  const { Icon, cls, label } = ZONE_ICON[z];
                  return (
                    <div key={z} className="ov-zone-cell">
                      <button type="button" className="ov-zone-btn" onClick={() => engine()?.sendToZone(z)}>
                        <Icon weight="duotone" className={cls} />
                        <span>{t(label as "office.sendDev")}</span>
                      </button>
                      <button
                        type="button"
                        className="ov-zone-info"
                        onClick={() => setDash({ kind: "zone", zone: z })}
                        title={t("office.dash.zoneInfo")}
                        aria-label={t("office.dash.zoneInfo")}
                      >
                        <Info weight="bold" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div>
            <div className="ov-list-head">
              <span className="ov-list-title">{t("office.listTitle", { count: characters.length })}</span>
              <span className="ov-list-hint">{t("office.clickToControl")}</span>
            </div>
            <div className="ov-list">
              {characters.map((c) => (
                <div
                  key={c.id}
                  className={`ov-item${c.id === activeId ? " is-selected" : ""}`}
                  onClick={() => engine()?.select(c.id)}
                >
                  <div className="ov-gap-25">
                    <div className="ov-item-avatar" style={{ background: c.color }}>
                      {initials(c.name)}
                    </div>
                    <div>
                      <div className="ov-gap-15">
                        <span className="ov-item-name">{c.name}</span>
                        <span className="ov-item-role">
                          {t(`office.charRoles.${c.roleKey}` as "office.charRoles.fullstack")}
                        </span>
                      </div>
                      <span className="ov-item-state" data-ov={`state-${c.id}`} />
                    </div>
                  </div>
                  <div className="ov-right mono">
                    <span className="ov-item-xyz" data-ov={`xyz-${c.id}`} />
                    <span className="ov-item-grid" data-ov={`grid-${c.id}`} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="ov-map">
            <div className="ov-between" style={{ marginBottom: 8 }}>
              <span className="ov-map-title">
                <RadarIcon className="ov-indigo" />
                {t("office.minimapTitle")}
              </span>
              <span className="mono ov-tiny-muted" style={{ display: "inline" }}>
                {t("office.minimapSize")}
              </span>
            </div>
            <div className="ov-map-box">
              <canvas
                ref={minimapRef}
                width={280}
                height={280}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  engine()?.minimapClick(
                    (e.clientX - rect.left) / rect.width,
                    (e.clientY - rect.top) / rect.height,
                  );
                }}
              />
            </div>
          </div>
        </div>
      </aside>

      {editing && (
        <EditOfficeDialog
          office={office}
          onCancel={() => setEditing(false)}
          onSave={(u) => void handleEdit(u)}
        />
      )}
      {creating && (
        <CreateOfficeDialog onCancel={() => setCreating(false)} onCreate={(o) => void handleCreate(o)} />
      )}
      {dash && (
        <OfficeDashboard
          scope={dash}
          office={office}
          officeName={officeName(office)}
          snapshot={() => engine()?.snapshot() ?? []}
          live={live}
          onClose={() => setDash(null)}
          onDelete={dash.kind === "office" && !office.isDefault ? () => void handleDelete() : undefined}
          onSelectChar={(id) => engine()?.select(id)}
        />
      )}
    </div>
  );
}
