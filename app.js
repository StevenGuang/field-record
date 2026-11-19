/* =====================================================================
 * 手機現場記錄（2026-11-19 使用者要求；需求 docs/mobile-field-spec.md）
 * ---------------------------------------------------------------------
 * 電腦 2D「📱 匯出手機現場包」（type:'pp-field-pack'）→ 這裡匯入（存在手機的 IndexedDB，離線可用）
 * → 在底圖上點電盤、設備、模組記錄：點位施工狀態、測試結果、到貨／安裝／送電、缺失、照片
 * → 「輸出記錄」（type:'pp-field-rec'）→ 電腦 2D「📱 匯入手機記錄」依時間合併。
 * 記錄只存「改了什麼」（rec），顯示時疊在現場包上；欄位格式和 2D 相同（stTs／ioTs／pgTs、issues.upd）。
 * 不記錄人（使用者決定）：stBy、ioBy 留空。
 * ===================================================================== */
'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const p2 = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); };
const fmtTime = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
const uid = (p) => p + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 6);

const ST_DEF = ['', '已配管', '已穿線', '已接線', '已測試', '已驗收'];
const ST_C = { '': '#94a3b8', '已配管': '#b45309', '已穿線': '#a16207', '已接線': '#2563eb', '已測試': '#7c3aed', '已驗收': '#15803d' };
const ISS_C = { '開放': '#dc2626', '處理中': '#d97706', '已結案': '#16a34a' };
// 設備、模組的階段（現場包的 gear＝2D 的 PROG_F；舊的現場包沒有時用這個）。進料、到貨可以拍照留證（EV）
let GEAR = [['pur', '請購'], ['rcv', '進料'], ['pick', '領料'], ['arr', '到貨'], ['ins', '安裝'], ['pwr', '送電']];
let EV = ['rcv', 'arr'];
const PT_F = ['st', 'stAt', 'stBy', 'stNote', 'stTs', 'ioRes', 'ioVal', 'ioBy', 'ioAt', 'ioNote', 'ioTs'];
const APP_VER = '2026-11-19.9';   // 手機頁的版本（選單上顯示；改了程式就改這裡、sw.js 的 CACHE，並在 CHANGES 寫這版改了什麼）
// 每一版改了什麼（手機頁更新後第一次打開時提示，2026-11-19 使用者要求「版本提示」）
const CHANGES = {
  '2026-11-19.9': ['app 版：照片資料夾改成用選的（選單「📁 照片資料夾」打開系統的選擇資料夾畫面）'],
  '2026-11-19.8': ['有 Android app 版了：照片可以存到自己指定的資料夾（圖片／現場記錄…），輸出記錄用手機的分享選單'],
  '2026-11-19.7': ['📷 拍照時另存一份原始照片到手機的「Download」資料夾，Google 相簿打開「備份裝置資料夾 → Download」就會自動備份（選單可以關）'],
  '2026-11-19.6': ['設備、模組多了請購、進料、領料三個階段', '進料、到貨旁邊的 📷 可以拍照留證（那個階段還沒記就記今天）'],
  '2026-11-19.5': ['設備、模組也可以新增缺失（設備的面板下方）', '點位依模組分組，每個點位寫出是哪個設備或模組', '更新後會提示這一版改了什麼'],
  '2026-11-19.4': ['有網路時一律先抓最新版', '選單上顯示版本'],
};
const PH_MAX = 1600, PH_TH = 240;   // 照片壓縮：同 2D（長邊 1600 px JPEG 0.82、縮圖 240 px 0.72）

