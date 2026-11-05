"use strict";

// STEPビューア (Chrome拡張版): 描画は three.js r128、解析は sandbox 内の
// occt-import-js (WASM)。ファイルは外部送信されない。

const wrap = document.getElementById("canvasWrap");
const dropHint = document.getElementById("dropHint");
const fileInput = document.getElementById("fileInput");
const fileNameEl = document.getElementById("fileName");
const statusEl = document.getElementById("status");
const sandboxFrame = document.getElementById("sandboxFrame");
const info = {
  size: document.getElementById("infoSize"),
  meshes: document.getElementById("infoMeshes"),
  tris: document.getElementById("infoTris"),
  center: document.getElementById("infoCenter"),
};

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x26241f);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
camera.position.set(120, -140, 110);
const renderer = new THREE.WebGLRenderer({ antialias: true });
wrap.appendChild(renderer.domElement);
const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.autoRotateSpeed = 1.2;

scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3a352c, 0.9));
const keyLight = new THREE.DirectionalLight(0xffffff, 0.85);
keyLight.position.set(80, -60, 120);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xdfe8ff, 0.3);
fillLight.position.set(-90, 70, 40);
scene.add(fillLight);
const grid = new THREE.GridHelper(400, 40, 0x554e42, 0x3a362f);
grid.rotation.x = Math.PI / 2; // Z-up に合わせる
grid.visible = false;
scene.add(grid);

const modelGroup = new THREE.Group();
scene.add(modelGroup);

let lastBuffer = null;   // Uint8Array (再解析用)
let lastExt = "";
let bbox = null;         // THREE.Box3
let center = new THREE.Vector3();
let radius = 100;

function setStatus(text) { statusEl.textContent = text; }

function resize() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener("resize", resize);
resize();

renderer.setAnimationLoop(() => {
  controls.autoRotate = document.getElementById("optRotate").checked;
  controls.update();
  renderer.render(scene, camera);
});

// --- sandbox クライアント -------------------------------------------------
// サンドボックスは opaque origin でパッケージ内 wasm を fetch できないため、
// wasm バイナリはこのページが fetch して postMessage で渡す。
let reqId = 0;
const pending = new Map();
let sandboxReady = false;
let readyWaiters = [];
let wasmMaster = null; // ArrayBuffer

async function serveWasm() {
  try {
    if (!wasmMaster) {
      const res = await fetch("vendor/occt-import-js.wasm");
      wasmMaster = await res.arrayBuffer();
    }
    const copy = wasmMaster.slice(0);
    sandboxFrame.contentWindow.postMessage({ type: "wasm", buffer: copy }, "*", [copy]);
  } catch (e) {
    setStatus("wasm の読み込みに失敗: " + ((e && e.message) || e));
  }
}

window.addEventListener("message", (ev) => {
  if (ev.source !== sandboxFrame.contentWindow) return;
  const d = ev.data;
  if (!d) return;
  if (d.type === "wasm-request") {
    serveWasm();
  } else if (d.type === "ready") {
    sandboxReady = true;
    setStatus("準備完了");
    const w = readyWaiters; readyWaiters = [];
    w.forEach((fn) => fn());
  } else if (d.type === "init-error") {
    setStatus("エンジン初期化に失敗: " + d.error);
    const w = readyWaiters; readyWaiters = [];
    w.forEach((fn) => fn(new Error(d.error)));
    for (const [, p] of pending) p.reject(new Error(d.error));
    pending.clear();
  } else if (d.type === "parsed") {
    const p = pending.get(d.id);
    if (p) { pending.delete(d.id); p.resolve(d); }
  }
});

function waitReady(timeoutMs) {
  if (sandboxReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("エンジンが応答しません（sandbox 未到達）")), timeoutMs);
    readyWaiters.push((err) => {
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    });
  });
}

async function parseViaSandbox(params) {
  await waitReady(30000);
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("解析がタイムアウトしました"));
    }, 120000);
    pending.set(id, {
      resolve: (d) => { clearTimeout(timer); resolve(d); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    const copy = lastBuffer.slice(); // 転送で detach されるのでコピーを渡す
    sandboxFrame.contentWindow.postMessage(
      { type: "parse", id, ext: lastExt, params, buffer: copy.buffer },
      "*",
      [copy.buffer]
    );
  });
}

const PRECISION = {
  standard: null,
  coarse: { linearUnit: "millimeter", linearDeflectionType: "absolute_value", linearDeflection: 0.5, angularDeflection: 0.8 },
  fine: { linearUnit: "millimeter", linearDeflectionType: "absolute_value", linearDeflection: 0.05, angularDeflection: 0.2 },
};

