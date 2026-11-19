/* Freisteller – Hintergrund entfernen und Signaturen erstellen.
   Alles läuft lokal im Browser, es werden keine Bilder hochgeladen.

   Aufbau:
   - ImageSource    : lädt das Bild und berechnet Helligkeitswerte
   - SignatureKeyer : macht helles Papier transparent (für Signaturen)
   - MagicWand      : entfernt Hintergrund per Flächenfüllung (für Fotos)
   - SignaturePad   : Zeichenfläche für Signaturen
   - Exporter       : Zuschneiden und Speichern als PNG
   - App            : verbindet Oberfläche und Klassen
*/
'use strict';

// Große Fotos werden auf diese Kantenlänge verkleinert (schneller, spart Speicher)
const MAX_SIDE = 1800;

/* ------------------------------------------------------------------ */
/* Bildquelle                                                          */
/* ------------------------------------------------------------------ */
class ImageSource {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.width = 0;
    this.height = 0;
    this.original = null;  // ImageData des Originals
    this.lum = null;       // Helligkeit pro Pixel (0-255)
    this.lumNorm = null;   // Helligkeit nach Beleuchtungsausgleich
  }

  get loaded() { return this.original !== null; }

  /** Lädt eine Bilddatei (EXIF-Drehung wird vom Browser berücksichtigt). */
  async load(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      this.width = Math.max(1, Math.round(img.naturalWidth * scale));
      this.height = Math.max(1, Math.round(img.naturalHeight * scale));
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      this.ctx.clearRect(0, 0, this.width, this.height);
      this.ctx.drawImage(img, 0, 0, this.width, this.height);
      this.original = this.ctx.getImageData(0, 0, this.width, this.height);
      this.computeLuminance();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Berechnet Helligkeit und eine "ausgeglichene" Variante:
      Pixelhelligkeit geteilt durch die lokale Durchschnittshelligkeit,
      so wird Papier überall ~weiß, auch bei Schatten. */
  computeLuminance() {
    const w = this.width, h = this.height, d = this.original.data;
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    }

    // Integralbild für schnellen Durchschnitt über ein Fenster
    const W = w + 1;
    const integ = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += lum[y * w + x];
        integ[(y + 1) * W + (x + 1)] = integ[y * W + (x + 1)] + row;
      }
    }

    const r = Math.max(8, Math.round(Math.max(w, h) / 16));
    const norm = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const sum = integ[y1 * W + x1] - integ[y0 * W + x1] - integ[y1 * W + x0] + integ[y0 * W + x0];
        const mean = sum / ((y1 - y0) * (x1 - x0));
        norm[y * w + x] = Math.min(255, (255 * lum[y * w + x]) / Math.max(mean, 1));
      }
    }
    this.lum = lum;
    this.lumNorm = norm;
  }
}