/* ---------- IndexedDB：kv（pack、rec）、ph（照片） ---------- */
let dbP = null;
function db() {
  if (!dbP) dbP = new Promise((ok, no) => {
    const r = indexedDB.open('pp-field', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('kv'); d.createObjectStore('ph', { keyPath: 'id' }); };
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
  return dbP;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((ok, no) => { const t = d.transaction(store, mode), s = t.objectStore(store); let out; const r = fn(s); if (r) r.onsuccess = () => { out = r.result; }; t.oncomplete = () => ok(out); t.onerror = () => no(t.error); t.onabort = () => no(t.error); });
}
const kvGet = (k) => tx('kv', 'readonly', (s) => s.get(k));
const kvPut = (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k));
const phAll = () => tx('ph', 'readonly', (s) => s.getAll());
const phPut = (v) => tx('ph', 'readwrite', (s) => s.put(v));
const phDel = (id) => tx('ph', 'readwrite', (s) => s.delete(id));
const phClear = () => tx('ph', 'readwrite', (s) => s.clear());

/* ---------- 資料 ---------- */
let pack = null;            // 現場包
let rec = emptyRec();       // 手機上的記錄（改了什麼）
let photos = [];            // [{ id, k, tid, p }]（p＝2D 的照片物件，src／th 是 data URL）
let ix = null;              // 索引
let curFloor = '';
function emptyRec() { return { pts: {}, gear: {}, iss: {}, shots: {}, exported: 0, changed: 0 }; }
function buildIndex() {
  const m = (a) => new Map((a || []).map((x) => [x.id, x]));
  const P = m(pack.panels), D = m(pack.devices), M = m(pack.modules), T = m(pack.points);
  const ptsOfDev = new Map(), ptsOfMod = new Map();
  const push = (map, k, v) => { if (!k) return; let a = map.get(k); if (!a) map.set(k, a = []); a.push(v); };
  for (const t of pack.points || []) {
    if (String(t.deviceId).startsWith('md_')) push(ptsOfMod, t.deviceId.slice(3), t.id);
    else push(ptsOfDev, t.deviceId, t.id);
    if (t.moduleId) push(ptsOfMod, t.moduleId, t.id);
  }
  for (const [k, a] of ptsOfMod) ptsOfMod.set(k, [...new Set(a)]);
  const inPanel = new Map();
  for (const d of pack.devices || []) if (d.panelId) push(inPanel, d.panelId, { kind: 'd', id: d.id });
  for (const x of pack.modules || []) if (x.panelId) push(inPanel, x.panelId, { kind: 'm', id: x.id });
  if (Array.isArray(pack.gear) && pack.gear.length) GEAR = pack.gear;
  if (Array.isArray(pack.ev)) EV = pack.ev;
  ix = { P, D, M, T, ptsOfDev, ptsOfMod, inPanel, F: m(pack.floors), sts: pack.sts?.length ? pack.sts : ST_DEF };
}
const isPlaced = (o) => o && o.x != null && o.y != null && o.x !== '' && o.y !== '' && Number.isFinite(+o.x) && Number.isFinite(+o.y);
const ptOf = (id) => ({ ...ix.T.get(id), ...rec.pts[id] });
const gearOf = (kind, id) => { const o = (kind === 'd' ? ix.D : ix.M).get(id) || {}, v = { pgTs: o.pgTs || 0 }; for (const [f] of GEAR) v[f] = o[f] || ''; return { ...v, ...rec.gear[kind + ':' + id] }; };
const itemOf = (kind, id) => kind === 'p' ? ix.P.get(id) : kind === 'd' ? ix.D.get(id) : ix.M.get(id);
const ptsOf = (kind, id) => {
  if (kind === 'd') return ix.ptsOfDev.get(id) || [];
  if (kind === 'm') return ix.ptsOfMod.get(id) || [];
  const s = new Set();
  for (const c of ix.inPanel.get(id) || []) for (const t of ptsOf(c.kind, c.id)) s.add(t);
  return [...s];
};
// 缺失：現場包的＋手機改的／新增的
function issues() {
  const out = new Map();
  for (const x of pack.issues || []) out.set(x.id, { ...x, ...rec.iss[x.id] });
  for (const [id, x] of Object.entries(rec.iss)) if (x.isNew) out.set(id, x);
  return [...out.values()];
}
const shots = () => [...(pack.shots || []), ...Object.values(rec.shots)];
const photosOf = (k, id) => photos.filter((x) => x.k === k && x.tid === id);
// 完成度（0～1；沒有東西可以算時 null）：點位的施工狀態（已驗收＝1）、到貨／安裝／送電
function progress(kind, id) {
  const sts = ix.sts, top = sts.length - 1;
  let sum = 0, n = 0;
  for (const t of ptsOf(kind, id)) { sum += Math.max(0, sts.indexOf(ptOf(t).st || '')) / top; n++; }
  const gears = kind === 'p' ? (ix.inPanel.get(id) || []) : [{ kind, id }];
  for (const g of gears) { const v = gearOf(g.kind, g.id); sum += GEAR.filter(([f]) => v[f]).length / GEAR.length; n++; }
  return n ? sum / n : null;
}
const pctColor = (v) => v === null ? '#64748b' : v >= 0.999 ? '#16a34a' : v > 0 ? '#d97706' : '#64748b';
function recCount() { return Object.keys(rec.pts).length + Object.keys(rec.gear).length + Object.keys(rec.iss).length + Object.keys(rec.shots).length + photos.length; }

// 每次修改馬上存進手機（記錄只有文字，照片另外存）：關掉頁面、切到別的 App 也不會少
function touch() { rec.changed = Date.now(); kvPut('rec', rec).catch((e) => toast('記錄存不進手機：' + e.message, true)); renderRecBar(); drawPins(); }

/* ---------- 修改 ---------- */
function setPts(ids, patch) {
  const now = Date.now(), td = today(), sts = ix.sts;
  let adv = 0;
  for (const id of ids) {
    const cur = ptOf(id), np = {};
    for (const f of PT_F) np[f] = cur[f] ?? '';
    np.stTs = +cur.stTs || 0; np.ioTs = +cur.ioTs || 0;
    if ('st' in patch) { np.st = patch.st; np.stAt = patch.st ? td : ''; np.stBy = ''; np.stTs = now; }
    if ('stNote' in patch) { np.stNote = patch.stNote; np.stTs = now; }
    if ('ioRes' in patch) {
      np.ioRes = patch.ioRes; np.ioAt = patch.ioRes ? td : ''; np.ioBy = ''; np.ioTs = now;
      // 同 2D 的 setPtIo：測試 OK 時施工狀態推進到「已測試」
      if (patch.ioRes === 'OK' && sts.indexOf(np.st || '') < sts.indexOf('已測試')) { np.st = '已測試'; np.stAt = td; np.stBy = ''; np.stTs = now; adv++; }
    }
    if ('ioVal' in patch) { np.ioVal = patch.ioVal; np.ioTs = now; }
    if ('ioNote' in patch) { np.ioNote = patch.ioNote; np.ioTs = now; }
    rec.pts[id] = np;
  }
  touch();
  if (adv) toast('測試 OK：' + (ids.length > 1 ? adv + ' 個點位的' : '') + '施工狀態推進為「已測試」');
}
const gearPick = (v) => Object.fromEntries(GEAR.map(([f]) => [f, v[f] || '']));
function setGear(kind, id, f, on) {
  const v = gearOf(kind, id);
  rec.gear[kind + ':' + id] = { ...gearPick(v), [f]: on ? today() : '', pgTs: Date.now() };
  touch();
}
function setIssue(id, patch) {
  const cur = issues().find((x) => x.id === id);
  if (!cur) return;
  const base = rec.iss[id] || (cur.isNew ? cur : {});
  rec.iss[id] = { ...base, ...patch, upd: Date.now() };
  touch();
}
function newIssue(o) {
  const all = issues(), num = (v) => { const g = /(\d+)\s*$/.exec(String(v || '')); return g ? parseInt(g[1], 10) : 0; };
  const it = { id: uid('is'), isNew: true, no: 'NC-' + String(all.reduce((m, x) => Math.max(m, num(x.no)), 0) + 1).padStart(3, '0'), st: '開放', title: '', note: '', floorId: curFloor, panelId: '', at: today(), upd: Date.now(), ...o };
  rec.iss[it.id] = it;
  touch();
  return it;
}
function newShot(o) {
  const all = shots(), num = (v) => parseInt(String(v || '').replace(/\D/g, ''), 10) || 0;
  const no = 'PH-' + String(all.reduce((m, x) => Math.max(m, num(x.no)), 0) + 1).padStart(3, '0');
  const sh = { id: uid('sh'), isNew: true, no, title: '拍攝點 ' + no, floorId: curFloor, at: today(), ...o };
  rec.shots[sh.id] = sh;
  touch();
  return sh;
}

/* ---------- 照片 ---------- */
async function makePhoto(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (_) { const url = URL.createObjectURL(file); bmp = await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => no(new Error('讀不到這張圖')); im.src = url; }); }
  const W = bmp.width || bmp.naturalWidth, H = bmp.height || bmp.naturalHeight;
  const enc = (mx, q) => { const k = Math.min(1, mx / Math.max(W, H)), c = document.createElement('canvas'); c.width = Math.max(1, Math.round(W * k)); c.height = Math.max(1, Math.round(H * k));
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, c.width, c.height);
    const u = c.toDataURL('image/jpeg', q); c.width = c.height = 0; return u; };
  const src = enc(PH_MAX, 0.82), th = enc(PH_TH, 0.72);
  bmp.close?.();
  let hash = '';
  try { const h = new Uint8Array(await crypto.subtle.digest('SHA-1', await file.arrayBuffer())); hash = [...h.slice(0, 10)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
  catch (_) { hash = 'f' + (file.size || 0) + '-' + (file.lastModified || 0); }
  const name = String(file.name || '').replace(/\.[^.]+$/, '') || ('現場_' + fmtTime(new Date()).replace(/\D/g, ''));
  return { id: uid('ph'), src, th, name, tk: fmtTime(new Date(file.lastModified || Date.now())), tkSrc: 'file', up: fmtTime(new Date()), hash, sz: file.size || 0, by: '', note: '' };
}
let photoTarget = null;   // { k, tid, after }
function pickPhoto(target, camera) { photoTarget = { ...target, cam: !!camera }; (camera ? $('fileCam') : $('filePics')).click(); }
// 拍照另存到手機（2026-11-19 使用者要求「拍的照片自動存在手機內，用 Google 相簿自動備份」）：
// 相機直接交給頁面的照片不會進手機相簿，所以拍完把原始檔另外下載一份到「Download」資料夾（Google 相簿可以備份這個資料夾）。
// 只有「📷 拍照」才存（「從相簿」選的本來就在相簿裡）；選單可以關，記在 localStorage pp-field-savecam（'0'＝關）。
// Android app 版（2026-11-19 使用者要求「照片自己指定要存哪個資料夾」→ mobile-app/ 用 Capacitor 包這一頁）：
// 有 window.Capacitor 時改用原生外掛 FieldNative（mobile-app/android/.../FieldNativePlugin.java）：照片存到「圖片／指定資料夾」、
// 記錄檔用 Android 的分享選單或存到「Download／指定資料夾」；網頁版照舊（下載、navigator.share）。
const NATIVE = !!window.Capacitor?.isNativePlatform?.();
const FN = NATIVE ? (window.Capacitor.Plugins?.FieldNative || window.Capacitor.registerPlugin?.('FieldNative') || null) : null;   // 沒有 @capacitor/core 時，原生橋接放在 Capacitor.Plugins
// 使用者選的照片資料夾（FN.pickFolder 回傳的 { uri（SAF tree）, name（顯示用，例如 Pictures/現場記錄）}），localStorage pp-field-pickdir
const pickedFolder = () => { try { const v = JSON.parse(localStorage.getItem('pp-field-pickdir') || 'null'); return v && v.uri ? v : null; } catch (_) { return null; } };
const setPickedFolder = (v) => { try { if (v) localStorage.setItem('pp-field-pickdir', JSON.stringify(v)); else localStorage.removeItem('pp-field-pickdir'); } catch (_) { /* 存不了 */ } };
const photoFolderLabel = () => { const p = pickedFolder(); return p ? p.name : '圖片／' + photoFolder(); };
const photoFolder = () => { try { return localStorage.getItem('pp-field-folder') || '現場記錄'; } catch (_) { return '現場記錄'; } };
const b64Of = (blob) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = () => no(r.error); r.readAsDataURL(blob); });
const saveCamOn = () => { try { return localStorage.getItem('pp-field-savecam') !== '0'; } catch (_) { return true; } };
function photoLabel(T) {
  const o = T.k === 's' ? shots().find((x) => x.id === T.tid) : T.k === 'i' ? issues().find((x) => x.id === T.tid) : itemOf(T.k, T.tid);
  const nm = !o ? '' : T.k === 'p' ? (o.code || o.name) : T.k === 'm' ? o.code + ' ' + o.name : T.k === 'i' ? o.no : T.k === 's' ? (o.title || o.no) : (o.name || o.code);
  return [pack?.code || pack?.name, nm, T.ev ? GEAR.find((g) => g[0] === T.ev)?.[1] : ''].filter(Boolean).join('_');
}
async function saveToPhone(file, T) {
  const d = new Date(), stamp = today().replace(/-/g, '') + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name || '') || [])[1] || 'jpg';
  const name = (photoLabel(T) + '_' + stamp).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120) + '.' + ext;
  if (FN) {   // app：存到使用者選的資料夾（系統的選擇資料夾畫面），沒選過＝「圖片／現場記錄」
    const data = await b64Of(file), pf = pickedFolder();
    if (pf) {
      try { await FN.savePhoto({ data, name, mime: file.type || 'image/jpeg', treeUri: pf.uri, folderName: pf.name }); return true; }
      catch (e) { setPickedFolder(null); toast('選的資料夾「' + pf.name + '」存不進去（可能被刪除或沒有權限），這張改存到「圖片／' + photoFolder() + '」；請在選單重新選資料夾', true); }
    }
    try { await FN.savePhoto({ data, name, mime: file.type || 'image/jpeg', folder: photoFolder() }); return true; }
    catch (e) { toast('照片存不進手機相簿：' + (e?.message || e), true); return false; }
  }
  try { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 8000); return true; }
  catch (_) { return false; }
}
async function onPhotoFiles(e) {
  const fs = [...(e.target.files || [])]; e.target.value = '';
  const T = photoTarget; photoTarget = null;
  if (!fs.length || !T) return;
  busy('處理照片…');
  let n = 0, bad = 0;
  try {
    for (const f of fs) {
      try { if (T.cam && saveCamOn()) saveToPhone(f, T); const p = await makePhoto(f); if (T.ev) { p.ev = T.ev; p.note = (GEAR.find((x) => x[0] === T.ev)?.[1] || '') + '留證'; } const r = { id: p.id, k: T.k, tid: T.tid, p }; await phPut(r); photos.push(r); n++; }
      catch (_) { bad++; }
    }
  } finally { busy(false); }
  if (n && T.ev && !gearOf(T.k, T.tid)[T.ev]) setGear(T.k, T.tid, T.ev, true);
  touch();
  toast('已加入 ' + n + ' 張照片' + (bad ? '；' + bad + ' 張讀取失敗' : ''), !!bad && !n);
  T.after?.();
}
async function removePhoto(id) {
  const i = photos.findIndex((x) => x.id === id);
  if (i < 0) return;
  await phDel(id); photos.splice(i, 1); touch(); reopen();
}
function photosHtml(k, tid) {
  const ps = photosOf(k, tid);
  return `<div class="photos">${ps.map((x) => `<div class="ph"><img src="${x.p.th}" alt="">${x.p.ev ? `<span class="evtag">${esc(GEAR.find((g) => g[0] === x.p.ev)?.[1] || '')}</span>` : ''}<button data-act="delph" data-id="${x.id}" aria-label="刪除照片">✕</button></div>`).join('')}</div>
    <div class="row-btns"><button class="sb pri" data-act="cam" data-k="${k}" data-tid="${esc(tid)}">📷 拍照</button><button class="sb" data-act="pics" data-k="${k}" data-tid="${esc(tid)}">🖼 從相簿</button></div>`;
}

