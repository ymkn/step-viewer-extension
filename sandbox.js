"use strict";

// occt-import-js は内部（Embind）が Function コンストラクタで関数を生成するため、
// MV3 の拡張ページ CSP では実行できない。解析はこのサンドボックスページに隔離する。
// 注意: サンドボックスは opaque origin で動くため、パッケージ内 .wasm を自分で
// fetch できない。wasm バイナリは拡張ページ（同一オリジンで fetch 可能）から
// postMessage で受け取り、wasmBinary としてエンジンに渡す。

let occtPromise = null;
let queue = Promise.resolve();

function startEngine(wasmBuffer) {
  if (occtPromise) return;
  try {
    occtPromise = occtimportjs({ wasmBinary: new Uint8Array(wasmBuffer) });
  } catch (e) {
    occtPromise = Promise.reject(e);
  }
  occtPromise.then(
    () => parent.postMessage({ type: "ready" }, "*"),
    (e) => parent.postMessage({ type: "init-error", error: String((e && e.message) || e) }, "*")
  );
  // ハング検知: 30秒で ready にならなければエラーとして知らせる
  setTimeout(() => {
    if (!occtPromise) return;
    Promise.race([occtPromise, Promise.resolve("pending")]).then((v) => {
      if (v === "pending") {
        parent.postMessage({ type: "init-error", error: "エンジン初期化がタイムアウトしました" }, "*");
      }
    });
  }, 30000);
}

window.addEventListener("message", (ev) => {
  const d = ev.data;
  if (!d) return;
  if (d.type === "wasm") {
    startEngine(d.buffer);
    return;
  }
  if (d.type !== "parse") return;
  queue = queue.then(async () => {
    try {
      if (!occtPromise) throw new Error("エンジン未初期化");
      const occt = await occtPromise;
      const buf = new Uint8Array(d.buffer);
      let r;
      if (d.ext === "iges" || d.ext === "igs") r = occt.ReadIgesFile(buf, d.params);
      else if (d.ext === "brep") r = occt.ReadBrepFile(buf, d.params);
      else r = occt.ReadStepFile(buf, d.params);
      if (!r || !r.success || !r.meshes) {
        parent.postMessage({ type: "parsed", id: d.id, success: false, error: "解析に失敗しました" }, "*");
        return;
      }
      const meshes = r.meshes.map((m) => ({
        name: m.name || "",
        color: Array.isArray(m.color) && m.color.length === 3 ? m.color : null,
        position: new Float32Array(m.attributes.position.array),
        normal: m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null,
        index: m.index ? new Uint32Array(m.index.array) : null,
      }));
      const transfers = [];
      for (const mm of meshes) {
        transfers.push(mm.position.buffer);
        if (mm.normal) transfers.push(mm.normal.buffer);
        if (mm.index) transfers.push(mm.index.buffer);
      }
      parent.postMessage({ type: "parsed", id: d.id, success: true, meshes }, "*", transfers);
    } catch (e) {
      parent.postMessage({ type: "parsed", id: d.id, success: false, error: String((e && e.message) || e) }, "*");
    }
  });
});

parent.postMessage({ type: "wasm-request" }, "*");