/* ------------------------------------------------------------------ */
/* Signatur-Modus: helles Papier -> transparent                        */
/* ------------------------------------------------------------------ */
class SignatureKeyer {
  /** opts: { threshold, softness, normalize, recolor (null oder {r,g,b}) } */
  static render(src, opts) {
    const w = src.width, h = src.height;
    const out = new ImageData(w, h);
    const o = out.data, d = src.original.data;
    const lumArr = opts.normalize ? src.lumNorm : src.lum;
    const lo = opts.threshold - opts.softness;
    const hi = opts.threshold + opts.softness;

    for (let i = 0; i < w * h; i++) {
      const l = lumArr[i];
      let a;
      if (l <= lo) a = 255;                 // dunkel = Tinte, voll sichtbar
      else if (l >= hi) a = 0;              // hell = Papier, transparent
      else a = (255 * (hi - l)) / (hi - lo); // weicher Übergang
      const p = i * 4;
      if (opts.recolor) {
        o[p] = opts.recolor.r; o[p + 1] = opts.recolor.g; o[p + 2] = opts.recolor.b;
      } else {
        o[p] = d[p]; o[p + 1] = d[p + 1]; o[p + 2] = d[p + 2];
      }
      o[p + 3] = Math.min(a, d[p + 3]);
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Foto-Modus: Hintergrund per Flächenfüllung entfernen                */
/* ------------------------------------------------------------------ */
class MagicWand {
  constructor(src) {
    this.src = src;
    this.mask = null;        // 255 = sichtbar, 0 = entfernt
    this.clickSeeds = [];    // vom Nutzer angetippte Punkte
    this.autoEdge = true;    // Ränder automatisch als Startpunkte nehmen
    this.reset();
  }

  /** Alle manuellen Punkte verwerfen. */
  reset() {
    this.clickSeeds = [];
    this.mask = null;
  }

  addSeed(x, y) { this.clickSeeds.push([x, y]); }
  undo() { this.clickSeeds.pop(); }

  /** Maske komplett neu berechnen (z. B. nach Änderung der Toleranz). */
  rebuild(tol) {
    const w = this.src.width, h = this.src.height;
    this.mask = new Uint8Array(w * h).fill(255);
    const seeds = [];
    if (this.autoEdge) {
      seeds.push([0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]);
    }
    seeds.push(...this.clickSeeds);
    for (const [x, y] of seeds) this.floodFrom(x, y, tol);
  }

  /** Füllt von (x,y) aus alle zusammenhängenden, farblich ähnlichen Pixel. */
  floodFrom(x, y, tol) {
    const w = this.src.width, h = this.src.height, n = w * h;
    const d = this.src.original.data;
    const start = y * w + x;
    if (this.mask[start] === 0) return;          // schon entfernt

    const sr = d[start * 4], sg = d[start * 4 + 1], sb = d[start * 4 + 2];
    const max2 = Math.pow(tol * 4.41, 2);         // 441 = größte RGB-Distanz
    const visited = new Uint8Array(n);
    const stack = new Int32Array(n);
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;

    while (sp > 0) {
      const p = stack[--sp];
      const i = p * 4;
      const dr = d[i] - sr, dg = d[i + 1] - sg, db = d[i + 2] - sb;
      if (dr * dr + dg * dg + db * db > max2) continue;
      this.mask[p] = 0;
      const px = p % w, py = (p / w) | 0;
      if (px > 0     && !visited[p - 1]) { visited[p - 1] = 1; stack[sp++] = p - 1; }
      if (px < w - 1 && !visited[p + 1]) { visited[p + 1] = 1; stack[sp++] = p + 1; }
      if (py > 0     && !visited[p - w]) { visited[p - w] = 1; stack[sp++] = p - w; }
      if (py < h - 1 && !visited[p + w]) { visited[p + w] = 1; stack[sp++] = p + w; }
    }
  }

  /** Erzeugt das Ergebnisbild; Randpixel werden leicht abgeschwächt (glattere Kante). */
  render() {
    const w = this.src.width, h = this.src.height;
    const out = new ImageData(new Uint8ClampedArray(this.src.original.data), w, h);
    const o = out.data, m = this.mask;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        let a = m[p];
        if (a === 255) {
          const edge = (x > 0 && m[p - 1] === 0) || (x < w - 1 && m[p + 1] === 0) ||
                       (y > 0 && m[p - w] === 0) || (y < h - 1 && m[p + w] === 0);
          if (edge) a = 140;
        }
        o[p * 4 + 3] = Math.min(a, o[p * 4 + 3]);
      }
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Zeichenfläche für Signaturen                                        */
/* ------------------------------------------------------------------ */
class SignaturePad {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.strokes = [];     // Liste aller Striche: { color, width, points }
    this.current = null;   // aktuell gezeichneter Strich
    this.color = '#000000';
    this.width = 8;
    this.bindEvents();
  }

  /** Mausposition/Fingerposition in Canvas-Koordinaten umrechnen. */
  toPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * this.canvas.width / r.width,
      y: (e.clientY - r.top) * this.canvas.height / r.height
    };
  }

  bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => {
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      this.current = { color: this.color, width: this.width, points: [this.toPoint(e)] };
      this.strokes.push(this.current);
      this.redraw();
    });
    c.addEventListener('pointermove', e => {
      if (!this.current) return;
      this.current.points.push(this.toPoint(e));
      this.redraw();
    });
    const end = () => { this.current = null; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  /** Zeichnet alle Striche neu (weich durch Kurvenglättung). */
  redraw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of this.strokes) this.drawStroke(s);
  }

  drawStroke(s) {
    const ctx = this.ctx, pts = s.points;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    if (pts.length === 1) {                       // einzelner Punkt
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, s.width / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  undo() { this.strokes.pop(); this.redraw(); }
  clear() { this.strokes = []; this.redraw(); }
  get isEmpty() { return this.strokes.length === 0; }
}

/* ------------------------------------------------------------------ */
/* Export: zuschneiden und speichern                                   */
/* ------------------------------------------------------------------ */
class Exporter {
  /** Schneidet das Canvas auf den sichtbaren Inhalt zu (mit etwas Rand). */
  static trim(canvas, padding = 12) {
    const w = canvas.width, h = canvas.height;
    const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return canvas;                  // nichts sichtbar
    minX = Math.max(0, minX - padding);
    minY = Math.max(0, minY - padding);
    maxX = Math.min(w - 1, maxX + padding);
    maxY = Math.min(h - 1, maxY + padding);
    const out = document.createElement('canvas');
    out.width = maxX - minX + 1;
    out.height = maxY - minY + 1;
    out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  /** Speichert als PNG: iPhone über das Teilen-Menü, sonst als Download. */
  static async save(canvas, filename, trim) {
    const source = trim ? Exporter.trim(canvas) : canvas;
    const blob = await new Promise(res => source.toBlob(res, 'image/png'));
    const file = new File([blob], filename, { type: 'image/png' });
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

/* ------------------------------------------------------------------ */
/* Anwendung                                                           */
/* ------------------------------------------------------------------ */
class App {
  constructor() {
    this.$ = id => document.getElementById(id);
    this.src = new ImageSource();
    this.wand = new MagicWand(this.src);
    this.pad = new SignaturePad(this.$('padCanvas'));
    this.out = this.$('outCanvas');
    this.mode = 'signatur';
    this.renderQueued = false;
    this.bindTabs();
    this.bindUpload();
    this.bindPad();
  }

  /* ---------- Reiter ---------- */
  bindTabs() {
    const show = upload => {
      this.$('panelUpload').classList.toggle('hidden', !upload);
      this.$('panelPad').classList.toggle('hidden', upload);
      this.$('tabUpload').classList.toggle('active', upload);
      this.$('tabPad').classList.toggle('active', !upload);
    };
    this.$('tabUpload').onclick = () => show(true);
    this.$('tabPad').onclick = () => show(false);
  }

  /* ---------- Bild-Bereich ---------- */
  bindUpload() {
    this.$('fileInput').addEventListener('change', e => this.onFile(e.target.files[0]));

    document.querySelectorAll('input[name=mode]').forEach(r =>
      r.addEventListener('change', () => {
        this.mode = r.value;
        this.$('ctlSig').classList.toggle('hidden', this.mode !== 'signatur');
        this.$('ctlWand').classList.toggle('hidden', this.mode !== 'wand');
        this.out.classList.toggle('wand', this.mode === 'wand');
        this.scheduleRender(true);
      }));

    // Alle Regler lösen ein Neuzeichnen aus
    ['thr', 'soft', 'norm', 'recolor', 'inkColor'].forEach(id =>
      this.$(id).addEventListener('input', () => this.scheduleRender(false)));
    this.$('tol').addEventListener('input', () => this.scheduleRender(true));
    this.$('autoEdge').addEventListener('change', () => {
      this.wand.autoEdge = this.$('autoEdge').checked;
      this.scheduleRender(true);
    });

    this.$('undoBtn').onclick = () => { this.wand.undo(); this.scheduleRender(true); };
    this.$('resetBtn').onclick = () => { this.wand.reset(); this.scheduleRender(true); };

    // Tippen auf das Bild = Hintergrundpunkt setzen (nur im Foto-Modus)
    this.out.addEventListener('pointerdown', e => {
      if (this.mode !== 'wand' || !this.src.loaded) return;
      const r = this.out.getBoundingClientRect();
      const x = Math.floor((e.clientX - r.left) * this.out.width / r.width);
      const y = Math.floor((e.clientY - r.top) * this.out.height / r.height);
      this.wand.addSeed(
        Math.min(this.out.width - 1, Math.max(0, x)),
        Math.min(this.out.height - 1, Math.max(0, y)));
      this.scheduleRender(true);
    });

    this.$('saveBtn').onclick = () =>
      Exporter.save(this.out, this.mode === 'signatur' ? 'signatur.png' : 'freisteller.png',
                    this.$('trim').checked);
  }

  async onFile(file) {
    if (!file) return;
    try {
      await this.src.load(file);
    } catch (err) {
      alert('Das Bild konnte nicht geladen werden (Format nicht unterstützt?).');
      return;
    }
    this.wand.reset();
    this.$('saveBtn').disabled = false;
    this.$('hint').textContent = this.src.width + ' × ' + this.src.height + ' px';
    this.scheduleRender(true);
  }

  /** Zeichnet höchstens einmal pro Frame neu. rebuildWand = Zauberstab-Maske neu berechnen. */
  scheduleRender(rebuildWand) {
    this.needRebuild = this.needRebuild || rebuildWand;
    if (this.renderQueued || !this.src.loaded) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render(this.needRebuild);
      this.needRebuild = false;
    });
  }

  render(rebuildWand) {
    const src = this.src;
    let img;
    if (this.mode === 'signatur') {
      const hex = this.$('inkColor').value;
      img = SignatureKeyer.render(src, {
        threshold: +this.$('thr').value,
        softness: +this.$('soft').value,
        normalize: this.$('norm').checked,
        recolor: this.$('recolor').checked ? App.hexToRgb(hex) : null
      });
    } else {
      if (rebuildWand || !this.wand.mask) this.wand.rebuild(+this.$('tol').value);
      img = this.wand.render();
    }
    this.out.width = src.width;
    this.out.height = src.height;
    this.out.getContext('2d').putImageData(img, 0, 0);
  }

  static hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  /* ---------- Zeichen-Bereich ---------- */
  bindPad() {
    this.$('penColor').addEventListener('input', e => { this.pad.color = e.target.value; });
    this.$('penWidth').addEventListener('input', e => { this.pad.width = +e.target.value; });
    this.$('padUndo').onclick = () => this.pad.undo();
    this.$('padClear').onclick = () => this.pad.clear();
    this.$('padSave').onclick = () => {
      if (this.pad.isEmpty) { alert('Bitte zuerst unterschreiben.'); return; }
      Exporter.save(this.$('padCanvas'), 'signatur.png', true);
    };
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new App();
  // Offline-Nutzung / "Zum Home-Bildschirm" (funktioniert über https, z. B. GitHub Pages)
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
});