/* ---------- 底圖與圖釘 ---------- */
const view = { k: 1, x: 0, y: 0 };
let imgW = 1000, imgH = 1000, frame = null;   // frame：{ u0, v0, u1, v1, W, H }
function applyView() {
  const L = $('layer');
  L.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  L.style.setProperty('--k', view.k);
  L.classList.toggle('zoomed', view.k * (imgW / 1000) > 1.6 || view.k > 1.6);
}
function fitView() {
  const m = $('map'), top = $('top').offsetHeight, W = m.clientWidth, H = m.clientHeight - top;
  view.k = Math.min(W / imgW, H / imgH) * 0.96;
  view.x = (W - imgW * view.k) / 2; view.y = top + (H - imgH * view.k) / 2;
  applyView();
}
// 圖面座標（2D 的 x%、y%）→ 圖片像素
function toImg(o) {
  const f = frame, px = +o.x / 100 * f.W, py = +o.y / 100 * f.H;
  return { x: (px - f.u0) / (f.u1 - f.u0) * imgW, y: (py - f.v0) / (f.v1 - f.v0) * imgH };
}
function fromImg(ix0, iy0) {
  const f = frame, px = f.u0 + ix0 / imgW * (f.u1 - f.u0), py = f.v0 + iy0 / imgH * (f.v1 - f.v0);
  return { x: +(px / f.W * 100).toFixed(2), y: +(py / f.H * 100).toFixed(2) };
}
function setFloor(fid, { fit = true } = {}) {
  const f = ix.F.get(fid) || pack.floors[0];
  if (!f) return;
  curFloor = f.id; $('floorSel').value = f.id;
  try { localStorage.setItem('pp-field-floor', f.id); } catch (_) { /* 存不了 */ }
  const im = f.img, plan = $('plan');
  if (im) { imgW = im.w; imgH = im.h; frame = { u0: im.u0, v0: im.v0, u1: im.u1, v1: im.v1, W: f.W, H: f.H }; plan.src = im.url; }
  else {
    // 沒有底圖：畫一張空白的方格當底
    const W = f.W || 1000, H = f.H || 1000, k = 1600 / Math.max(W, H);
    imgW = Math.round(W * k); imgH = Math.round(H * k); frame = { u0: 0, v0: 0, u1: W, v1: H, W, H };
    const c = document.createElement('canvas'); c.width = imgW; c.height = imgH;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, imgW, imgH); g.strokeStyle = '#e2e8f0';
    for (let x = 0; x < imgW; x += 80) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, imgH); g.stroke(); }
    for (let y = 0; y < imgH; y += 80) { g.beginPath(); g.moveTo(0, y); g.lineTo(imgW, y); g.stroke(); }
    g.fillStyle = '#94a3b8'; g.font = '28px sans-serif'; g.fillText('（這層沒有底圖）', 24, 48);
    plan.src = c.toDataURL('image/png');
  }
  plan.style.width = imgW + 'px'; plan.style.height = imgH + 'px';
  $('pins').style.width = imgW + 'px'; $('pins').style.height = imgH + 'px';
  drawPins();
  if (fit) fitView();
}
let selKey = '';
function drawPins() {
  if (!pack || !frame) return;
  const out = [], F = curFloor;
  const pin = (cls, key, o, html, style = '') => { const q = toImg(o); out.push(`<div class="pin ${cls}${selKey === key ? ' sel' : ''}" data-key="${esc(key)}" style="left:${q.x.toFixed(1)}px;top:${q.y.toFixed(1)}px;${style}">${html}</div>`); };
  for (const p of pack.panels || []) {
    if (p.floorId !== F || !isPlaced(p)) continue;
    const v = progress('p', p.id);
    pin('pan', 'p:' + p.id, p, `${esc(p.code || p.name || '電盤')}${v === null ? '' : `<small>${Math.round(v * 100)}%</small>`}`, `--pc:${pctColor(v)}`);
  }
  for (const d of pack.devices || []) {
    if (d.floorId !== F || !isPlaced(d)) continue;
    const v = progress('d', d.id);
    pin('dev', 'd:' + d.id, d, `<span class="lb">${esc(d.name || d.code)}</span>`, `--pc:${d.c || '#64748b'};--tc:${pctColor(v) === '#64748b' ? '#fff' : pctColor(v)}`);
  }
  for (const m of pack.modules || []) {
    if (m.floorId !== F || m.panelId || !isPlaced(m)) continue;
    const v = progress('m', m.id);
    pin('dev mod', 'm:' + m.id, m, `<span class="lb">${esc(m.code + ' ' + m.name)}</span>`, `--pc:#475569;--tc:${pctColor(v) === '#64748b' ? '#fff' : pctColor(v)}`);
  }
  for (const s of shots()) if (s.floorId === F && isPlaced(s)) pin('shot' + (s.isNew ? ' new' : ''), 's:' + s.id, s, '📷');
  for (const x of issues()) {
    if (x.del || x.floorId !== F) continue;
    let pos = isPlaced(x) ? x : null;
    if (!pos && (x.devId || x.modId)) { const o = x.devId ? ix.D.get(x.devId) : ix.M.get(x.modId); if (isPlaced(o)) pos = { x: +o.x + 1.2, y: +o.y - 1.2 }; }
    if (!pos && x.panelId) { const p = ix.P.get(x.panelId); if (isPlaced(p)) pos = { x: +p.x + 1.2, y: +p.y - 1.2 }; }
    if (pos) pin('iss' + (x.isNew || rec.iss[x.id] ? ' new' : ''), 'i:' + x.id, pos, '!', `--pc:${ISS_C[x.st] || '#dc2626'}`);
  }
  $('pins').innerHTML = out.join('');
}

