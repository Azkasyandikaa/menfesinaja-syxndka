import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import emojiRegex from 'emoji-regex';

/**
 * QUOTE IMAGE GENERATOR — "chat iPhone / WhatsApp quote card"
 * ─────────────────────────────────────────────────────────────
 * Merender teks user menjadi FOTO screenshot chat WhatsApp tema DARK:
 * - TANPA header — nama kontak, ikon video/call, status bar & bar hijau di
 *   belakangnya semua DIHAPUS (permintaan user)
 * - Bubble chat HITAM dengan jam, MUNCUL DARI KIRI (gaya chat diterima)
 * - Nama pengirim berwarna di dalam bubble (gaya grup WA)
 * - Ukuran & lebar bubble MENYESUAIKAN panjang teks (word wrap adaptif)
 * - assets/background.jpeg = latar penuh kanvas (gelap), assets/emot.jpeg =
 *   hiasan DI ATAS chat, assets/pop.jpeg = hiasan DI BAWAH chat. Background
 *   dekor dibuang otomatis — mode GELAP (kartu hitam/doodle) maupun TERANG
 *   (foto blur) dideteksi dari luminance tepi gambar, flood-fill dari tepi
 *   (HANYA background luar yang dibuang — isi kartu/item dibiarkan utuh),
 *   feather anti-jagged, lalu di-crop ke konten dan dibesarkan hampir
 *   selebar kanvas. Fallback warna gelap jika file kosong/korup.
 * - Emoji WA dirender via twemoji (cache in-memory)
 *
 * Hasil: JPEG 1080×1920 (potrait 9:16, ukuran story).
 */

const CANVAS_W = 1080;
const CANVAS_H = 1920;   // potrait 9:16 (ukuran story)

// ── Geometri bubble ──
const BUBBLE_MAX_W = 960;      // lebar maks bubble (px) — hampir selebar kanvas
const BUBBLE_MIN_W = 700;      // lebar minimum bubble (px) — bubble selalu tampil besar
const BUBBLE_PAD_X = 30;       // padding teks kiri/kanan dalam bubble
const BUBBLE_PAD_Y = 18;       // padding teks atas/bawah dalam bubble
const META_H = 30;             // tinggi baris jam + centang
const NAME_H = 34;             // tinggi baris nama pengirim
const BUBBLE_R = 18;           // radius sudut bubble
const MAX_LINES = 16;          // batas baris (kelebihan dipangkas + "...")

// ── Warna tema gelap ──
const COLOR_OUT_BUBBLE = '#0b0f14';   // bubble chat HITAM
const COLOR_TEXT = '#ffffff';
const COLOR_META = '#94a3ab';
const COLOR_WALLPAPER_FALLBACK = '#0b141a'; // wallpaper WA dark
const NAME_COLORS = ['#e542a3', '#02a698', '#a18cff', '#7f66ff', '#e79b00', '#0a7cff', '#df2f7f', '#53a6fd'];

const FONT_STACK = 'Segoe UI, Helvetica, Arial, Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif';

const ASSETS_DIR = path.resolve('assets');
const WALLPAPER_EXTS = ['.jpeg', '.jpg', '.png', '.webp'];

// ── Gambar dekoratif dari assets/ (rasio asli dipertahankan) ──
const EMOT_W = 880;      // lebar dekor emot di ATAS chat
const POP_W = 860;       // lebar dekor pop di BAWAH chat
const DECOR_GAP = 40;     // jarak gambar dekor <-> bubble
const EDGE_PAD = 56;      // jarak minimal isi dari tepi atas/bawah kanvas
const BG_LUM_MAX = 30;   // luminance < ini dianggap background hitam yang dibuang
const KEY_LUM_LO = 10;   // keying emot: lum <= ini transparan penuh
const KEY_LUM_HI = 70;   // keying emot: lum >= ini opak penuh (gradien di antaranya)
const DARK_BG_MAX = 30;  // rata-rata tepi gambar < ini = background gelap (mode lama)
const LIGHT_BG_MIN = 36; // mode bg terang/blur: ambang minimum threshold background
const LIGHT_KEY_LO = 26; // mode bg terang: tepi kartu lum <= ini opak penuh
const LIGHT_BG_TOL = 40; // threshold bg terang = luminance tepi - toleransi ini
const LIGHT_BG_CAP = 0.92; // mode terang: bg wajar <= 92% (screenshot putih polos ~76%)
const FEATHER_PX = 2;    // lebar gradasi alpha di tepi konten (anti jagged)
const DECOR_R = 26;       // radius sudut gambar dekor
const BUBBLE_MARGIN = 60; // jarak bubble dari tepi kiri/kanan

