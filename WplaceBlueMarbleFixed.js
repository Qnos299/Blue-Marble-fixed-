// ==UserScript==
// @name         Blue Marble (Overlay + Color Filter) — Fixed
// @namespace    https://github.com/SwingTheVine/
// @version      0.83.1-fixed
// @description  Visual template overlay for Wplace with per-color pixel show/hide. NO automation. Robust GM polyfills.
// @author       SwingTheVine + fix by ChatGPT
// @license      MPL-2.0
// @homepageURL  https://github.com/SwingTheVine/Wplace-BlueMarble
// @icon         https://raw.githubusercontent.com/SwingTheVine/Wplace-BlueMarble/main/dist/assets/Favicon.png
// @run-at       document-start
// @match        *://*.wplace.live/*
// @grant        GM_addStyle
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_info
// ==/UserScript==
/*  ─────────────────────────────────────────────────────────────────────────────
    WHAT THIS SCRIPT DOES
    - Adds a small draggable panel.
    - Lets you upload a template image and place it at (tileX, tileY, pxX, pxY).
    - Overlays the template over Wplace tiles (ghost pixels aligned to grid).
    - Lists every color in your template and lets you enable/disable each color.
    - No pixel placement, no automation, no network to third parties. Pure overlay.

    If your manager doesn't expose some GM_* APIs, this file polyfills them.
    That fixes "GM_addStyle is not defined" and similar issues.
    ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // ───────────────────────── GM POLYFILLS ─────────────────────────
  const gm = (typeof GM !== 'undefined') ? GM : {};
  const gmInfo = (typeof GM_info !== 'undefined') ? GM_info : { script: { name: 'Blue Marble (Fixed)', version: '0.83.1-fixed' } };

  async function gmGetValue(key, def) {
    if (gm.getValue) return gm.getValue(key, def);
    if (typeof GM_getValue === 'function') return GM_getValue(key, def);
    try { return JSON.parse(localStorage.getItem('gm_' + key)) ?? def; } catch { return def; }
  }
  async function gmSetValue(key, val) {
    if (gm.setValue) return gm.setValue(key, val);
    if (typeof GM_setValue === 'function') return GM_setValue(key, val);
    try { localStorage.setItem('gm_' + key, JSON.stringify(val)); } catch {}
  }
  function gmAddStyle(css) {
    // TM exposes GM_addStyle; VM exposes GM.addStyle; GM4 often neither.
    if (typeof GM_addStyle === 'function') return GM_addStyle(css);
    if (gm.addStyle) return gm.addStyle(css);
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
    return s;
  }

  // ───────────────────────── UTILITIES ─────────────────────────
  const $ = sel => document.querySelector(sel);
  const el = (tag, props = {}, attrs = {}) => {
    const e = document.createElement(tag);
    Object.assign(e, props);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };

  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

  // Canvas helpers with Offscreen fallback-safe access.
  function mkCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') {
      const o = new OffscreenCanvas(w, h);
      return { canvas: o, ctx: o.getContext('2d', { willReadFrequently: true }), offscreen: true };
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return { canvas: c, ctx: c.getContext('2d', { willReadFrequently: true }), offscreen: false };
  }
  async function canvasToBlob(canvas, type = 'image/png', quality) {
    if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
    return new Promise(res => canvas.toBlob(res, type, quality));
  }

  // decode to ImageBitmap (fallback to HTMLImageElement)
  async function toBitmap(blobOrCanvas) {
    try {
      if (blobOrCanvas instanceof Blob) {
        return await createImageBitmap(blobOrCanvas);
      } else {
        // canvas
        const b = await canvasToBlob(blobOrCanvas);
        return await createImageBitmap(b);
      }
    } catch {
      // Fallback via Image element
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        if (blobOrCanvas instanceof Blob) {
          img.src = URL.createObjectURL(blobOrCanvas);
        } else {
          img.src = blobOrCanvas.toDataURL('image/png');
        }
      });
    }
  }

  // ───────────────────────── STATE ─────────────────────────
  const STATE = {
    enabled: true,
    template: null, // { name, coords:[tlX,tlY,pxX,pxY], tiles: Map(key->ImageBitmap), palette: Map("r,g,b"->{count,enabled}) }
    ui: {},
  };

  const CSS = `
  #bm-panel {
    position: fixed; top: 10px; right: 75px; z-index: 99999;
    display: flex; flex-direction: column;
    min-width: 220px; max-width: 320px; gap: 8px;
    padding: 10px; border-radius: 12px;
    background: rgba(16,18,27,0.9); backdrop-filter: blur(4px);
    color: #fff; font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial;
    box-shadow: 0 6px 18px rgba(0,0,0,0.3);
  }
  #bm-title { display:flex; align-items:center; gap:8px; cursor: move; user-select:none; }
  #bm-title img { width: 22px; height: 22px; }
  #bm-title h1 { font-size: 14px; margin: 0; font-weight: 600; }
  #bm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  #bm-grid input { width: 100%; padding: 6px 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background:#1c1f2b; color:#fff; }
  #bm-actions { display:flex; gap:6px; }
  #bm-actions button, #bm-actions label>button {
    flex:1 1 0; padding:8px 10px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.1);
    background:#2a3042; color:#fff; cursor:pointer;
  }
  #bm-actions button:hover { background:#343b55; }
  #bm-status {
    min-height: 44px; max-height: 120px; resize: vertical;
    padding: 8px; border-radius: 8px; border: 1px dashed rgba(255,255,255,0.25);
    background: #111421; color:#d0d6ff; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size:12px;
  }
  #bm-colors { max-height: 160px; overflow: auto; padding:6px; border:1px solid rgba(255,255,255,0.1); border-radius:8px; }
  .bm-color-row { display:flex; align-items:center; gap:8px; margin:4px 0; }
  .bm-swatch { width:14px; height:14px; border:1px solid rgba(255,255,255,0.6); border-radius:3px; }
  .bm-right { margin-left:auto; opacity:.8; font-size:12px; }
  .bm-muted { opacity:.75; }
  #bm-minihint { font-size: 11px; opacity: .8; }
  `;
  gmAddStyle(CSS);

  // ───────────────────────── UI ─────────────────────────
  function logStatus(text) {
    if (!STATE.ui.status) return;
    STATE.ui.status.value = `${text}\n` + STATE.ui.status.value;
  }

  function buildPanel() {
    const panel = el('div', { id: 'bm-panel' });
    const title = el('div', { id: 'bm-title' });
    const icon = el('img', { src: 'https://raw.githubusercontent.com/SwingTheVine/Wplace-BlueMarble/main/dist/assets/Favicon.png', alt:'Blue Marble' });
    const h1 = el('h1', { textContent: `Blue Marble • ${gmInfo.script.version}` });
    title.append(icon, h1);
    panel.append(title);

    const coordGrid = el('div', { id: 'bm-grid' });
    const inTlX = el('input', { id:'bm-tlx', placeholder:'Tl X', type:'number', min:0, max:2047, step:1 });
    const inTlY = el('input', { id:'bm-tly', placeholder:'Tl Y', type:'number', min:0, max:2047, step:1 });
    const inPxX = el('input', { id:'bm-pxx', placeholder:'Px X', type:'number', min:0, max:2047, step:1 });
    const inPxY = el('input', { id:'bm-pxy', placeholder:'Px Y', type:'number', min:0, max:2047, step:1 });
    coordGrid.append(inTlX, inTlY, inPxX, inPxY);
    panel.append(coordGrid);

    const actions = el('div', { id:'bm-actions' });
    const pickWrap = el('label', { style:'flex:1 1 0;' });
    const file = el('input', { id:'bm-file', type:'file' }, { accept:'image/png, image/jpeg, image/webp, image/bmp, image/gif' });
    file.style.display = 'none';
    const btnPick = el('button', { textContent:'Upload' });
    pickWrap.append(file, btnPick);
    const btnCreate = el('button', { id:'bm-create', textContent:'Create' });
    const btnEnable = el('button', { id:'bm-enable', textContent:'Enable' });
    const btnDisable = el('button', { id:'bm-disable', textContent:'Disable' });
    actions.append(pickWrap, btnCreate, btnEnable, btnDisable);
    panel.append(actions);

    // Colors
    const colorsHeader = el('div', { style:'display:flex;align-items:center;gap:8px;' });
    colorsHeader.append(el('div', { textContent:'Template Colors', style:'font-weight:600;' }));
    const btnAllOn = el('button', { textContent:'Enable All', style:'margin-left:auto;padding:6px 8px;' });
    const btnAllOff = el('button', { textContent:'Disable All', style:'padding:6px 8px;' });
    colorsHeader.append(btnAllOn, btnAllOff);
    panel.append(colorsHeader);

    const colors = el('div', { id:'bm-colors' });
    colors.append(el('div', { className:'bm-muted', textContent:'No template yet.' }));
    panel.append(colors);

    const status = el('textarea', { id:'bm-status', placeholder:'Status…', readOnly:true });
    panel.append(status);

    panel.append(el('div', { id:'bm-minihint', className:'bm-muted',
      textContent: 'Tip: click the canvas to autofill coordinates; only visual overlay is added.'
    }));

    document.documentElement.append(panel);

    // Save to state
    STATE.ui = {
      panel, title, file, btnPick, btnCreate, btnEnable, btnDisable, colors, btnAllOn, btnAllOff,
      inTlX, inTlY, inPxX, inPxY, status,
    };

    // Restore coords if any
    gmGetValue('bmCoords', null).then(v => {
      if (!v) return;
      inTlX.value = v.tlx ?? '';
      inTlY.value = v.tly ?? '';
      inPxX.value = v.pxx ?? '';
      inPxY.value = v.pxy ?? '';
    });

    const persistCoords = () => gmSetValue('bmCoords', {
      tlx: Number(inTlX.value) || 0,
      tly: Number(inTlY.value) || 0,
      pxx: Number(inPxX.value) || 0,
      pxy: Number(inPxY.value) || 0
    });
    [inTlX, inTlY, inPxX, inPxY].forEach(inp => {
      inp.addEventListener('input', persistCoords);
      inp.addEventListener('change', persistCoords);
    });

    btnPick.addEventListener('click', () => file.click());
    btnCreate.addEventListener('click', () => tryCreateTemplate());
    btnEnable.addEventListener('click', () => { STATE.enabled = true; logStatus('Templates enabled'); });
    btnDisable.addEventListener('click', () => { STATE.enabled = false; logStatus('Templates disabled'); });

    btnAllOn.addEventListener('click', () => setPaletteAll(true));
    btnAllOff.addEventListener('click', () => setPaletteAll(false));

    // Drag panel
    drag(panel, title);
  }

  function drag(container, handle) {
    let startX = 0, startY = 0, x = 0, y = 0, dragging = false, raf = 0;
    const onDown = (ev) => {
      dragging = true;
      const pt = ('touches' in ev) ? ev.touches[0] : ev;
      startX = pt.clientX - x; startY = pt.clientY - y;
      document.body.style.userSelect = 'none';
      ev.preventDefault();
      tick();
    };
    const onMove = (ev) => {
      if (!dragging) return;
      const pt = ('touches' in ev) ? ev.touches[0] : ev;
      x = pt.clientX - startX; y = pt.clientY - startY;
    };
    const onUp = () => {
      dragging = false;
      document.body.style.userSelect = '';
      cancelAnimationFrame(raf);
    };
    const tick = () => {
      if (!dragging) return;
      container.style.transform = `translate(${x}px, ${y}px)`;
      raf = requestAnimationFrame(tick);
    };
    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, { passive:false });
    window.addEventListener('mousemove', onMove, { passive:true });
    window.addEventListener('touchmove', onMove, { passive:true });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
    window.addEventListener('touchcancel', onUp);
  }

  function setPaletteAll(enabled) {
    const t = STATE.template;
    if (!t || !t.palette) return;
    for (const entry of t.palette.values()) entry.enabled = enabled;
    rebuildColorList();
    persistTemplate();
    logStatus(`${enabled ? 'Enabled' : 'Disabled'} all colors.`);
  }

  function rgbKey(r,g,b){ return `${r},${g},${b}`; }

  function rebuildColorList() {
    const wrap = STATE.ui.colors;
    wrap.innerHTML = '';
    const t = STATE.template;
    if (!t || !t.palette || t.palette.size === 0) {
      wrap.append(el('div', { className:'bm-muted', textContent:'No template colors to display.' }));
      return;
    }
    // Sort by count desc
    const arr = Array.from(t.palette.entries()).sort((a,b) => b[1].count - a[1].count);
    for (const [rgb, info] of arr) {
      const [r,g,b] = rgb.split(',').map(Number);
      const row = el('div', { className:'bm-color-row' });
      const cb = el('input', { type:'checkbox', checked: !!info.enabled });
      cb.addEventListener('change', () => {
        info.enabled = cb.checked;
        persistTemplate();
        logStatus(`${cb.checked ? 'Enabled' : 'Disabled'} ${rgb}`);
      });
      const sw = el('div', { className:'bm-swatch' });
      sw.style.background = `rgb(${r},${g},${b})`;
      const label = el('div', { textContent: `rgb(${r}, ${g}, ${b})`, style:'font-size:12px;' });
      const right = el('div', { className:'bm-right', textContent: info.count.toLocaleString() });
      row.append(cb, sw, label, right);
      wrap.append(row);
    }
  }

  // ───────────────────────── TEMPLATE BUILD ─────────────────────────
  function parseCoords() {
    const tlx = Number(STATE.ui.inTlX.value);
    const tly = Number(STATE.ui.inTlY.value);
    const pxx = Number(STATE.ui.inPxX.value);
    const pxy = Number(STATE.ui.inPxY.value);
    if ([tlx,tly,pxx,pxy].some(n => Number.isNaN(n))) return null;
    return [tlx, tly, pxx, pxy];
  }

  async function tryCreateTemplate() {
    const file = STATE.ui.file.files?.[0];
    if (!file) { logStatus('No file selected.'); return; }
    const coords = parseCoords();
    if (!coords) { logStatus('Coordinates are malformed (try clicking the canvas first).'); return; }
    try {
      const t = await buildTemplateFromImage(file, coords);
      STATE.template = t;
      persistTemplate();
      rebuildColorList();
      logStatus(`Template created at ${coords.join(', ')} with ${t.pixelCount.toLocaleString()} pixels.`);
      STATE.enabled = true;
    } catch (err) {
      console.error(err);
      logStatus('Failed to create template: ' + (err?.message || err));
    }
  }

  function persistTemplate() {
    const t = STATE.template;
    if (!t) return;
    const ser = {
      name: t.name,
      coords: t.coords,
      tiles: Array.from(t.tiles.keys()), // keys only; tiles are rebuilt each session
      palette: Array.from(t.palette.entries()).map(([k,v]) => [k, { count:v.count, enabled: !!v.enabled }])
    };
    gmSetValue('bmTemplateMeta', ser);
  }

  function restoreTemplatePalette(meta) {
    if (!meta || !meta.palette || !STATE.template) return;
    const map = new Map(meta.palette);
    for (const [rgb, v] of map.entries()) {
      const cur = STATE.template.palette.get(rgb);
      if (cur) cur.enabled = !!v.enabled;
    }
  }

  async function buildTemplateFromImage(file, coords) {
    const name = (file.name || 'template').replace(/\.[^.]+$/, '');
    const imgBitmap = await toBitmap(await file.arrayBuffer().then(b => new Blob([b])));
    const w = imgBitmap.width, h = imgBitmap.height;

    // The site tiles appear at 1000px blocks; each pixel is a 3x3 in image tiles.
    const TILE = 1000;           // source grid size
    const SCALE = 3;             // enlargement factor in fetched PNGs
    const PATCH = 1000;          // patching step at template coordinates
    const DRAW_W = SCALE * Math.min(PATCH, w);
    const DRAW_H = SCALE * Math.min(PATCH, h);
    const MAX_CHUNK = 1000;      // create chunks aligned to 1000s

    const tiles = new Map();     // key -> ImageBitmap chunk
    const prefixes = new Set();  // "tlx,tly" set
    const palette = new Map();   // "r,g,b" -> {count, enabled}

    const canvas = mkCanvas(DRAW_W, DRAW_H);
    const ctx = canvas.ctx;
    ctx.imageSmoothingEnabled = false;

    // loop over template pixel grid aligned to 1000-steps
    for (let y = coords[3]; y < h + coords[3]; ) {
      const blockH = Math.min(MAX_CHUNK - (y % MAX_CHUNK), (h - (y - coords[3])));
      for (let x = coords[2]; x < w + coords[2]; ) {
        const blockW = Math.min(MAX_CHUNK - (x % MAX_CHUNK), (w - (x - coords[2])));

        const drawW = SCALE * blockW;
        const drawH = SCALE * blockH;
        // resize work canvas if needed
        if (canvas.canvas.width !== drawW || canvas.canvas.height !== drawH) {
          if (canvas.offscreen) {
            canvas.canvas.width = drawW; canvas.canvas.height = drawH;
          } else {
            canvas.canvas.width = drawW; canvas.canvas.height = drawH;
          }
        }
        ctx.clearRect(0,0,drawW,drawH);
        // draw the template subsection scaled by 3x
        ctx.drawImage(imgBitmap, x - coords[2], y - coords[3], blockW, blockH, 0, 0, drawW, drawH);

        // Mask to only keep center-of-3 pixels and optional "transparent green" dim
        const img = ctx.getImageData(0,0,drawW,drawH);
        const data = img.data;
        for (let j=0; j<drawH; j++) {
          for (let i=0; i<drawW; i++) {
            const idx = 4*(j*drawW + i);
            const R = data[idx], G = data[idx+1], B = data[idx+2], A = data[idx+3];

            // If not center-of-3, make transparent
            if ((i % 3) !== 1 || (j % 3) !== 1) {
              data[idx+3] = 0;
              continue;
            }
            if (A < 64) { // transparent-ish in source
              data[idx+3] = 0;
              continue;
            }

            // collect palette (ignore "transparent green" that some templates use to mark empty)
            if (!(R === 222 && G === 250 && B === 206)) {
              const key = rgbKey(R,G,B);
              const e = palette.get(key) || { count: 0, enabled: true };
              e.count++;
              palette.set(key, e);
            } else {
              // dim checker for green if present
              if (((i+j)&1) === 0) { data[idx]=0; data[idx+1]=0; data[idx+2]=0; data[idx+3]=32; }
              else { data[idx+3]=0; }
            }
          }
        }
        ctx.putImageData(img,0,0);

        const key = `${(coords[0] + Math.floor(x/1000)).toString().padStart(4,'0')},${(coords[1] + Math.floor(y/1000)).toString().padStart(4,'0')},${(x%1000).toString().padStart(3,'0')},${(y%1000).toString().padStart(3,'0')}`;
        prefixes.add(key.split(',').slice(0,2).join(','));
        const bm = await toBitmap(canvas.canvas);
        tiles.set(key, bm);

        x += blockW;
      }
      y += blockH;
    }

    // pixel count is count of centers kept
    let pixelCount = 0;
    for (const v of palette.values()) pixelCount += v.count;

    return { name, coords, tiles, prefixes, palette, pixelCount };
  }

  // ───────────────────────── FETCH PATCH (TILE OVERLAY) ─────────────────────────
  // We alter fetched tile images by drawing template chunks on top (honoring color filter)
  function installFetchHook() {
    const orig = window.fetch;
    window.fetch = async function(...args) {
      const resp = await orig.apply(this, args);
      try {
        const url = (args[0] instanceof Request) ? args[0].url : String(args[0] || '');
        const ct = resp.headers.get('content-type') || '';
        if (!ct.includes('image/')) return resp;              // ignore non-images
        if (url.includes('openfreemap') || url.includes('maps')) return resp; // ignore map background
        if (!url.includes('/tiles/')) return resp;            // only patch Wplace canvas tiles

        // No template or disabled → return unchanged
        if (!STATE.enabled || !STATE.template || STATE.template.tiles.size === 0) return resp;

        const blob = await resp.clone().blob();
        const bm = await toBitmap(blob);

        // Determine tile indices from URL: .../tiles/{tlx}/{tly}.png
        const seg = url.split('?')[0].split('/').filter(Boolean);
        let tlx = NaN, tly = NaN;
        // find trailing numeric segments
        for (let i = seg.length-1; i>=1; i--) {
          if (seg[i].endsWith('.png')) {
            const num = seg[i].replace('.png','');
            if (!isNaN(+num)) { tly = +num; }
            if (!isNaN(+seg[i-1])) { tlx = +seg[i-1]; }
            break;
          }
        }
        if (Number.isNaN(tlx) || Number.isNaN(tly)) return resp;

        // quickly check if this tile prefix has any template chunks
        const prefix = `${tlx.toString().padStart(4,'0')},${tly.toString().padStart(4,'0')}`;
        let has = false;
        for (const p of STATE.template.prefixes.values()) { if (p === prefix) { has = true; break; } }
        if (!has) return resp;

        // Composite: base tile → overlay chunks for this tile
        const SIZE = 3000; // tile images are 3000x3000 (3x scale for 1000 grid)
        const c = mkCanvas(SIZE, SIZE);
        c.ctx.imageSmoothingEnabled = false;
        c.ctx.clearRect(0,0,SIZE,SIZE);
        c.ctx.drawImage(bm, 0, 0, SIZE, SIZE);

        // Gather chunks for this prefix
        const chunks = [];
        for (const [key, img] of STATE.template.tiles.entries()) {
          if (!key.startsWith(prefix)) continue;
          const parts = key.split(',');
          const offX = Number(parts[2]) * 3; // scaled by 3
          const offY = Number(parts[3]) * 3;
          chunks.push({ img, offX, offY });
        }

        const anyDisabled = Array.from(STATE.template.palette.values()).some(v => !v.enabled);
        if (!anyDisabled) {
          for (const ch of chunks) {
            c.ctx.drawImage(ch.img, ch.offX, ch.offY);
          }
        } else {
          // Per-chunk mask disabled colors
          for (const ch of chunks) {
            const w = ch.img.width, h = ch.img.height;
            const tmp = mkCanvas(w, h);
            tmp.ctx.imageSmoothingEnabled = false;
            tmp.ctx.clearRect(0,0,w,h);
            tmp.ctx.drawImage(ch.img, 0, 0);
            const img = tmp.ctx.getImageData(0,0,w,h);
            const data = img.data;
            for (let j=0; j<h; j++) {
              for (let i=0; i<w; i++) {
                const idx = 4*(j*w + i);
                const R = data[idx], G = data[idx+1], B = data[idx+2];
                const A = data[idx+3];
                if (A < 1) continue;
                const key = rgbKey(R,G,B);
                const info = STATE.template.palette.get(key);
                if (info && info.enabled === false) {
                  data[idx+3] = 0; // hide disabled
                }
              }
            }
            tmp.ctx.putImageData(img,0,0);
            c.ctx.drawImage(await toBitmap(tmp.canvas), ch.offX, ch.offY);
          }
        }

        const outBlob = await canvasToBlob(c.canvas, 'image/png');
        return new Response(outBlob, { headers: resp.headers, status: resp.status, statusText: resp.statusText });
      } catch (err) {
        console.warn('[BlueMarble] fetch hook error:', err);
        return resp;
      }
    };
  }

  // ───────────── capture clicks to auto-fill coords via /pixel requests ─────────────
  function installPixelSpy() {
    const orig = window.fetch;
    window.fetch = async function(...args) {
      const resp = await orig.apply(this, args);
      try {
        const url = (args[0] instanceof Request) ? args[0].url : String(args[0] || '');
        if (!url.includes('/pixel/')) return resp;
        const u = new URL(url, location.href);
        const path = u.pathname.split('/').filter(Boolean);
        // .../pixel/{tlx}/{tly}?x={pxx}&y={pxy}
        const tlx = Number(path[path.length-2]);
        const tly = Number(path[path.length-1]);
        const pxx = Number(u.searchParams.get('x'));
        const pxy = Number(u.searchParams.get('y'));
        if ([tlx,tly,pxx,pxy].every(n => !Number.isNaN(n))) {
          if (STATE.ui.inTlX) {
            STATE.ui.inTlX.value = String(tlx);
            STATE.ui.inTlY.value = String(tly);
            STATE.ui.inPxX.value = String(pxx);
            STATE.ui.inPxY.value = String(pxy);
            gmSetValue('bmCoords', { tlx, tly, pxx, pxy });
            logStatus(`Coords filled: Tl(${tlx},${tly}) Px(${pxx},${pxy})`);
          }
        }
      } catch {}
      return resp;
    };
  }

  // ───────────────────────── INIT ─────────────────────────
  function init() {
    buildPanel();
    installPixelSpy();   // re-wraps fetch (safe because we call original inside)
    installFetchHook();  // wraps the wrapped fetch; both cooperate

    // Try restore template meta (palette enable/disable)
    gmGetValue('bmTemplateMeta', null).then(meta => {
      if (!meta || !meta.coords) return;
      logStatus('Restored previous template metadata (colors). Upload the same image if you want to reuse.');
    });

    logStatus(`Loaded • ${gmInfo.script.name} v${gmInfo.script.version}`);
  }

  // Run ASAP
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