/* ---------- 手勢：拖曳平移、兩指縮放、點一下、長按 ---------- */
const ptrs = new Map();
let gest = null, longT = 0, ghostUntil = 0;
function mapPt(e) { return { x: e.clientX, y: e.clientY }; }
function onDown(e) {
  if (!pack) return;
  try { $('map').setPointerCapture(e.pointerId); } catch (_) { /* 合成的事件 */ }
  ptrs.set(e.pointerId, mapPt(e));
  hideHint();
  if (ptrs.size === 1) {
    gest = { mode: 'tap', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, t: Date.now(), target: e.target.closest('.pin') };
    clearTimeout(longT);
    longT = setTimeout(() => { if (gest?.mode === 'tap' && !gest.target) { gest.mode = 'long'; ghostUntil = Date.now() + 99999; onLong(gest.sx, gest.sy); } }, 550);
  } else if (ptrs.size === 2) {
    clearTimeout(longT);
    const [a, b] = [...ptrs.values()];
    gest = { mode: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, k: view.k, vx: view.x, vy: view.y };
  }
}
function onMove(e) {
  if (!ptrs.has(e.pointerId) || !gest) return;
  ptrs.set(e.pointerId, mapPt(e));
  if (gest.mode === 'pinch' && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const k = clampK(gest.k * d / gest.d);
    // 兩指中點下的圖面位置不動，再跟著中點平移
    view.x = mx - (gest.mx - gest.vx) * k / gest.k; view.y = my - (gest.my - gest.vy) * k / gest.k; view.k = k;
    applyView(); return;
  }
  const dx = e.clientX - gest.sx, dy = e.clientY - gest.sy;
  if (gest.mode === 'tap' && Math.hypot(dx, dy) > 8) { gest.mode = 'pan'; clearTimeout(longT); }
  if (gest.mode === 'pan') { view.x = gest.vx + dx; view.y = gest.vy + dy; applyView(); }
}
function onUp(e) {
  ptrs.delete(e.pointerId);
  clearTimeout(longT);
  if (!gest) return;
  if (gest.mode === 'tap' && ptrs.size === 0) {
    // 手指放開後瀏覽器還會送一次 click（落在剛打開的面板上）：之後 0.4 秒內面板、選單不接受點擊
    if (gest.target) { ghostUntil = Date.now() + 400; openKey(gest.target.dataset.key); }
    else { hidePop(); if (!$('sheet').hidden) closeSheet(); }
  }
  if (gest?.mode === 'long') ghostUntil = Date.now() + 400;
  if (ptrs.size === 0) gest = null;
  else if (gest.mode === 'pinch') { const [a] = [...ptrs.values()]; gest = { mode: 'pan', sx: a.x, sy: a.y, vx: view.x, vy: view.y }; }
}
const clampK = (k) => Math.min(Math.max(k, 0.05), 40);
function onWheel(e) {
  e.preventDefault();
  const k = clampK(view.k * Math.exp(-e.deltaY * 0.0015));
  view.x = e.clientX - (e.clientX - view.x) * k / view.k; view.y = e.clientY - (e.clientY - view.y) * k / view.k; view.k = k; applyView();
}
function screenToImg(x, y) { return { x: (x - view.x) / view.k, y: (y - view.y) / view.k }; }
function onLong(x, y) {
  const q = screenToImg(x, y);
  if (q.x < 0 || q.y < 0 || q.x > imgW || q.y > imgH) return;
  navigator.vibrate?.(30);
  const at = fromImg(q.x, q.y);
  const mk = document.createElement('div'); mk.className = 'mk-long'; mk.style.left = q.x + 'px'; mk.style.top = q.y + 'px'; $('pins').appendChild(mk);
  showPop(x, y, '在這裡新增', [
    ['⚠ 新增缺失', () => { const it = newIssue({ ...at }); openIssue(it.id); }],
    ['📷 新增拍攝點（拍照）', () => { const sh = newShot({ ...at }); pickPhoto({ k: 's', tid: sh.id, after: () => openShot(sh.id) }, true); }],
  ], () => mk.remove());
}

/* ---------- 彈出選單、提示 ---------- */
let popClose = null;
function showPop(x, y, title, items, onClose) {
  hidePop();
  const el = $('pop');
  el.innerHTML = (title ? `<div class="ptitle">${esc(title)}</div>` : '') + items.map((it, i) => it === '-' ? '<hr>' : `<button data-i="${i}">${it[0]}</button>`).join('');
  el.hidden = false;
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(innerWidth - r.width - 8, x - r.width / 2)) + 'px';
  el.style.top = Math.max(8, Math.min(innerHeight - r.height - 8, y + 12)) + 'px';
  el.onclick = (e) => { if (Date.now() < ghostUntil) return; const b = e.target.closest('button[data-i]'); if (!b) return; const it = items[+b.dataset.i]; hidePop(); it[1](); };
  popClose = onClose || null;
}
function hidePop() { $('pop').hidden = true; const f = popClose; popClose = null; f?.(); }
let toastT = 0;
function toast(t, bad = false) { const el = $('toast'); el.textContent = t; el.className = 'toast' + (bad ? ' bad' : ''); el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, bad ? 5000 : 3000); }
function busy(t) { $('busy').hidden = !t; if (t) $('busyTxt').textContent = t; }
function hideHint() { const h = $('hint'); if (h.style.opacity !== '0') { h.style.opacity = '0'; } }