function clearModel() {
  while (modelGroup.children.length) {
    const obj = modelGroup.children.pop();
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}

function buildModel(meshes) {
  clearModel();
  let triCount = 0;
  const box = new THREE.Box3();
  for (const mesh of meshes) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(mesh.position, 3));
    if (mesh.normal) {
      geo.setAttribute("normal", new THREE.BufferAttribute(mesh.normal, 3));
    }
    if (mesh.index) {
      geo.setIndex(new THREE.BufferAttribute(mesh.index, 1));
      triCount += mesh.index.length / 3;
    } else {
      triCount += mesh.position.length / 9;
    }
    if (!mesh.normal) geo.computeVertexNormals();
    let color = new THREE.Color(0xd8c49c);
    if (Array.isArray(mesh.color) && mesh.color.length === 3) {
      color = new THREE.Color(mesh.color[0], mesh.color[1], mesh.color[2]);
    }
    const mat = new THREE.MeshStandardMaterial({
      color, metalness: 0.05, roughness: 0.65, side: THREE.DoubleSide,
      wireframe: document.getElementById("optWireframe").checked,
    });
    const m = new THREE.Mesh(geo, mat);
    m.name = mesh.name || "";
    modelGroup.add(m);
    geo.computeBoundingBox();
    box.union(geo.boundingBox);
  }
  bbox = box;
  box.getCenter(center);
  const size = new THREE.Vector3();
  box.getSize(size);
  radius = Math.max(size.x, size.y, size.z) * 0.5 || 100;
  grid.position.set(center.x, center.y, box.min.z);
  const gs = Math.max(size.x, size.y) * 1.6;
  grid.scale.set(gs / 400, gs / 400, 1);
  info.size.textContent = `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm`;
  info.meshes.textContent = String(meshes.length);
  info.tris.textContent = Math.round(triCount).toLocaleString("ja-JP");
  info.center.textContent = `${center.x.toFixed(1)}, ${center.y.toFixed(1)}, ${center.z.toFixed(1)}`;
  applyEdges();
  setView("iso");
}

function applyEdges() {
  const on = document.getElementById("optEdges").checked;
  for (const m of [...modelGroup.children]) {
    if (m.userData.isEdge) { modelGroup.remove(m); m.geometry.dispose(); m.material.dispose(); }
  }
  if (!on) return;
  for (const m of [...modelGroup.children]) {
    if (m.isMesh) {
      const eg = new THREE.EdgesGeometry(m.geometry, 35);
      const lines = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x2e2a24 }));
      lines.userData.isEdge = true;
      modelGroup.add(lines);
    }
  }
}

function frameCamera(dir, up) {
  const dist = radius * 3.2;
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.up.copy(up);
  camera.near = Math.max(dist / 1000, 0.01);
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

function setView(name) {
  if (!bbox) return;
  const V = THREE.Vector3;
  if (name === "top") frameCamera(new V(0, 0, 1), new V(0, 1, 0));
  else if (name === "front") frameCamera(new V(0, -1, 0), new V(0, 0, 1));
  else if (name === "right") frameCamera(new V(1, 0, 0), new V(0, 0, 1));
  else frameCamera(new V(1, -1, 0.75).normalize(), new V(0, 0, 1));
}

async function parseAndShow() {
  if (!lastBuffer) return;
  setStatus("解析中…");
  try {
    const params = PRECISION[document.getElementById("optPrecision").value];
    const res = await parseViaSandbox(params);
    if (!res.success || !res.meshes || res.meshes.length === 0) {
      setStatus("解析に失敗しました" + (res.error ? ": " + res.error : ""));
      return;
    }
    buildModel(res.meshes);
    dropHint.style.display = "none";
    setStatus("表示中");
  } catch (e) {
    console.error(e);
    setStatus("エラー: " + ((e && e.message) || e));
  }
}

const EXTENSIONS = ["step", "stp", "iges", "igs", "brep"];
function extOf(name) {
  const m = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

async function openFile(file) {
  if (!file) return;
  const ext = extOf(file.name);
  if (!EXTENSIONS.includes(ext)) {
    setStatus("未対応の拡張子です: " + file.name);
    return;
  }
  fileNameEl.textContent = `${file.name}（${(file.size / 1024).toFixed(0)} KB）`;
  lastExt = ext;
  setStatus("読み込み中…");
  const buf = await file.arrayBuffer();
  lastBuffer = new Uint8Array(buf);
  await parseAndShow();
}

async function openUrl(url) {
  const ext = extOf(url);
  if (!EXTENSIONS.includes(ext)) {
    setStatus("未対応の拡張子です: " + url);
    return;
  }
  let label = url;
  try { label = decodeURIComponent(new URL(url).pathname.split("/").pop() || url); } catch { /* keep */ }
  fileNameEl.textContent = label;
  lastExt = ext;
  setStatus("URLから読み込み中…");
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = await res.arrayBuffer();
    lastBuffer = new Uint8Array(buf);
    await parseAndShow();
  } catch (e) {
    setStatus("URL読み込みに失敗: " + ((e && e.message) || e) +
      "（file:// の場合は chrome://extensions → STEPビューア → 詳細で「ファイルの URL へのアクセスを許可する」を ON にしてください）");
  }
}

document.getElementById("openBtn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  openFile(fileInput.files[0]);
  fileInput.value = "";
});

// ドロップはページ全体で受ける（サイドバー上でも可）
for (const ev of ["dragenter", "dragover"]) {
  document.addEventListener(ev, (e) => { e.preventDefault(); wrap.classList.add("dragging"); });
}
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) wrap.classList.remove("dragging");
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  wrap.classList.remove("dragging");
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  openFile(f);
});

document.querySelectorAll("[data-view]").forEach((b) => {
  b.addEventListener("click", () => setView(b.dataset.view));
});
document.getElementById("optWireframe").addEventListener("change", (e) => {
  modelGroup.traverse((o) => { if (o.isMesh) o.material.wireframe = e.target.checked; });
});
document.getElementById("optEdges").addEventListener("change", applyEdges);
document.getElementById("optGrid").addEventListener("change", (e) => { grid.visible = e.target.checked; });
document.getElementById("optPrecision").addEventListener("change", () => { if (lastBuffer) parseAndShow(); });

setStatus("エンジン初期化中…");
const initParams = new URLSearchParams(location.search);
const startUrl = initParams.get("url");
if (startUrl) openUrl(startUrl);