// ─────────────────────────────────────────────────────────
// Util teks (estimasi lebar, wrap, escape, emoji)
// ─────────────────────────────────────────────────────────

/** Escape karakter XML agar teks aman dirender di dalam SVG. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Perkiraan lebar string (px) pada `fontSize`. Untuk wrap & lebar bubble. */
function estWidth(str: string, fontSize: number): number {
  let units = 0;
  for (const ch of str) {
    if ("ijl.,:;'|!".includes(ch)) units += 0.32;
    else if ("ftr()[]{}/- ".includes(ch)) units += 0.4;
    else if ("mwMW@".includes(ch)) units += 0.9;
    else if (ch >= 'A' && ch <= 'Z') units += 0.68;
    else if (ch >= '0' && ch <= '9') units += 0.58;
    else units += 0.54;
  }
  return units * fontSize;
}

// ── Emoji: render via twemoji (pola sama dengan sticker.service) ──

const EMOJI_RE = emojiRegex();
const emojiDataUriCache = new Map<string, string>();

function emojiToCodePoints(emoji: string): string {
  const cps: string[] = [];
  for (const ch of emoji) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfe0f) continue;
    cps.push(cp.toString(16));
  }
  return cps.join('-');
}

async function fetchEmojiDataUri(emoji: string): Promise<string> {
  const cached = emojiDataUriCache.get(emoji);
  if (cached !== undefined) return cached;
  const url = `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/${emojiToCodePoints(emoji)}.svg`;
  try {
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000 });
    const dataUri = `data:image/svg+xml;base64,${Buffer.from(resp.data).toString('base64')}`;
    emojiDataUriCache.set(emoji, dataUri);
    return dataUri;
  } catch {
    emojiDataUriCache.set(emoji, '');
    return '';
  }
}

async function prefetchEmojis(text: string): Promise<void> {
  const emojis = new Set<string>();
  let m: RegExpExecArray | null;
  EMOJI_RE.lastIndex = 0;
  while ((m = EMOJI_RE.exec(text)) !== null) emojis.add(m[0]);
  await Promise.all([...emojis].map((e) => fetchEmojiDataUri(e)));
}

interface TextToken { type: 'text'; value: string }
interface EmojiToken { type: 'emoji'; value: string; dataUri: string; w: number }
type Token = TextToken | EmojiToken;

/** Pecah string jadi token teks + emoji (emoji yang gagal fetch dirender sbg teks). */
function tokenize(line: string, fontSize: number): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  EMOJI_RE.lastIndex = 0;
  while ((m = EMOJI_RE.exec(line)) !== null) {
    if (m.index > last) tokens.push({ type: 'text', value: line.slice(last, m.index) });
    tokens.push({
      type: 'emoji',
      value: m[0],
      dataUri: emojiDataUriCache.get(m[0]) || '',
      w: Math.round(fontSize * Math.min([...m[0].replace(/\ufe0f/g, '')].length, 2) * 0.95),
    });
    last = m.index + m[0].length;
  }
  if (last < line.length) tokens.push({ type: 'text', value: line.slice(last) });
  return tokens.length > 0 ? tokens : [{ type: 'text', value: line }];
}

/** Lebar total satu baris ter-token (termasuk emoji). */
function lineWidth(tokens: Token[], fontSize: number): number {
  let w = 0;
  for (const t of tokens) {
    w += t.type === 'emoji' ? t.w : estWidth(t.value, fontSize);
  }
  return w;
}

/**
 * Word wrap: pecah teks jadi baris yang muat di maxWidth.
 * Kata lebih lebar dari maxWidth dipecah per karakter (biar tidak overflow).
 * Pertahankan baris kosong (paragraph break via \n\n).
 */