/* ---------- 底部面板 ---------- */
const stack = [];   // 開過的面板（‹ 回上一層）
let cur = null;     // { type, id, kind }
function openSheet(state, push = false) {
  if (push && cur) stack.push(cur); else if (!push) stack.length = 0;
  cur = state; render();
}
function closeSheet() { $('sheet').hidden = true; cur = null; stack.length = 0; selKey = ''; drawPins(); }
function reopen() { if (cur) render(); }
function back() { cur = stack.pop() || null; if (cur) render(); else closeSheet(); }
const open = new Set();   // 展開編輯的點位
const chk = new Set();    // 勾選的點位
function render() {
  const s = cur; if (!s) return;
  $('sheet').hidden = false; $('shBack').hidden = !stack.length;
  $('sheet').classList.toggle('tall', s.type === 'list');
  let title = '', body = '';
  if (s.type === 'item') [title, body] = itemSheet(s.kind, s.id);
  else if (s.type === 'iss') [title, body] = issueSheet(s.id);
  else if (s.type === 'shot') [title, body] = shotSheet(s.id);
  else if (s.type === 'list') [title, body] = s.fn();
  $('shTitle').innerHTML = title; $('shBody').innerHTML = body;
  selKey = s.type === 'item' ? s.kind + ':' + s.id : s.type === 'iss' ? 'i:' + s.id : s.type === 'shot' ? 's:' + s.id : '';
  drawPins();
}
function openKey(key) {
  const [k, id] = [key.slice(0, 1), key.slice(2)];
  if (k === 'i') openIssue(id); else if (k === 's') openShot(id); else openItem(k, id);
}
function openItem(kind, id, push = false) { chk.clear(); open.clear(); openSheet({ type: 'item', kind, id }, push); }
function openIssue(id, push = false) { openSheet({ type: 'iss', id }, push); }
function openShot(id, push = false) { openSheet({ type: 'shot', id }, push); }
const KIND = { p: '電盤', d: '設備', m: '模組' };
function itemSheet(kind, id) {
  const o = itemOf(kind, id);
  if (!o) return ['找不到', '<p class="muted">這個物件不在現場包裡。</p>'];
  const v = progress(kind, id), name = kind === 'p' ? (o.code || '') + ' ' + (o.name || '') : kind === 'm' ? o.code + ' ' + o.name : o.name || o.code;
  const pan = o.panelId ? ix.P.get(o.panelId) : null;
  const sub = [kind === 'd' ? o.type : '', pan && kind !== 'p' ? '電盤 ' + (pan.code || pan.name) : '', v === null ? '' : '完成度 ' + Math.round(v * 100) + '%'].filter(Boolean).join('　');
  const title = `<span class="kind">${KIND[kind]}</span>${esc(name)}<small>${esc(sub)}</small>`;
  let h = '';
  if (kind !== 'p') h += `<div class="sec">到貨／安裝／送電</div>${gearHtml(kind, id)}`;
  if (kind === 'p') {
    const kids = ix.inPanel.get(id) || [];
    if (kids.length) {
      h += `<div class="sec">盤內設備與模組（${kids.length}）</div><div class="list">${kids.map((c) => {
        const x = itemOf(c.kind, c.id), g = gearOf(c.kind, c.id), pv = progress(c.kind, c.id);
        return `<div class="it"><div class="main" data-act="item" data-kind="${c.kind}" data-id="${esc(c.id)}"><b>${esc(c.kind === 'm' ? x.code + ' ' + x.name : x.name || x.code)}</b><small>${KIND[c.kind]}${c.kind === 'd' && x.type ? '・' + esc(x.type) : ''}・點位 ${ptsOf(c.kind, c.id).length}</small><span class="gbs">${GEAR.map(([f, l]) => `<span class="gb${g[f] ? ' on' : ''}">${g[f] ? '✓' : ''}${l}</span>`).join('')}</span></div><span class="pct">${pv === null ? '' : Math.round(pv * 100) + '%'}</span><span class="go">›</span></div>`;
      }).join('')}</div>
      <div class="sec">盤內全部記錄</div><div class="row-btns gearall">${GEAR.map(([f, l]) => `<button class="sb" data-act="gearall" data-f="${f}">${l}</button>`).join('')}</div>`;
    }
  }
  h += pointsHtml(ptsOf(kind, id), kind);
  // 缺失：電盤＝掛在這面盤上的（含盤內設備的），設備、模組＝掛在它上面的（2026-11-19 使用者要求「設備要可以上缺失」）
  const iss = issuesOf(kind, id);
  h += `<div class="sec">缺失（${iss.length}）<span class="grow"></span><button class="sb" data-act="newiss">＋ 新增缺失</button></div>`;
  if (iss.length) h += `<div class="list">${iss.map(issRow).join('')}</div>`;
  h += `<div class="sec">照片（這次新增）${o.nph ? `<span class="muted">電腦上另有照片</span>` : ''}</div>${photosHtml(kind, id)}`;
  return [title, h];
}
function gearHtml(kind, id) {
  const g = gearOf(kind, id);
  const evN = (f) => photosOf(kind, id).filter((x) => x.p.ev === f).length;
  return `<div class="gear">${GEAR.map(([f, l]) => `<span class="gchip"><button class="chip${g[f] ? ' on' : ''}" data-act="gear" data-kind="${kind}" data-id="${esc(id)}" data-f="${f}">${g[f] ? '✓ ' : ''}${l}${g[f] ? `<small>${esc(String(g[f]).slice(5))}</small>` : ''}</button>${EV.includes(f) ? `<button class="evb" data-act="evcam" data-kind="${kind}" data-id="${esc(id)}" data-f="${f}" title="拍照留證">📷${evN(f) ? ' ' + evN(f) : ''}</button>` : ''}</span>`).join('')}</div>`;
}
// 點位屬於哪個模組（模組自己的點位：鏡像設備 md_）、哪個設備
const modOfPt = (t) => t.moduleId || (String(t.deviceId || '').startsWith('md_') ? t.deviceId.slice(3) : '');
const modName = (mid) => { const m = ix.M.get(mid); return m ? ((m.code || '') + ' ' + (m.name || '')).trim() : ''; };
const devName = (t) => String(t.deviceId || '').startsWith('md_') ? '模組 ' + modName(t.deviceId.slice(3)) : (ix.D.get(t.deviceId)?.name || ix.D.get(t.deviceId)?.code || '');
let grpIds = [];   // 這次畫的各組點位（組的勾選用）
function pointsHtml(ids, kind = 'p') {
  if (!ids.length) return `<div class="sec">點位</div><p class="muted">沒有點位</p>`;
  const sts = ix.sts, pts = ids.map(ptOf).sort((a, b) => String(a.ch || '').localeCompare(String(b.ch || ''), 'en', { numeric: true }) || String(a.tag || a.name).localeCompare(String(b.tag || b.name), 'zh-Hant'));
  const all = ids.length && ids.every((id) => chk.has(id));
  let h = `<div class="sec"><input type="checkbox" data-act="chkall" ${all ? 'checked' : ''} aria-label="全選" style="width:22px;height:22px">點位（${ids.length}）・已驗收 ${pts.filter((t) => t.st === '已驗收').length}・OK ${pts.filter((t) => t.ioRes === 'OK').length}</div>`;
  const nC = ids.filter((id) => chk.has(id)).length;
  if (nC) h += `<div class="batch"><b>已選 ${nC}</b><select data-act="bst"><option value="">施工狀態…</option>${sts.map((s) => `<option value="${esc(s || '-')}">${esc(s || '未施工')}</option>`).join('')}</select><button class="sb" data-act="bio" data-v="OK">測試 OK</button><button class="sb" data-act="bio" data-v="NG">NG</button><button class="sb" data-act="bclr">取消</button></div>`;
  // 分組：模組的面板依設備分，其他依模組分（沒有接模組的另成一組）
  const byDev = kind === 'm', groups = new Map();
  for (const t of pts) { const k = byDev ? (t.deviceId || '') : modOfPt(t); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
  const keys = [...groups.keys()].sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || (byDev ? devName({ deviceId: a }) : modName(a)).localeCompare(byDev ? devName({ deviceId: b }) : modName(b), 'zh-Hant', { numeric: true }));
  grpIds = keys.map((k) => groups.get(k).map((t) => t.id));
  const row = (t) => {
    const ed = open.has(t.id), mine = !!rec.pts[t.id];
    const who = byDev ? '' : devName(t), ch = t.ch ? '通道 ' + t.ch : '';
    const sub = (byDev ? [t.signal, ch] : [who, t.signal, ch]).filter(Boolean).join('・');
    return `<div class="it${ed ? ' open' : ''}"><input type="checkbox" data-act="chk" data-id="${esc(t.id)}" ${chk.has(t.id) ? 'checked' : ''}><div class="main" data-act="pt" data-id="${esc(t.id)}" title="${esc(t.tag || '')}"><b>${esc(t.name || '（未命名）')}</b>${mine ? ' <span style="color:#f97316">●</span>' : ''}<small>${esc(sub)}</small></div>${t.ioRes ? `<span class="io ${esc(t.ioRes)}">${esc(t.ioRes)}</span>` : ''}<span class="st" style="--sc:${ST_C[t.st || ''] || '#64748b'}">${esc(t.st || '未施工')}</span></div>${ed ? ptEditor(t) : ''}`;
  };
  keys.forEach((k, gi) => {
    const L = groups.get(k), on = L.every((t) => chk.has(t.id));
    const nm = byDev ? (devName({ deviceId: k }) || '（沒有設備）') : k ? modName(k) || '模組' : '沒有接模組';
    const done = L.filter((t) => t.st === '已驗收').length;
    if (keys.length > 1 || k) h += `<div class="grp"><input type="checkbox" data-act="chkgrp" data-g="${gi}" ${on ? 'checked' : ''} aria-label="選這一組"><span class="kind">${byDev ? '設備' : k ? '模組' : '—'}</span><b>${esc(nm)}</b><span class="pct">${L.length} 點${done ? '・驗收 ' + done : ''}</span></div>`;
    h += `<div class="list">${L.map(row).join('')}</div>`;
  });
  return h;
}
function ptEditor(t) {
  const sts = ix.sts;
  return `<div class="ed">
    <div class="note">施工狀態${t.stAt ? '（' + esc(t.stAt) + '）' : ''}</div>
    <div class="seg">${sts.map((s) => `<button data-act="pst" data-id="${esc(t.id)}" data-v="${esc(s || '-')}" class="${(t.st || '') === s ? 'on' : ''}" style="--sc:${ST_C[s] || '#2563eb'}">${esc(s || '未施工')}</button>`).join('')}</div>
    <div class="note">測試結果${t.ioAt ? '（' + esc(t.ioAt) + '）' : ''}</div>
    <div class="seg">${[['', '未測'], ['OK', 'OK'], ['NG', 'NG']].map(([v, l]) => `<button data-act="pio" data-id="${esc(t.id)}" data-v="${v || '-'}" class="${(t.ioRes || '') === v ? 'on' : ''}" style="--sc:${v === 'OK' ? '#16a34a' : v === 'NG' ? '#dc2626' : '#64748b'}">${l}</button>`).join('')}</div>
    <label class="fld"><span>量測值</span><input data-act="pf" data-f="ioVal" data-id="${esc(t.id)}" value="${esc(t.ioVal || '')}"></label>
    <label class="fld"><span>測試備註</span><input data-act="pf" data-f="ioNote" data-id="${esc(t.id)}" value="${esc(t.ioNote || '')}"></label>
    <label class="fld"><span>施工備註</span><input data-act="pf" data-f="stNote" data-id="${esc(t.id)}" value="${esc(t.stNote || '')}"></label>
  </div>`;
}
// 物件上的缺失（電盤含盤內設備、模組的）
function issuesOf(kind, id) {
  return issues().filter((x) => !x.del && (kind === 'p' ? x.panelId === id : kind === 'd' ? x.devId === id : x.modId === id));
}
// 對物件新增缺失的欄位（同 2D 的 issAddObj：位置照物件，物件在電盤裡時照電盤）
function issueFields(kind, id) {
  const o = itemOf(kind, id); if (!o) return {};
  const pid = kind === 'p' ? o.id : o.panelId || '', pan = pid ? ix.P.get(pid) : null, pos = isPlaced(o) ? o : isPlaced(pan) ? pan : null;
  return { floorId: (kind === 'p' ? o.floorId : pan?.floorId || o.floorId) || curFloor, panelId: pid, ...(kind === 'd' ? { devId: id } : kind === 'm' ? { modId: id } : {}),
    ...(pos ? { x: +Math.min(100, +pos.x + 1.2).toFixed(2), y: +Math.max(0, +pos.y - 1.2).toFixed(2) } : {}) };
}
const issObjName = (x) => x.devId ? '設備 ' + (ix.D.get(x.devId)?.name || '') : x.modId ? '模組 ' + modName(x.modId) : '';
function issRow(x) {
  return `<div class="it"><div class="main" data-act="iss" data-id="${esc(x.id)}"><b>${esc(x.no)} ${esc(x.title || '（未填標題）')}</b><small>${esc([x.at, issObjName(x)].filter(Boolean).join('・'))}${x.isNew ? '・手機新增' : rec.iss[x.id] ? '・手機改過' : ''}</small></div><span class="st" style="--sc:${ISS_C[x.st] || '#64748b'}">${esc(x.st)}</span><span class="go">›</span></div>`;
}
function issueSheet(id) {
  const x = issues().find((q) => q.id === id);
  if (!x) return ['找不到缺失', ''];
  const pan = x.panelId ? ix.P.get(x.panelId) : null, fl = ix.F.get(x.floorId);
  const title = `<span class="kind">缺失</span>${esc(x.no)}<small>${esc([fl?.name, pan ? '電盤 ' + (pan.code || pan.name) : '', issObjName(x), x.isNew ? '手機新增' : ''].filter(Boolean).join('　'))}</small>`;
  const objBtn = x.devId && ix.D.has(x.devId) ? ['d', x.devId, '看設備 ' + (ix.D.get(x.devId).name || '')] : x.modId && ix.M.has(x.modId) ? ['m', x.modId, '看模組 ' + modName(x.modId)] : null;
  const h = `<div class="note">狀態</div><div class="seg">${(pack.ists?.length ? pack.ists : Object.keys(ISS_C)).map((s) => `<button data-act="ist" data-v="${esc(s)}" class="${x.st === s ? 'on' : ''}" style="--sc:${ISS_C[s] || '#2563eb'}">${esc(s)}</button>`).join('')}</div>
    <label class="fld"><span>標題</span><input data-act="if" data-f="title" value="${esc(x.title || '')}" placeholder="例如：線槽未固定"></label>
    <label class="fld"><span>說明</span><textarea data-act="if" data-f="note" placeholder="位置、狀況、要怎麼處理">${esc(x.note || '')}</textarea></label>
    <div class="row-btns">${pan && !stack.some((q) => q.type === 'item' && q.id === pan.id) ? `<button class="sb" data-act="item" data-kind="p" data-id="${esc(pan.id)}">看電盤 ${esc(pan.code || pan.name)}</button>` : ''}${objBtn && !stack.some((q) => q.type === 'item' && q.id === objBtn[1]) ? `<button class="sb" data-act="item" data-kind="${objBtn[0]}" data-id="${esc(objBtn[1])}">${esc(objBtn[2])}</button>` : ''}</div>
    <div class="sec">照片（這次新增）${x.nph ? '<span class="muted">電腦上另有 ' + x.nph + ' 張</span>' : ''}</div>${photosHtml('i', id)}
    ${x.isNew ? '<div class="row-btns"><button class="sb bad" data-act="deliss">刪除這筆缺失</button></div>' : ''}`;
  return [title, h];
}
function shotSheet(id) {
  const x = shots().find((q) => q.id === id);
  if (!x) return ['找不到拍攝點', ''];
  const title = `<span class="kind">拍攝點</span>${esc(x.title || x.no)}<small>${esc(ix.F.get(x.floorId)?.name || '')}${x.isNew ? '　手機新增' : ''}</small>`;
  let h = '';
  if (x.isNew) h += `<label class="fld"><span>名稱</span><input data-act="sf" value="${esc(x.title || '')}"></label>`;
  h += `<div class="sec">照片（這次新增）${x.nph ? '<span class="muted">電腦上另有 ' + x.nph + ' 張</span>' : ''}</div>${photosHtml('s', id)}`;
  if (x.isNew) h += '<div class="row-btns"><button class="sb bad" data-act="delshot">刪除這個拍攝點</button></div>';
  return [title, h];
}

