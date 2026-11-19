/* Signatur – Hintergrund entfernen und Signaturen erstellen.
   Alles läuft lokal im Browser, es werden keine Bilder hochgeladen.

   Aufbau:
   - ImageSource    : lädt Bild oder PDF-Seite in Originalauflösung
   - SignatureKeyer : macht helles Papier transparent (für Signaturen)
   - MagicWand      : entfernt Hintergrund per Flächenfüllung (für Fotos)
   - SignaturePad   : Zeichenfläche für Signaturen
   - PdfWriter      : erzeugt ein PDF mit dem Bild (Transparenz bleibt erhalten)
   - Exporter       : Zuschneiden und Speichern (PNG, JPG, WebP, PDF)
   - DropZone       : Drag & Drop, Einfügen per Strg/Cmd+V
   - App            : verbindet Oberfläche und Klassen

   Qualität: Das Bild wird NICHT verkleinert (nur wenn es mehr als MAX_PIXELS hat,
   weil Browser sonst abstürzen). Die Pixelfarben bleiben unverändert, nur die
   Transparenz wird berechnet. PNG und PDF speichern verlustfrei.
*/
'use strict';

// 12,5 Megapixel: reicht für ein iPhone-Foto (4032 × 3024) in voller Größe
const MAX_PIXELS = 12500000;

// PDF-Seiten werden mit dieser Vergrößerung gerendert (3 = ca. 216 dpi)
const PDF_SCALE = 3;

// pdf.js wird nur bei Bedarf geladen (beim ersten PDF)
const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Ausgabeformate
const FORMATS = {
  png:  { label: 'PNG',  mime: 'image/png',  hint: 'Verlustfrei, Hintergrund bleibt transparent.' },
  webp: { label: 'WebP', mime: 'image/webp', hint: 'Klein, mit Transparenz. Nicht jeder Browser kann WebP erzeugen (dann wird PNG gespeichert).' },
  jpg:  { label: 'JPG',  mime: 'image/jpeg', hint: 'Keine Transparenz: der Hintergrund wird mit der gewählten Farbe gefüllt.' },
  pdf:  { label: 'PDF',  mime: 'application/pdf', hint: 'Eine Seite in Bildgröße, verlustfrei, Transparenz bleibt erhalten.' }
};