function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
  const result: string[] = [];
  const paragraphs = text.replace(/\r/g, '').split('\n');
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      result.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      // Kata super panjang (tanpa spasi) -> pecah paksa per karakter
      let piece = word;
      while (estWidth(piece, fontSize) > maxWidth && piece.length > 1) {
        // Geser sebanyak mungkin karakter ke baris sekarang
        let cut = piece.length;
        while (cut > 1 && estWidth((current ? current + ' ' : '') + piece.slice(0, cut), fontSize) > maxWidth) cut--;
        const head = piece.slice(0, Math.max(1, cut));
        if (current) {
          result.push(current);
          current = '';
        }
        result.push(head);
        piece = piece.slice(Math.max(1, cut));
      }
      const candidate = current ? `${current} ${piece}` : piece;
      if (estWidth(candidate, fontSize) <= maxWidth) {
        current = candidate;
      } else {
        if (current) result.push(current);
        current = piece;
      }
    }
    if (current) result.push(current);
  }
  return result;
}

// ─────────────────────────────────────────────────────────
// Wallpaper
// ─────────────────────────────────────────────────────────

function resolveAssetPath(base: string): string | undefined {
  for (const ext of WALLPAPER_EXTS) {
    const p = path.join(ASSETS_DIR, `${base}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/** Latar penuh kanvas dari assets/background.jpeg (fallback: WA klasik). */
async function loadBackground(width: number, height: number): Promise<Buffer> {
  const file = resolveAssetPath('background');
  if (file) {
    try {
      return await sharp(file).resize(width, height, { fit: 'cover', position: 'centre' }).jpeg().toBuffer();
    } catch {
      /* file korup -> fallback warna */
    }
  }
  // Fallback: wallpaper WA dark (gelap + pola lingkaran lembut)
  const circles: string[] = [];
  for (let i = 0; i < 14; i++) {
    const cx = ((i * 397) % width);
    const cy = ((i * 613) % height);
    const r = 60 + ((i * 53) % 90);
    circles.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#ffffff" opacity="0.05"/>`);
  }
  const svg =
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${width}" height="${height}" fill="${COLOR_WALLPAPER_FALLBACK}"/>${circles.join('')}</svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

/** Luminance (0-255) piksel RGBA pada indeks buffer `i`. */
function pxLum(data: Buffer, i: number): number {
  return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
}

/**
 * Buang background gambar dekor (pop/emot) — mode otomatis dari luminance tepi:
 * - BG GELAP (pop kartu / emot doodle lama): flood-fill dari tepi membuang
 *   piksel gelap terhubung tepi; emot bisa pakai keying gradien (smoothKey)
 *   supaya doodle mengambang mulus.
 * - BG TERANG/BLUR (emot kartu di atas foto blur): flood-fill dari tepi
 *   membuang piksel TERANG terhubung tepi, lalu tepi kartu di-feather dengan
 *   gradasi alpha (anti jagged) — kartu gelap & emoji di dalamnya aman.
 * Output: PNG RGBA transparan + ter-crop ke konten.
 */
async function extractContent(file: string, smoothKey: boolean): Promise<Buffer | undefined> {
  try {
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const w = info.width;
    const h = info.height;
    const ch = info.channels;

    // Deteksi mode: rata-rata luminance tepi gambar
    let borderSum = 0;
    let borderN = 0;
    const sampleBorder = (x: number, y: number): void => {
      borderSum += pxLum(data, (y * w + x) * ch);
      borderN++;
    };
    for (let x = 0; x < w; x += 3) {
      sampleBorder(x, 0);
      sampleBorder(x, h - 1);
    }
    for (let y = 0; y < h; y += 3) {
      sampleBorder(0, y);
      sampleBorder(w - 1, y);
    }
    const borderAvg = borderSum / Math.max(1, borderN);
    const lightBg = borderAvg >= DARK_BG_MAX;
    // Threshold bg mode terang MENDEKATI luminance tepi gambar (bg putih polos
    // 255 -> 215), bukan konstan 36. Dengan begitu hanya latar yang dibuang;
    // isi kartu/pill gelap & emoji di dalamnya aman dari flood-fill.
    const bgHi = Math.max(LIGHT_BG_MIN, Math.round(borderAvg - LIGHT_BG_TOL));

    // Flood-fill dari tepi: tandai semua piksel background yang terhubung ke tepi
    const isBg = new Uint8Array(w * h);
    const stack: number[] = [];
    const isBgPixel = (p: number): boolean => {
      const lum = pxLum(data, p * ch);
      return lightBg ? lum >= bgHi : lum < BG_LUM_MAX;
    };
    const visit = (x: number, y: number): void => {
      const p = y * w + x;
      if (!isBg[p] && isBgPixel(p)) {
        isBg[p] = 1;
        stack.push(p);
      }
    };
    for (let x = 0; x < w; x++) {
      visit(x, 0);
      visit(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      visit(0, y);
      visit(w - 1, y);
    }
    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0) visit(x - 1, y);
      if (x < w - 1) visit(x + 1, y);
      if (y > 0) visit(x, y - 1);
      if (y < h - 1) visit(x, y + 1);
    }

    if (lightBg) {
      // Pengaman anti bocor: area background wajar <= 92% gambar. Screenshot
      // dengan latar putih polos (emot doodle/pill) wajig ~76% putih — cap 70%
      // lama menolaknya sehingga dekor tidak tampil sama sekali.
      let bgCount = 0;
      for (let p = 0; p < w * h; p++) if (isBg[p]) bgCount++;
      if (bgCount > w * h * LIGHT_BG_CAP) return undefined;
    }

    // Ring feather: piksel yang berdekatan dengan background (FEATHER_PX kali)
    const ring = new Uint8Array(w * h);
    if (lightBg) {
      for (let pass = 0; pass < FEATHER_PX; pass++) {
        const additions: number[] = [];
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const p = y * w + x;
            if (isBg[p] || ring[p]) continue;
            const near =
              (x > 0 && (isBg[p - 1] || ring[p - 1])) ||
              (x < w - 1 && (isBg[p + 1] || ring[p + 1])) ||
              (y > 0 && (isBg[p - w] || ring[p - w])) ||
              (y < h - 1 && (isBg[p + w] || ring[p + w]));
            if (near) additions.push(p);
          }
        }
        for (const p of additions) ring[p] = 1;
      }
    }

    // Terapkan alpha + hitung bbox konten
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        let a = 255;
        if (isBg[p]) {
          a = 0; // background terhubung tepi -> transparan
        } else if (lightBg && ring[p]) {
          // Feather tepi kartu: gradasi alpha dari ambang bg (bgHi) ke solid
          // (LIGHT_KEY_LO) — mengikuti luminance tepi sehingga antialias
          // screenshot putih ikut memudar mulus.
          const lum = pxLum(data, p * ch);
          if (lum >= bgHi) a = 0;
          else if (lum > LIGHT_KEY_LO) {
            a = Math.round((255 * (bgHi - lum)) / (bgHi - LIGHT_KEY_LO));
          }
        } else if (!lightBg && smoothKey) {
          // Keying mulus (bg gelap): gelap = transparan, terang = opak
          const lum = pxLum(data, p * ch);
          if (lum <= KEY_LUM_LO) a = 0;
          else if (lum < KEY_LUM_HI) {
            a = Math.round(((lum - KEY_LUM_LO) / (KEY_LUM_HI - KEY_LUM_LO)) * 255);
          }
        }
        data[p * ch + 3] = a;
        if (a > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return undefined; // seluruh gambar = background

    // Margin kecil di mode bg terang agar feather tidak terpotong mentah
    const margin = lightBg ? FEATHER_PX : 0;
    const left = Math.max(0, minX - margin);
    const top = Math.max(0, minY - margin);
    const width = Math.min(w - left, maxX - minX + 1 + margin * 2);
    const height = Math.min(h - top, maxY - minY + 1 + margin * 2);

    return await sharp(data, { raw: { width: w, height: h, channels: 4 } })
      .extract({ left, top, width, height })
      .png()
      .toBuffer();
  } catch {
    return undefined; // gagal proses -> dekor dilewati
  }
}