/* 面板裡的點擊 */
function onSheetClick(e) {
  if (Date.now() < ghostUntil) { e.preventDefault(); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act, id = b.dataset.id;
  if (a === 'item') openItem(b.dataset.kind, id, true);
  else if (a === 'iss') openIssue(id, true);
  else if (a === 'gear') { const g = gearOf(b.dataset.kind, id); setGear(b.dataset.kind, id, b.dataset.f, !g[b.dataset.f]); reopen(); }
  else if (a === 'gearall') {
    const kids = ix.inPanel.get(cur.id) || [], f = b.dataset.f, on = !kids.every((c) => gearOf(c.kind, c.id)[f]);
    for (const c of kids) { const v = gearOf(c.kind, c.id); rec.gear[c.kind + ':' + c.id] = { ...gearPick(v), [f]: on ? (v[f] || today()) : '', pgTs: Date.now() }; }
    touch(); reopen(); toast((on ? '已全部記錄「' : '已全部取消「') + GEAR.find((x) => x[0] === f)[1] + '」（' + kids.length + ' 項）');
  }
  else if (a === 'pt') { if (open.has(id)) open.delete(id); else open.add(id); reopen(); }
  else if (a === 'chk') { if (b.checked) chk.add(id); else chk.delete(id); reopen(); }
  else if (a === 'chkgrp') { const ids = grpIds[+b.dataset.g] || []; if (b.checked) ids.forEach((x) => chk.add(x)); else ids.forEach((x) => chk.delete(x)); reopen(); }
  else if (a === 'chkall') { const ids = ptsOf(cur.kind, cur.id); if (b.checked) ids.forEach((x) => chk.add(x)); else ids.forEach((x) => chk.delete(x)); reopen(); }
  else if (a === 'bio') { const ids = [...chk]; setPts(ids, { ioRes: b.dataset.v }); toast('已把 ' + ids.length + ' 個點位的測試結果設為 ' + b.dataset.v); reopen(); }
  else if (a === 'bclr') { chk.clear(); reopen(); }
  else if (a === 'pst') { setPts([id], { st: b.dataset.v === '-' ? '' : b.dataset.v }); reopen(); }
  else if (a === 'pio') { setPts([id], { ioRes: b.dataset.v === '-' ? '' : b.dataset.v }); reopen(); }
  else if (a === 'newiss') { const it = newIssue(issueFields(cur.kind, cur.id)); openIssue(it.id, true); }
  else if (a === 'ist') { setIssue(cur.id, { st: b.dataset.v }); reopen(); }
  else if (a === 'evcam') pickPhoto({ k: b.dataset.kind, tid: id, ev: b.dataset.f, after: reopen }, true);
  else if (a === 'cam' || a === 'pics') pickPhoto({ k: b.dataset.k, tid: b.dataset.tid, after: reopen }, a === 'cam');
  else if (a === 'delph') { if (confirm('刪除這張照片？')) removePhoto(id); }
  else if (a === 'deliss') { if (!confirm('刪除這筆手機新增的缺失？')) return; delete rec.iss[cur.id]; dropPhotos('i', cur.id); touch(); back(); }
  else if (a === 'delshot') { if (!confirm('刪除這個拍攝點和它的照片？')) return; delete rec.shots[cur.id]; dropPhotos('s', cur.id); touch(); back(); }
  else if (a === 'goto') { const [k, gid] = [b.dataset.k, id]; goTo(k, gid); }
}
async function dropPhotos(k, tid) { for (const x of photosOf(k, tid)) await phDel(x.id); photos = photos.filter((x) => !(x.k === k && x.tid === tid)); }
function onSheetChange(e) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act;
  if (a === 'bst' && b.value) { const ids = [...chk], v = b.value === '-' ? '' : b.value; setPts(ids, { st: v }); toast('已把 ' + ids.length + ' 個點位設為「' + (v || '未施工') + '」'); reopen(); }
  else if (a === 'pf') { setPts([b.dataset.id], { [b.dataset.f]: b.value }); }
  else if (a === 'if') { setIssue(cur.id, { [b.dataset.f]: b.value }); }
  else if (a === 'sf') { const s = rec.shots[cur.id]; if (s) { s.title = b.value; touch(); } }
}