/* ------------------------------------------------------------------ */
/* Bildquelle (Bild oder PDF-Seite)                                    */
/* ------------------------------------------------------------------ */
class ImageSource {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.width = 0;
    this.height = 0;
    this.original = null;   // ImageData des Originals
    this.lum = null;        // Helligkeit pro Pixel (0-255)
    this.lumNorm = null;    // Helligkeit nach Beleuchtungsausgleich
    this.pdf = null;        // geöffnetes PDF-Dokument (falls PDF)
    this.pageCount = 1;
    this.page = 1;
    this.shrunkFrom = null; // "Breite × Höhe" des Originals, falls verkleinert werden musste
  }

  get loaded() { return this.original !== null; }
  get isPdf() { return this.pdf !== null; }

  static isPdfFile(file) {
    return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  }

  /** Bilder und PDFs werden akzeptiert. */
  static isSupported(file) {
    return file.type.startsWith('image/') || ImageSource.isPdfFile(file);
  }

  /** Lädt eine Datei (Bild oder PDF). EXIF-Drehung berücksichtigt der Browser. */
  async load(file) {
    this.pdf = null;
    this.pageCount = 1;
    this.page = 1;
    this.shrunkFrom = null;
    if (ImageSource.isPdfFile(file)) {
      await this.openPdf(file);
      await this.showPage(1);
    } else {
      await this.loadImage(file);
    }
  }

  /* ---------- normale Bilddateien ---------- */
  async loadImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      // SVG ohne feste Größe: Standardgröße annehmen
      const nw = img.naturalWidth || 1600;
      const nh = img.naturalHeight || 1200;
      const [w, h] = this.fitSize(nw, nh);
      this.canvas.width = w;
      this.canvas.height = h;
      this.ctx.clearRect(0, 0, w, h);
      this.ctx.drawImage(img, 0, 0, w, h);
      if (w !== nw || h !== nh) this.shrunkFrom = nw + ' × ' + nh;
      this.finish();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Größe nur verkleinern, wenn sie MAX_PIXELS überschreitet. */
  fitSize(w, h) {
    if (w * h <= MAX_PIXELS) return [w, h];
    const f = Math.sqrt(MAX_PIXELS / (w * h));
    return [Math.max(1, Math.floor(w * f)), Math.max(1, Math.floor(h * f))];
  }

  /* ---------- PDF ---------- */
  /** Lädt pdf.js bei Bedarf nach. */
  static async ensurePdfJs() {
    if (window.pdfjsLib) return window.pdfjsLib;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PDFJS_URL;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Die PDF-Komponente konnte nicht geladen werden (Internetverbindung?).'));
      document.head.appendChild(s);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    return window.pdfjsLib;
  }

  async openPdf(file) {
    const lib = await ImageSource.ensurePdfJs();
    const data = new Uint8Array(await file.arrayBuffer());
    this.pdf = await lib.getDocument({ data }).promise;
    this.pageCount = this.pdf.numPages;
  }

  /** Rendert Seite n des PDFs in die Arbeitsfläche. */
  async showPage(n) {
    const page = await this.pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    // so groß wie möglich (bis PDF_SCALE), aber nicht über MAX_PIXELS
    const scale = Math.min(PDF_SCALE, Math.sqrt(MAX_PIXELS / (base.width * base.height)));
    const vp = page.getViewport({ scale });
    this.canvas.width = Math.ceil(vp.width);
    this.canvas.height = Math.ceil(vp.height);
    await page.render({ canvasContext: this.ctx, viewport: vp }).promise;
    this.page = n;
    this.finish();
  }

  /* ---------- gemeinsam ---------- */
  /** Liest die Pixel der Arbeitsfläche und berechnet die Helligkeitswerte. */
  finish() {
    this.width = this.canvas.width;
    this.height = this.canvas.height;
    this.original = this.ctx.getImageData(0, 0, this.width, this.height);
    this.computeLuminance();
  }

  /** Berechnet Helligkeit und eine "ausgeglichene" Variante:
      Pixelhelligkeit geteilt durch die lokale Durchschnittshelligkeit,
      so wird Papier überall ~weiß, auch bei Schatten.
      Der lokale Durchschnitt wird auf einem verkleinerten Raster berechnet
      (schnell, und für diesen Zweck genauso genau). */
  computeLuminance() {
    const w = this.width, h = this.height, d = this.original.data;
    const lum = new Uint8ClampedArray(w * h);
    for (let i = 0; i < w * h; i++) {
      lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    }

    // 1) Raster verkleinern (Blockmittelwerte)
    const step = Math.max(1, Math.round(Math.max(w, h) / 600));
    const sw = Math.ceil(w / step), sh = Math.ceil(h / step);
    const small = new Float32Array(sw * sh);
    for (let sy = 0; sy < sh; sy++) {
      const y0 = sy * step, y1 = Math.min(h, y0 + step);
      for (let sx = 0; sx < sw; sx++) {
        const x0 = sx * step, x1 = Math.min(w, x0 + step);
        let sum = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += lum[y * w + x];
        small[sy * sw + sx] = sum / ((y1 - y0) * (x1 - x0));
      }
    }

    // 2) Lokalen Durchschnitt mit Integralbild bilden
    const W = sw + 1;
    const integ = new Float64Array(W * (sh + 1));
    for (let y = 0; y < sh; y++) {
      let row = 0;
      for (let x = 0; x < sw; x++) {
        row += small[y * sw + x];
        integ[(y + 1) * W + (x + 1)] = integ[y * W + (x + 1)] + row;
      }
    }
    const r = Math.max(6, Math.round(Math.max(sw, sh) / 16));
    const mean = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(sh, y + r + 1);
      for (let x = 0; x < sw; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(sw, x + r + 1);
        const s = integ[y1 * W + x1] - integ[y0 * W + x1] - integ[y1 * W + x0] + integ[y0 * W + x0];
        mean[y * sw + x] = s / ((y1 - y0) * (x1 - x0));
      }
    }

    // 3) Durchschnitt weich (bilinear) auf volle Größe bringen und Helligkeit normieren
    const xa = new Int32Array(w), xb = new Int32Array(w), xf = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) / step - 0.5;
      const x0 = Math.floor(fx);
      xa[x] = Math.min(sw - 1, Math.max(0, x0));
      xb[x] = Math.min(sw - 1, Math.max(0, x0 + 1));
      xf[x] = fx - x0;
    }
    const norm = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      const fy = (y + 0.5) / step - 0.5;
      const y0 = Math.floor(fy), t = fy - y0;
      const ra = Math.min(sh - 1, Math.max(0, y0)) * sw;
      const rb = Math.min(sh - 1, Math.max(0, y0 + 1)) * sw;
      for (let x = 0; x < w; x++) {
        const s = xf[x];
        const top = mean[ra + xa[x]] * (1 - s) + mean[ra + xb[x]] * s;
        const bot = mean[rb + xa[x]] * (1 - s) + mean[rb + xb[x]] * s;
        const m = top * (1 - t) + bot * t;
        norm[y * w + x] = (255 * lum[y * w + x]) / Math.max(m, 1);   // Uint8Clamped begrenzt auf 255
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
  /** opts: { threshold, softness, normalize, recolor (null oder {r,g,b}) }
      out: optionaler, wiederverwendeter Puffer (spart Speicher) */
  static render(src, opts, out) {
    const w = src.width, h = src.height;
    const img = out || new ImageData(w, h);
    const o = img.data, d = src.original.data;
    const lumArr = opts.normalize ? src.lumNorm : src.lum;
    const lo = opts.threshold - opts.softness;
    const hi = opts.threshold + opts.softness;

    for (let i = 0; i < w * h; i++) {
      const l = lumArr[i];
      let a;
      if (l <= lo) a = 255;                  // dunkel = Tinte, voll sichtbar
      else if (l >= hi) a = 0;               // hell = Papier, transparent
      else a = (255 * (hi - l)) / (hi - lo); // weicher Übergang
      const p = i * 4;
      if (opts.recolor) {
        o[p] = opts.recolor.r; o[p + 1] = opts.recolor.g; o[p + 2] = opts.recolor.b;
      } else {
        o[p] = d[p]; o[p + 1] = d[p + 1]; o[p + 2] = d[p + 2];   // Originalfarben bleiben erhalten
      }
      o[p + 3] = Math.min(a, d[p + 3]);
    }
    return img;
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
    this.visited = null;     // Arbeitsspeicher, wird wiederverwendet
    this.stack = null;
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
    const w = this.src.width, h = this.src.height, n = w * h;
    this.mask = new Uint8Array(n).fill(255);
    if (!this.visited || this.visited.length !== n) {
      this.visited = new Uint8Array(n);
      this.stack = new Int32Array(n);
    }
    const seeds = [];
    if (this.autoEdge) {
      seeds.push([0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]);
    }
    seeds.push(...this.clickSeeds);
    for (const [x, y] of seeds) this.floodFrom(x, y, tol);
  }

  /** Füllt von (x,y) aus alle zusammenhängenden, farblich ähnlichen Pixel. */
  floodFrom(x, y, tol) {
    const w = this.src.width, h = this.src.height;
    const d = this.src.original.data;
    const start = y * w + x;
    if (this.mask[start] === 0) return;          // schon entfernt

    const sr = d[start * 4], sg = d[start * 4 + 1], sb = d[start * 4 + 2];
    const max2 = Math.pow(tol * 4.41, 2);         // 441 = größte RGB-Distanz
    const visited = this.visited, stack = this.stack;
    visited.fill(0);
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

  /** Erzeugt das Ergebnisbild; Randpixel werden leicht abgeschwächt (glattere Kante).
      out: optionaler, wiederverwendeter Puffer. */
  render(out) {
    const w = this.src.width, h = this.src.height;
    const img = out || new ImageData(w, h);
    const o = img.data, m = this.mask;
    o.set(this.src.original.data);                // Originalpixel unverändert übernehmen
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
    return img;
  }
}

/* ------------------------------------------------------------------ */
/* Zeichenfläche für Signaturen                                        */
/* ------------------------------------------------------------------ */
class SignaturePad {
  /** onChange: wird aufgerufen, sobald sich die Zeichnung ändert */
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange || (() => {});
    this.strokes = [];     // Liste aller Striche: { color, width, points }
    this.current = null;   // aktuell gezeichneter Strich
    this.color = '#000000';
    this.width = 16;
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
      this.onChange();
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

  undo() { this.strokes.pop(); this.redraw(); this.onChange(); }
  clear() { this.strokes = []; this.redraw(); this.onChange(); }
  get isEmpty() { return this.strokes.length === 0; }
}

/* ------------------------------------------------------------------ */
/* PDF-Erzeugung (ohne Zusatzbibliothek)                               */
/* ------------------------------------------------------------------ */
class PdfWriter {
  /** Packt Bytes mit zlib (das ist das "FlateDecode" des PDF-Formats). */
  static async deflate(bytes) {
    if (typeof CompressionStream === 'undefined') {
      throw new Error('PDF-Export wird von diesem Browser nicht unterstützt. Bitte ein anderes Format wählen.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Erzeugt ein einseitiges PDF mit dem Canvas-Inhalt (verlustfrei, Transparenz als Soft-Mask).
      dpi bestimmt nur die Seitengröße (Pixel -> Punkte), nicht die Bildqualität. */
  static async fromCanvas(canvas, dpi = 150) {
    const w = canvas.width, h = canvas.height;
    const px = canvas.getContext('2d').getImageData(0, 0, w, h).data;

    // RGB und Alpha trennen
    const rgb = new Uint8Array(w * h * 3);
    const alpha = new Uint8Array(w * h);
    let hasAlpha = false;
    for (let i = 0, j = 0, k = 0; i < w * h; i++, k += 4) {
      rgb[j++] = px[k]; rgb[j++] = px[k + 1]; rgb[j++] = px[k + 2];
      alpha[i] = px[k + 3];
      if (px[k + 3] !== 255) hasAlpha = true;
    }
    const rgbZ = await PdfWriter.deflate(rgb);
    const alphaZ = hasAlpha ? await PdfWriter.deflate(alpha) : null;

    const pw = (w * 72 / dpi).toFixed(2), ph = (h * 72 / dpi).toFixed(2);
    const enc = new TextEncoder();
    const parts = [];
    const offsets = [];
    let offset = 0;
    const push = d => { const b = typeof d === 'string' ? enc.encode(d) : d; parts.push(b); offset += b.length; };
    const obj = (n, body) => { offsets[n] = offset; push(n + ' 0 obj\n' + body + '\nendobj\n'); };
    const streamObj = (n, dict, data) => {
      offsets[n] = offset;
      push(n + ' 0 obj\n<< ' + dict + ' /Length ' + data.length + ' >>\nstream\n');
      push(data);
      push('\nendstream\nendobj\n');
    };

    push('%PDF-1.4\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' + ph + '] /Contents 4 0 R ' +
           '/Resources << /XObject << /Im0 5 0 R >> >> >>');
    streamObj(4, '', enc.encode('q ' + pw + ' 0 0 ' + ph + ' 0 0 cm /Im0 Do Q'));
    streamObj(5, '/Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h +
                 ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode' +
                 (alphaZ ? ' /SMask 6 0 R' : ''), rgbZ);
    if (alphaZ) {
      streamObj(6, '/Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h +
                   ' /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode', alphaZ);
    }

    // Verweistabelle (jeder Eintrag ist genau 20 Zeichen lang)
    const count = offsets.length;
    const xref = offset;
    push('xref\n0 ' + count + '\n0000000000 65535 f \n');
    for (let i = 1; i < count; i++) push(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
    push('trailer\n<< /Size ' + count + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    return new Blob(parts, { type: 'application/pdf' });
  }
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

  /** Erzeugt die Ausgabedatei. opts: { trim, format, quality (0-1), bg (Hex-Farbe) }
      Liefert { blob, ext }. */
  static async makeBlob(canvas, opts) {
    const src = opts.trim ? Exporter.trim(canvas) : canvas;
    if (opts.format === 'pdf') {
      return { blob: await PdfWriter.fromCanvas(src), ext: 'pdf' };
    }
    let target = src;
    if (opts.format === 'jpg') {                  // JPG kennt keine Transparenz: Hintergrund füllen
      target = document.createElement('canvas');
      target.width = src.width;
      target.height = src.height;
      const ctx = target.getContext('2d');
      ctx.fillStyle = opts.bg;
      ctx.fillRect(0, 0, target.width, target.height);
      ctx.drawImage(src, 0, 0);
    }
    const mime = FORMATS[opts.format].mime;
    const blob = await new Promise(res => target.toBlob(res, mime, opts.quality));
    // Manche Browser (z. B. Safari bei WebP) liefern stattdessen PNG
    const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
    return { blob, ext };
  }

  /** Speichert: iPhone über das Teilen-Menü, sonst als Download.
      Liefert die tatsächlich verwendete Endung. */
  static async save(canvas, basename, opts) {
    const { blob, ext } = await Exporter.makeBlob(canvas, opts);
    const filename = basename + '.' + ext;
    const file = new File([blob], filename, { type: blob.type });
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return ext; }
      catch (e) { if (e.name === 'AbortError') return ext; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return ext;
  }
}

/* ------------------------------------------------------------------ */
/* Drag-and-drop-Feld (auch Einfügen per Strg/Cmd+V)                   */
/* ------------------------------------------------------------------ */
class DropZone {
  /** zone: Element des Feldes, onFile: Funktion, die eine Datei bekommt */
  constructor(zone, onFile) {
    this.zone = zone;
    this.onFile = onFile;
    this.bindEvents();
  }

  /** Nimmt nur Bilder und PDFs an. */
  static firstSupported(files) {
    return Array.from(files || []).find(f => ImageSource.isSupported(f)) || null;
  }

  bindEvents() {
    const z = this.zone;
    ['dragenter', 'dragover'].forEach(ev =>
      z.addEventListener(ev, e => { e.preventDefault(); z.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev =>
      z.addEventListener(ev, e => { e.preventDefault(); z.classList.remove('over'); }));
    z.addEventListener('drop', e => {
      const f = DropZone.firstSupported(e.dataTransfer.files);
      if (f) this.onFile(f);
    });

    // Verhindert, dass der Browser eine daneben fallengelassene Datei öffnet
    ['dragover', 'drop'].forEach(ev => window.addEventListener(ev, e => e.preventDefault()));

    // Bild aus der Zwischenablage einfügen
    window.addEventListener('paste', e => {
      const f = DropZone.firstSupported(e.clipboardData && e.clipboardData.files);
      if (f) this.onFile(f);
    });
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
    this.pad = new SignaturePad(this.$('padCanvas'), () => this.updateSaveState());
    this.out = this.$('outCanvas');
    this.mode = 'signatur';
    this.tab = 'upload';
    this.baseName = '';
    this.buffer = null;          // wiederverwendeter Ergebnis-Puffer
    this.renderQueued = false;
    this.needRebuild = false;
    this.bindTabs();
    this.bindUpload();
    this.bindPdfPages();
    this.bindPad();
    this.bindExport();
    // Drag-and-drop: wechselt bei Bedarf zum Reiter "Bild freistellen"
    this.dropZone = new DropZone(this.$('dropZone'), file => {
      this.$('tabUpload').click();
      this.onFile(file);
    });
  }

  /* ---------- Reiter ---------- */
  bindTabs() {
    const show = upload => {
      this.tab = upload ? 'upload' : 'pad';
      this.$('panelUpload').classList.toggle('hidden', !upload);
      this.$('panelPad').classList.toggle('hidden', upload);
      this.$('tabUpload').classList.toggle('active', upload);
      this.$('tabPad').classList.toggle('active', !upload);
      this.updateSaveState();
    };
    this.$('tabUpload').onclick = () => show(true);
    this.$('tabPad').onclick = () => show(false);
  }

  /* ---------- Bild-Bereich ---------- */
  bindUpload() {
    this.$('fileInput').addEventListener('change', e => {
      this.onFile(e.target.files[0]);
      e.target.value = '';     // gleiche Datei darf erneut gewählt werden
    });

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
  }

  /** Lädt eine Datei (Bild oder PDF) und zeigt das Ergebnis an. */
  async onFile(file) {
    if (!file) return;
    if (!ImageSource.isSupported(file)) {
      alert('Dieses Dateiformat wird nicht unterstützt. Erlaubt sind Bilder und PDF.');
      return;
    }
    this.$('hint').textContent = 'Wird geladen …';
    try {
      await this.src.load(file);
    } catch (err) {
      this.$('hint').textContent = 'Noch kein Bild gewählt.';
      alert(ImageSource.isPdfFile(file)
        ? (err.message || 'Die PDF-Datei konnte nicht gelesen werden.')
        : 'Das Bild konnte nicht geladen werden (Format wird vom Browser nicht unterstützt?).');
      return;
    }
    this.baseName = file.name.replace(/\.[^.]+$/, '') || 'bild';
    this.wand.reset();
    this.$('dropZone').classList.add('compact');   // Feld wird nach dem Laden kleiner
    this.updatePageRow();
    this.updateInfo();
    this.updateSaveState();
    this.scheduleRender(true);
  }

  /** Zeigt Größe (und Hinweis, falls verkleinert werden musste). */
  updateInfo() {
    const s = this.src;
    let t = s.width + ' × ' + s.height + ' px';
    t += s.shrunkFrom ? ' (verkleinert von ' + s.shrunkFrom + ', Browser-Grenze)' : ' (Originalauflösung)';
    this.$('hint').textContent = t;
  }

  /* ---------- PDF-Seitenwahl ---------- */
  bindPdfPages() {
    const go = async delta => {
      const n = this.src.page + delta;
      if (!this.src.isPdf || n < 1 || n > this.src.pageCount) return;
      this.$('hint').textContent = 'Seite wird geladen …';
      try {
        await this.src.showPage(n);
      } catch (err) {
        alert('Die Seite konnte nicht dargestellt werden.');
        return;
      }
      this.wand.reset();
      this.updatePageRow();
      this.updateInfo();
      this.scheduleRender(true);
    };
    this.$('pagePrev').onclick = () => go(-1);
    this.$('pageNext').onclick = () => go(1);
  }

  /** Seitenzeile nur bei mehrseitigen PDFs einblenden. */
  updatePageRow() {
    const s = this.src;
    this.$('pageRow').classList.toggle('hidden', !(s.isPdf && s.pageCount > 1));
    this.$('pageLabel').textContent = 'Seite ' + s.page + ' / ' + s.pageCount;
    this.$('pagePrev').disabled = s.page <= 1;
    this.$('pageNext').disabled = s.page >= s.pageCount;
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
    // Puffer nur neu anlegen, wenn sich die Größe ändert
    if (!this.buffer || this.buffer.width !== src.width || this.buffer.height !== src.height) {
      this.buffer = new ImageData(src.width, src.height);
    }
    let img;
    if (this.mode === 'signatur') {
      const hex = this.$('inkColor').value;
      img = SignatureKeyer.render(src, {
        threshold: +this.$('thr').value,
        softness: +this.$('soft').value,
        normalize: this.$('norm').checked,
        recolor: this.$('recolor').checked ? App.hexToRgb(hex) : null
      }, this.buffer);
    } else {
      if (rebuildWand || !this.wand.mask) this.wand.rebuild(+this.$('tol').value);
      img = this.wand.render(this.buffer);
    }
    if (this.out.width !== src.width) this.out.width = src.width;
    if (this.out.height !== src.height) this.out.height = src.height;
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
  }

  /* ---------- Ausgabe ---------- */
  bindExport() {
    document.querySelectorAll('input[name=fmt]').forEach(r =>
      r.addEventListener('change', () => this.updateFormatUi()));
    this.$('quality').addEventListener('input', () => this.updateFormatUi());
    this.$('saveBtn').onclick = () => this.onSave();
    this.updateFormatUi();
    this.updateSaveState();
  }

  get format() { return document.querySelector('input[name=fmt]:checked').value; }

  /** Blendet je nach Format Qualität bzw. Hintergrundfarbe ein. */
  updateFormatUi() {
    const f = this.format;
    this.$('fmtHint').textContent = FORMATS[f].hint;
    this.$('rowQuality').classList.toggle('hidden', !(f === 'jpg' || f === 'webp'));
    this.$('rowBg').classList.toggle('hidden', f !== 'jpg');
    this.$('qualityVal').textContent = this.$('quality').value + ' %';
    this.$('saveBtn').textContent = 'Als ' + FORMATS[f].label + ' speichern';
  }

  /** Speichern ist nur möglich, wenn im aktuellen Reiter etwas vorhanden ist. */
  updateSaveState() {
    const ready = this.tab === 'upload' ? this.src.loaded : !this.pad.isEmpty;
    this.$('saveBtn').disabled = !ready;
  }

  async onSave() {
    const upload = this.tab === 'upload';
    const canvas = upload ? this.out : this.$('padCanvas');
    const name = upload
      ? this.baseName + (this.mode === 'signatur' ? '-signatur' : '-freigestellt')
      : 'signatur';
    const btn = this.$('saveBtn');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Wird erstellt …';
    try {
      const ext = await Exporter.save(canvas, name, {
        trim: this.$('trim').checked,
        format: this.format,
        quality: +this.$('quality').value / 100,
        bg: this.$('bgColor').value
      });
      if (this.format !== 'pdf' && ext !== (this.format === 'jpg' ? 'jpg' : this.format)) {
        alert('Dieser Browser kann ' + FORMATS[this.format].label + ' nicht erzeugen. Gespeichert wurde stattdessen als ' + ext.toUpperCase() + '.');
      }
    } catch (err) {
      alert(err.message || 'Speichern fehlgeschlagen.');
    } finally {
      btn.textContent = label;
      this.updateSaveState();
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new App();
  // Offline-Nutzung / "Zum Home-Bildschirm" (funktioniert über https, z. B. GitHub Pages)
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
});