/**
 * Muat dekor (pop/emot): background hitamnya dibuang, di-crop ke konten, lalu
 * di-resize ke `targetW`. `smoothKey=true` (emot): keying gradien mulus.
 * Mengembalikan data-URI PNG + dimensi.
 */
async function loadDecor(
  base: string,
  targetW: number,
  smoothKey = false
): Promise<{ uri: string; w: number; h: number } | undefined> {
  const file = resolveAssetPath(base);
  if (!file) return undefined;
  const content = await extractContent(file, smoothKey);
  if (!content) return undefined;
  try {
    const out = await sharp(content)
      .resize({ width: targetW })
      .png()
      .toBuffer({ resolveWithObject: true });
    return {
      uri: `data:image/png;base64,${out.data.toString('base64')}`,
      w: out.info.width,
      h: out.info.height,
    };
  } catch {
    return undefined; // gagal resize -> dekor dilewati
  }
}

// ─────────────────────────────────────────────────────────
// Layout bubble
// ─────────────────────────────────────────────────────────

export interface ChatQuoteOptions {
  /** Isi pesan yang dirender di dalam bubble */
  message: string;
  /** Nama tampilan pengirim (label berwarna dalam bubble, opsional) */
  senderName?: string;
  /** Waktu di header/jam bubble (default: sekarang, zona Asia/Jakarta) */
  time?: Date;
}