/* ---------- 搜尋、缺失清單 ---------- */
function goTo(k, id) {
  const o = k === 'i' ? issues().find((x) => x.id === id) : k === 's' ? shots().find((x) => x.id === id) : itemOf(k, id);
  if (!o) return;
  let fl = o.floorId, pos = isPlaced(o) ? o : null;
  if (!pos && o.panelId) { const p = ix.P.get(o.panelId); if (p) { fl = fl || p.floorId; if (isPlaced(p)) pos = p; } }
  if (fl && fl !== curFloor) setFloor(fl);
  if (pos) { const q = toImg(pos), m = $('map'), k2 = Math.max(view.k, 1.2 * Math.min(m.clientWidth / imgW, m.clientHeight / imgH) * 4); view.k = Math.min(k2, 6); view.x = m.clientWidth / 2 - q.x * view.k; view.y = m.clientHeight * 0.3 - q.y * view.k; applyView(); }
  if (k === 'i') openIssue(id); else if (k === 's') openShot(id); else openItem(k, id);
}
let searchQ = '';
function openSearch() {
  openSheet({ type: 'list', fn: () => {
    const q = searchQ.trim().toLowerCase(), hit = [];
    if (q) {
      const fl = (id) => ix.F.get(id)?.name || '';
      for (const p of pack.panels) if (`${p.code} ${p.name}`.toLowerCase().includes(q)) hit.push(['p', p.id, `${p.code} ${p.name}`, '電盤・' + fl(p.floorId)]);
      for (const d of pack.devices) if (`${d.code} ${d.name} ${d.type}`.toLowerCase().includes(q)) hit.push(['d', d.id, d.name || d.code, '設備・' + fl(d.floorId) + (d.panelId ? '・' + (ix.P.get(d.panelId)?.code || '') : '')]);
      for (const m of pack.modules) if (`${m.code} ${m.name}`.toLowerCase().includes(q)) hit.push(['m', m.id, `${m.code} ${m.name}`, '模組・' + fl(m.floorId)]);
      for (const x of issues()) if (!x.del && `${x.no} ${x.title}`.toLowerCase().includes(q)) hit.push(['i', x.id, `${x.no} ${x.title}`, '缺失・' + fl(x.floorId)]);
    }
    return ['搜尋', `<input class="search" id="searchIn" type="search" placeholder="盤號、設備名稱、編號、缺失" value="${esc(searchQ)}" autocomplete="off">
      ${q ? (hit.length ? `<div class="list">${hit.slice(0, 80).map(([k, id, n, s]) => `<div class="it"><div class="main" data-act="goto" data-k="${k}" data-id="${esc(id)}"><b>${esc(n)}</b><small>${esc(s)}</small></div><span class="go">›</span></div>`).join('')}</div>${hit.length > 80 ? '<p class="note">只列前 80 筆</p>' : ''}` : '<p class="muted">找不到</p>') : '<p class="muted">輸入要找的文字</p>'}`];
  } });
  const inp = $('searchIn'); inp?.focus();
}
function openIssueList() {
  openSheet({ type: 'list', fn: () => {
    const all = issues().filter((x) => !x.del), here = all.filter((x) => x.floorId === curFloor), other = all.length - here.length;
    const ord = { '開放': 0, '處理中': 1, '已結案': 2 };
    here.sort((a, b) => (ord[a.st] ?? 3) - (ord[b.st] ?? 3) || String(a.no).localeCompare(String(b.no)));
    return [`缺失（${esc(ix.F.get(curFloor)?.name || '')}）<small>${other ? '其他樓層另有 ' + other + ' 筆（用搜尋找）' : ''}</small>`,
      `<div class="row-btns"><button class="sb pri" data-act="newiss2">＋ 新增缺失（不指定位置）</button></div>${here.length ? `<div class="list">${here.map((x) => issRow(x).replace('data-act="iss"', 'data-act="goto" data-k="i"')).join('')}</div>` : '<p class="muted">這層沒有缺失。長按底圖空白處可以在那個位置新增。</p>'}`];
  } });
}

/* ---------- 匯入現場包、輸出記錄 ---------- */
async function importPack(file) {
  busy('讀取現場包…');
  let d;
  try { d = JSON.parse(await file.text()); } catch (_) { busy(false); toast('讀不到這個檔（不是 JSON）', true); return; }
  busy(false);
  if (d?.type === 'pp-field-rec') { toast('這是手機輸出的記錄檔，要在電腦的 2D「📱 匯入手機記錄」匯入', true); return; }
  if (d?.type !== 'pp-field-pack') { toast('這不是現場包：請選電腦 2D「📱 匯出手機現場包」存的檔', true); return; }
  const n = recCount();
  if (n && pack) {
    const same = (pack.code || pack.name) === (d.code || d.name);
    const msg = same ? `手機上還有 ${n} 項記錄。\n\n已經輸出並在電腦匯入過了嗎？\n「確定」＝清除這些記錄\n「取消」＝保留（疊在新的現場包上，之後照樣可以輸出）`
      : `手機上還有「${pack.name || pack.code}」的 ${n} 項記錄，新的現場包是另一個專案「${d.name || d.code}」。\n\n「確定」＝清除舊專案的記錄並匯入\n「取消」＝不匯入（先輸出記錄）`;
    const clear = confirm(msg);
    if (!same && !clear) return;
    if (clear) { rec = emptyRec(); photos = []; await phClear(); }
  }
  busy('儲存到手機…');
  try { await kvPut('pack', d); await kvPut('rec', rec); navigator.storage?.persist?.(); }
  catch (e) { busy(false); toast('存不進手機（空間不夠？）：' + e.message, true); return; }
  busy(false);
  pack = d; start();
  toast('已匯入現場包：' + (d.name || d.code) + '（' + d.floors.length + ' 層）');
}
// 這支手機的代號、第幾次輸出（localStorage；清掉也只是編號重來）
function phoneId() { let r = ''; try { r = localStorage.getItem('pp-field-rid') || ''; if (!r) { r = uid('ph'); localStorage.setItem('pp-field-rid', r); } } catch (_) { r = 'ph-unknown'; } return r; }
function nextSeq() { try { return (+localStorage.getItem('pp-field-seq') || 0) + 1; } catch (_) { return 1; } }
function recFile(seq) {
  const pts = Object.entries(rec.pts).map(([id, v]) => ({ id, ...v }));
  const gear = (k) => Object.entries(rec.gear).filter(([key]) => key[0] === k).map(([key, v]) => ({ id: key.slice(2), ...v }));
  const iss = Object.entries(rec.iss).map(([id, v]) => {
    if (v.isNew) return { ...v, id };
    return { id, ...(v.st !== undefined ? { st: v.st } : {}), ...(v.title !== undefined ? { title: v.title } : {}), ...(v.note !== undefined ? { note: v.note } : {}), upd: v.upd };
  });
  const sh = Object.values(rec.shots).map((s) => ({ id: s.id, no: s.no, title: s.title, floorId: s.floorId, x: s.x, y: s.y, at: s.at }));
  return { type: 'pp-field-rec', v: 1, code: pack.code || '', name: pack.name || '', at: new Date().toISOString(), pack: pack.id || '', rid: phoneId(), seq: seq ?? nextSeq(), app: APP_VER,
    points: pts, devices: gear('d'), modules: gear('m'), issues: iss, shots: sh, photos: photos.map((x) => ({ k: x.k, id: x.tid, p: x.p })) };
}
async function exportRec() {
  if (!pack) return;
  const n = recCount();
  if (!n) { toast('還沒有任何記錄'); return; }
  busy('製作記錄檔…');
  const d = new Date(), stamp = today().replace(/-/g, '') + p2(d.getHours()) + p2(d.getMinutes());
  const seq = nextSeq(), name = (pack.code || pack.name || 'project') + '_現場記錄_第' + seq + '次_' + stamp + '.json';
  const txt = JSON.stringify(recFile(seq)), file = new File([txt], name, { type: 'application/json' });
  // Android Chrome 的分享只接受圖片、PDF、純文字等，.json 會「Permission denied」：分享時改成 .txt（內容一樣是 JSON，2D 的匯入接受 .txt）
  const sfile = new File([txt], name.replace(/\.json$/, '.txt'), { type: 'text/plain' });
  busy(false);
  if (FN) {
    const nat = async (how) => { busy(how === 'share' ? '準備分享…' : '存到手機…'); try { const data = await b64Of(file);
        if (how === 'share') await FN.share({ data, name, mime: 'application/json', title: name });
        else { const r = await FN.saveDownload({ data, name, mime: 'application/json', folder: photoFolder() }); toast('已存到手機：' + r.path); }
        marked(seq, how !== 'share'); } catch (e) { toast((how === 'share' ? '分享失敗：' : '存不進手機：') + (e?.message || e), true); } finally { busy(false); } };
    showPop(innerWidth / 2, 90, `記錄檔 ${name}（${(file.size / 1048576).toFixed(1)} MB）`, [
      ['☁ 分享（選「雲端硬碟」存檔）', () => nat('share')],
      ['⬇ 存到手機（Download／' + photoFolder() + '）', () => nat('save')],
    ]);
    return;
  }
  showPop(innerWidth / 2, 90, `記錄檔 ${name}（${(file.size / 1048576).toFixed(1)} MB）`, [
    ...(navigator.canShare?.({ files: [sfile] }) ? [['☁ 分享（選「雲端硬碟」存檔）', async () => { try { await navigator.share({ files: [sfile], title: sfile.name }); marked(seq); } catch (e) { if (e.name !== 'AbortError') toast('分享失敗：' + e.message, true); } }]] : []),
    ['⬇ 下載到手機', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); marked(seq); }],
  ]);
}
function marked(seq, quiet) { try { localStorage.setItem('pp-field-seq', String(seq)); } catch (_) { /* 存不了 */ } rec.exported = Date.now(); touch(); if (!quiet) toast('存到專案的「施工進度」資料夾，電腦 2D「施工進度」頁按「匯入手機記錄」'); }
function renderRecBar() {
  const n = pack ? recCount() : 0;
  $('recBar').hidden = !n;
  if (n) $('recTxt').textContent = `手機上有 ${n} 項記錄` + (rec.exported && rec.exported >= rec.changed - 200 ? '（已輸出）' : '（還沒輸出）');
}
function openMenu() {
  showPop(innerWidth - 120, 40, (pack ? (pack.name || pack.code) + (pack.at ? '・現場包 ' + pack.at.slice(0, 10) : '') + '・' : '') + '版本 ' + APP_VER, [
    ['📥 匯入現場包', () => $('filePack').click()],
    ['📤 輸出記錄', exportRec],
    '-',
    [saveCamOn() ? '📥 拍照另存到手機：開（點一下關）' : '📥 拍照另存到手機：關（點一下開）', () => { const on = !saveCamOn(); try { localStorage.setItem('pp-field-savecam', on ? '1' : '0'); } catch (_) { /* 存不了 */ } toast(on ? (FN ? '拍照後會另存一份到「' + photoFolderLabel() + '」' : '拍照後會另存一份到手機的 Download 資料夾（Google 相簿可以備份這個資料夾）') : '拍照後不另存到手機'); }],
    // 照片資料夾：用系統的「選擇資料夾」畫面選（2026-11-19 使用者要求「資料夾要可以用選的，而不是我自己打」）
    ...(FN ? [['📁 照片資料夾：' + photoFolderLabel() + '（點一下選）', async () => {
      try { const r = await FN.pickFolder({}); setPickedFolder({ uri: r.uri, name: r.name }); toast('照片會存到「' + r.name + '」（Google 相簿 → 備份 → 備份裝置資料夾，打開這個資料夾就會自動備份）'); }
      catch (e) { if (!/取消|CANCEL/i.test(String(e?.message || e) + (e?.code || ''))) toast('選資料夾失敗：' + (e?.message || e), true); } }],
      ...(pickedFolder() ? [['↩ 照片改回預設資料夾（圖片／' + photoFolder() + '）', () => { setPickedFolder(null); toast('照片會存到「圖片／' + photoFolder() + '」'); }]] : [])] : []),
    ['🗑 清除手機上的記錄', async () => { const n = recCount(); if (!n) { toast('沒有記錄'); return; } if (!confirm(`清除手機上的 ${n} 項記錄（含照片）？\n還沒在電腦匯入的會不見。`)) return; rec = emptyRec(); photos = []; await phClear(); await kvPut('rec', rec); renderRecBar(); drawPins(); reopen(); toast('已清除'); }],
    ['❔ 說明', () => alert('現場記錄\n\n1. 電腦 2D「施工進度」頁按「📱 匯出手機現場包」，存到 Google 雲端硬碟。\n2. 這裡「匯入現場包」選那個檔（之後沒網路也能用）。\n3. 點底圖上的電盤、設備記錄施工狀態、測試結果、到貨／安裝／送電，拍照。\n   長按空白處新增缺失或拍攝點；點位可以勾選後一起改。\n4. 「輸出記錄」→ 分享到雲端硬碟。\n5. 電腦 2D「施工進度」頁按「📱 匯入手機記錄」。\n\n' + (NATIVE ? '記錄存在這個 app 裡；解除安裝或清除 app 資料會不見，記得輸出。' : '記錄存在這支手機的瀏覽器裡；清除瀏覽器資料會不見，記得輸出。'))],
  ]);
}