interface BubbleLayout {
  fontSize: number;
  lines: string[];
  lineHeight: number;
  bubbleW: number;
  bubbleH: number;
  truncated: boolean;
}

/** Susun layout bubble: pilih fontSize terbesar yang muat & wajar. */
function layoutBubble(text: string): BubbleLayout {
  const innerMax = BUBBLE_MAX_W - BUBBLE_PAD_X * 2;
  const SIZES = [44, 40, 37, 34, 31, 28, 26, 24]; // font dibesarkan agar bubble tampil besar

  for (const fontSize of SIZES) {
    const lineHeight = Math.round(fontSize * 1.38);
    const lines = wrapText(text, fontSize, innerMax);
    // Muat utuh di ukuran ini? (belum tentu di ukuran lebih besar)
    if (lines.length > MAX_LINES) continue;

    const maxLineW = Math.max(
      ...lines.map((l) => lineWidth(tokenize(l, fontSize), fontSize)),
      10
    );
    const bubbleW = Math.min(
      BUBBLE_MAX_W,
      Math.max(BUBBLE_MIN_W, maxLineW + BUBBLE_PAD_X * 2 + 20)
    );
    const bubbleH =
      BUBBLE_PAD_Y + NAME_H + lines.length * lineHeight + META_H + BUBBLE_PAD_Y - 4;
    return { fontSize, lines, lineHeight, bubbleW, bubbleH, truncated: false };
  }

  // Bahkan ukuran terkecil tak muat (teks super panjang): pakai ukuran
  // terkecil + pangkas dengan elipsis di baris terakhir.
  const fontSize = SIZES[SIZES.length - 1];
  const lineHeight = Math.round(fontSize * 1.38);
  const lines = wrapText(text, fontSize, BUBBLE_MAX_W - BUBBLE_PAD_X * 2).slice(0, MAX_LINES);
  let last = lines[MAX_LINES - 1] || '';
  while (last && estWidth(`${last}…`, fontSize) > BUBBLE_MAX_W - BUBBLE_PAD_X * 2 && last.includes(' ')) {
    last = last.slice(0, last.lastIndexOf(' ')).trimEnd();
  }
  lines[MAX_LINES - 1] = `${last}…`.trim();
  return {
    fontSize,
    lines,
    lineHeight,
    bubbleW: BUBBLE_MAX_W,
    bubbleH: BUBBLE_PAD_Y + NAME_H + lines.length * lineHeight + META_H + BUBBLE_PAD_Y - 4,
    truncated: true,
  };
}

// ─────────────────────────────────────────────────────────
// Elemen SVG (header, ikon, bubble)
// ─────────────────────────────────────────────────────────

/** Jam HH:MM WIB. */
function formatTime(d: Date): string {
  return d.toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Jakarta',
  });
}

/** Ekor bubble khas WA (tanduk kecil di sisi atas). */
function bubbleTailSvg(x: number, y: number, w: number, side: 'left' | 'right'): string {
  const edge = side === 'left' ? x : x + w;
  const dir = side === 'left' ? -1 : 1;
  return (
    `<path d="M ${edge} ${y + 20}` +
    ` C ${edge + dir * 8} ${y + 18} ${edge + dir * 13} ${y + 10} ${edge + dir * 13} ${y - 2}` +
    ` C ${edge + dir * 9} ${y + 7} ${edge + dir * 5} ${y + 12} ${edge} ${y + 13} Z"` +
    ` fill="${COLOR_OUT_BUBBLE}"/>`
  );
}

/** Baris teks bubble (mendukung emoji twemoji), rata kiri mulai x. */
function bubbleLineSvg(
  tokens: Token[],
  x: number,
  baseline: number,
  fontSize: number,
  color: string
): string {
  const parts: string[] = [];
  let cx = x;
  const spaceW = estWidth(' ', fontSize);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'emoji' && t.dataUri) {
      parts.push(
        `<image x="${cx.toFixed(1)}" y="${(baseline - fontSize * 0.8).toFixed(1)}" width="${t.w}" height="${t.w}" href="${t.dataUri}"/>`
      );
      cx += t.w + spaceW * 0.35;
    } else {
      const value = t.type === 'emoji' ? t.value : t.value;
      const w = t.type === 'emoji' ? t.w : estWidth(value, fontSize);
      parts.push(
        `<text x="${cx.toFixed(1)}" y="${baseline}" font-size="${fontSize}" fill="${color}" font-family="${FONT_STACK}">${escapeXml(value)}</text>`
      );
      cx += w + spaceW;
    }
  }
  return parts.join('');
}

// ─────────────────────────────────────────────────────────
// Render utama
// ─────────────────────────────────────────────────────────

/**
 * Render pesan menjadi foto "screenshot chat WA" potrait 9:16 (1080×1920).
 * TANPA header (nama kontak & ikon video/call dihapus), bubble HITAM muncul
 * dari kiri (gaya chat diterima), nama pengirim berwarna, jam di dalam bubble.
 * assets/background.jpeg = latar gelap penuh kanvas, emot.jpeg = hiasan DI
 * ATAS chat, pop.jpeg = hiasan DI BAWAH chat (background hitam keduanya
 * dibuang otomatis). Blok isi diratakan tengah secara vertikal.
 */