/* ---------- 啟動 ---------- */
function start() {
  buildIndex();
  $('empty').hidden = true;
  $('projName').textContent = (pack.code ? pack.code + ' ' : '') + (pack.name || '');
  const fl = [...pack.floors].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  $('floorSel').innerHTML = fl.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
  let want = ''; try { want = localStorage.getItem('pp-field-floor') || ''; } catch (_) { /* 讀不到 */ }
  setFloor(ix.F.has(want) ? want : fl[0]?.id);
  renderRecBar();
}
async function boot() {
  const m = $('map');
  m.addEventListener('pointerdown', onDown);
  m.addEventListener('pointermove', onMove);
  m.addEventListener('pointerup', onUp);
  m.addEventListener('pointercancel', onUp);
  m.addEventListener('wheel', onWheel, { passive: false });
  m.addEventListener('contextmenu', (e) => e.preventDefault());
  $('floorSel').addEventListener('change', (e) => { closeSheet(); setFloor(e.target.value); });
  $('btnMenu').addEventListener('click', openMenu);
  $('btnSearch').addEventListener('click', () => { if (pack) openSearch(); });
  $('btnIss').addEventListener('click', () => { if (pack) openIssueList(); });
  $('btnExport2').addEventListener('click', exportRec);
  $('shClose').addEventListener('click', closeSheet);
  $('shBack').addEventListener('click', back);
  $('shBody').addEventListener('click', onSheetClick);
  $('shBody').addEventListener('change', onSheetChange);
  $('shBody').addEventListener('input', (e) => { if (e.target.id === 'searchIn') { searchQ = e.target.value; const pos = e.target.selectionStart; render(); const i = $('searchIn'); i.focus(); i.setSelectionRange(pos, pos); } });
  $('shBody').addEventListener('click', (e) => { if (e.target.closest('[data-act="newiss2"]')) { const it = newIssue({}); openIssue(it.id, true); } });
  document.querySelector('[data-act="import"]').addEventListener('click', () => $('filePack').click());
  $('filePack').addEventListener('change', (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importPack(f); });
  $('fileCam').addEventListener('change', onPhotoFiles);
  $('filePics').addEventListener('change', onPhotoFiles);
  addEventListener('resize', () => { if (pack && !cur) fitView(); });
  document.addEventListener('pointerdown', (e) => { if (!$('pop').hidden && !e.target.closest('#pop')) hidePop(); }, true);
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !NATIVE) {   // app 裡頁面檔案本來就在手機上，不用離線快取
    // 換了新版的離線程式（sw.js）時自動重新整理一次，才會用到新版的頁面（第一次安裝不用）
    const had = !!navigator.serviceWorker.controller; let done = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had && !done) { done = true; location.reload(); } });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => reg.update()).catch(() => { /* 沒有離線快取也能用 */ });
  }
  try {
    pack = await kvGet('pack') || null;
    rec = { ...emptyRec(), ...(await kvGet('rec') || {}) };
    photos = await phAll() || [];
  } catch (e) { toast('讀不到手機上的資料：' + e.message, true); }
  if (pack) start(); else $('empty').hidden = false;
  showWhatsNew();
}
// 手機頁換新版後第一次打開：提示這一版改了什麼（第一次安裝不提示）
function showWhatsNew() {
  let last = ''; try { last = localStorage.getItem('pp-field-ver') || ''; localStorage.setItem('pp-field-ver', APP_VER); } catch (_) { return; }
  if (!last || last === APP_VER) return;
  const vs = Object.keys(CHANGES).filter((v) => v > last).sort().reverse();
  const items = vs.flatMap((v) => CHANGES[v]);
  const el = document.createElement('div'); el.className = 'whatsnew';
  el.innerHTML = `<div class="wn-box"><b>已更新到版本 ${esc(APP_VER)}</b>${items.length ? `<ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}<button class="sb pri">知道了</button></div>`;
  el.querySelector('button').onclick = () => el.remove();
  document.body.appendChild(el);
}
window.fieldApp = { get pack() { return pack; }, get rec() { return rec; }, get photos() { return photos; }, recFile, importPack, setFloor, openKey, goTo, setPts, setGear };   // 測試用
boot();