export async function renderChatQuoteImage(opts: ChatQuoteOptions): Promise<Buffer> {
  const text = (opts.message || '').trim();
  if (!text) throw new Error('Pesan kosong');

  const senderName = (opts.senderName || '').trim() || 'Pengirim';
  const time = opts.time || new Date();
  await prefetchEmojis(text);

  const layout = layoutBubble(text);

  // Warna nama pengirim: hash nama -> warna WA stabil
  let hash = 0;
  for (const ch of senderName) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const nameColor = NAME_COLORS[hash % NAME_COLORS.length];

  // Dekor: emot DI ATAS chat (hanya background luar dibuang — isi kartu/item
  // dibiarkan utuh), pop DI BAWAH chat
  const [emot, pop] = await Promise.all([
    loadDecor('emot', EMOT_W, false),
    loadDecor('pop', POP_W),
  ]);

  // Dimensi render dekor mengikuti rasio konten hasil crop background
  let emotW = emot ? EMOT_W : 0;
  let emotH = emot ? Math.max(40, Math.round((EMOT_W * emot.h) / emot.w)) : 0;
  let popW = pop ? POP_W : 0;
  let popH = pop ? Math.max(60, Math.round((POP_W * pop.h) / pop.w)) : 0;

  // Ukuran bubble ikut dibesarkan supaya setara dengan dekor
  layout.bubbleW = Math.max(layout.bubbleW, Math.min(BUBBLE_MIN_W, layout.bubbleW + 200));
  const canvasH = CANVAS_H;
  const availDecor = CANVAS_H - EDGE_PAD * 2 - layout.bubbleH - DECOR_GAP * 2;
  if (emotH + popH > availDecor) {
    // Pesan panjang: kecilkan pop dulu, lalu emot, supaya semua tetap muat
    if (pop) {
      popH = Math.max(220, availDecor - Math.min(emotH, 140));
      popW = Math.max(200, Math.round((popH * pop.w) / pop.h));
    }
    if (emot) {
      emotH = Math.max(70, availDecor - popH);
      emotW = Math.max(300, Math.round((emotH * emot.w) / emot.h));
    }
  }
  const contentH = (emot ? emotH + DECOR_GAP : 0) + layout.bubbleH + (pop ? DECOR_GAP + popH : 0);
  const topGap = Math.max(EDGE_PAD, Math.round((CANVAS_H - contentH) / 2));

  // Posisi bubble: MUNCUL DARI KIRI (seperti chat diterima)
  const bubbleX = BUBBLE_MARGIN;
  const bubbleY = topGap + (emot ? emotH + DECOR_GAP : 0);

  // Elemen bubble
  const innerLeft = bubbleX + BUBBLE_PAD_X;
  const nameBaseline = bubbleY + BUBBLE_PAD_Y + layout.fontSize * 0.82;
  const firstLineBaseline = nameBaseline + NAME_H + layout.lineHeight - layout.fontSize * 0.82 + 2;

  const lineSvgs: string[] = [
    `<text x="${innerLeft}" y="${nameBaseline.toFixed(1)}" font-size="26" font-weight="600" fill="${nameColor}" font-family="${FONT_STACK}">${escapeXml(senderName)}</text>`,
  ];
  layout.lines.forEach((line, i) => {
    const baseline = firstLineBaseline + i * layout.lineHeight;
    lineSvgs.push(bubbleLineSvg(tokenize(line, layout.fontSize), innerLeft, baseline, layout.fontSize, COLOR_TEXT));
  });

  // Jam di kanan-bawah bubble (bubble kiri = gaya chat diterima, tanpa centang)
  const metaBaseline = bubbleY + layout.bubbleH - BUBBLE_PAD_Y + 2;
  const metaSvg =
    `<text x="${bubbleX + layout.bubbleW - BUBBLE_PAD_X}" y="${metaBaseline}" font-size="22" fill="${COLOR_META}" text-anchor="end" font-family="${FONT_STACK}">${formatTime(time)}</text>`;

  const bubbleSvg =
    bubbleTailSvg(bubbleX, bubbleY, layout.bubbleW, 'left') +
    `<rect x="${bubbleX}" y="${bubbleY}" width="${layout.bubbleW}" height="${layout.bubbleH}" rx="${BUBBLE_R}" fill="${COLOR_OUT_BUBBLE}"/>` +
    lineSvgs.join('') +
    metaSvg;

  // Dekor emot (atas) & pop (bawah) — PNG transparan, sudut membulat.
  // emot = 'left' (mentok tepi kiri kanvas, seperti template lama), pop center.
  const decorSvg = (
    uri: string,
    w: number,
    h: number,
    y: number,
    id: string,
    align: 'center' | 'left' = 'center'
  ): string => {
    const x = align === 'left' ? 0 : Math.round((CANVAS_W - w) / 2);
    return (
      `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${DECOR_R}"/></clipPath>` +
      `<image x="${x}" y="${y}" width="${w}" height="${h}" href="${uri}" clip-path="url(#${id})" preserveAspectRatio="none"/>`
    );
  };
  const emotSvg = emot ? decorSvg(emot.uri, emotW, emotH, topGap, 'emotClip', 'left') : '';
  const popSvg = pop ? decorSvg(pop.uri, popW, popH, bubbleY + layout.bubbleH + DECOR_GAP, 'popClip') : '';

  const svg =
    `<svg width="${CANVAS_W}" height="${canvasH}" xmlns="http://www.w3.org/2000/svg">` +
    emotSvg +
    bubbleSvg +
    popSvg +
    `</svg>`;

  const background = await loadBackground(CANVAS_W, canvasH);

  return sharp(background)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 92 })
    .toBuffer();
}
