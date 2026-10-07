import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Maintenance module untuk mini server (STB HG860P - resource terbatas).
 * - Auto clean log lama + batasi ukuran folder log
 * - Hapus file temporary / media setelah diproses
 * - Batasi ukuran cache
 * - Session dibersihkan HATI-HATI (creds.json & app-state TIDAK disentuh)
 */

const LOG_DIR = path.resolve('logs');
const TMP_DIR = path.resolve('tmp');
const CACHE_DIR = path.resolve('cache');
const DATA_DIR = path.resolve('data');

// Pastikan folder yang dibutuhkan ada saat module dimuat
ensureDir(LOG_DIR);
ensureDir(TMP_DIR);
ensureDir(CACHE_DIR);

// ====== KONFIGURASI (bisa lewat .env) ======
const MAX_LOG_AGE_HOURS = parseInt(process.env.LOG_MAX_AGE_HOURS || '24', 10);
const MAX_LOG_TOTAL_MB = parseInt(process.env.LOG_MAX_TOTAL_MB || '20', 10);
const MAX_TMP_AGE_MINUTES = parseInt(process.env.TMP_MAX_AGE_MINUTES || '30', 10);
const MAX_CACHE_MB = parseInt(process.env.CACHE_MAX_MB || '50', 10);

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Hapus file aman: tidak throw */
function safeUnlink(filePath: string): boolean {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (err: any) {
    logger.warn({ err: err.message }, `Gagal hapus file: ${filePath}`);
    return false;
  }
}

/**
 * 1. CLEAN LOG
 * - Hapus log lebih tua dari MAX_LOG_AGE_HOURS
 * - Jika total ukuran log > MAX_LOG_TOTAL_MB, hapus yang paling lama sampai di bawah limit
 */
export function cleanLogs(): void {
  try {
    ensureDir(LOG_DIR);
    const maxAgeMs = MAX_LOG_AGE_HOURS * 60 * 60 * 1000;
    let files = fs.readdirSync(LOG_DIR)
      .filter((f) => f.endsWith('.log') || f.endsWith('.log.gz'))
      .map((f) => {
        const p = path.join(LOG_DIR, f);
        const st = fs.statSync(p);
        return { path: p, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => a.mtime - b.mtime); // terlama dulu

    let removed = 0;

    // a) by age
    for (const f of files) {
      if (Date.now() - f.mtime > maxAgeMs) {
        if (safeUnlink(f.path)) removed++;
      }
    }

    // b) by total size
    files = files.filter((f) => fs.existsSync(f.path));
    let totalSize = files.reduce((s, f) => s + f.size, 0);
    const maxBytes = MAX_LOG_TOTAL_MB * 1024 * 1024;
    for (const f of files) {
      if (totalSize <= maxBytes) break;
      if (safeUnlink(f.path)) {
        removed++;
        totalSize -= f.size;
      }
    }

    if (removed > 0) logger.info(`Log cleanup: ${removed} file log dihapus`);
  } catch (err: any) {
    logger.error({ err: err.message }, 'cleanLogs error');
  }
}

/**
 * 2. CLEAN TEMPORARY FILES
 * Hapus semua file di folder tmp/ yang lebih tua dari MAX_TMP_AGE_MINUTES.
 * Media yang diproses bot sebaiknya ditulis ke tmp/ agar otomatis terhapus.
 */
export function cleanTempFiles(): void {
  try {
    ensureDir(TMP_DIR);
    const maxAgeMs = MAX_TMP_AGE_MINUTES * 60 * 1000;
    let removed = 0;
    for (const f of fs.readdirSync(TMP_DIR)) {
      const p = path.join(TMP_DIR, f);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && Date.now() - st.mtimeMs > maxAgeMs) {
          if (safeUnlink(p)) removed++;
        }
      } catch { }
    }
    if (removed > 0) logger.info(`Temp cleanup: ${removed} file tmp dihapus`);
  } catch (err: any) {
    logger.error({ err: err.message }, 'cleanTempFiles error');
  }
}

/**
 * 3. BATASI UKURAN CACHE
 * Jika folder cache/ melebihi MAX_CACHE_MB, hapus file terlama sampai di bawah limit.
 */
export function enforceCacheLimit(): void {
  try {
    ensureDir(CACHE_DIR);
    const maxBytes = MAX_CACHE_MB * 1024 * 1024;
    let files = fs.readdirSync(CACHE_DIR)
      .map((f) => {
        const p = path.join(CACHE_DIR, f);
        const st = fs.statSync(p);
        return { path: p, mtime: st.mtimeMs, size: st.size };
      })
      .filter((f) => f.size >= 0)
      .sort((a, b) => a.mtime - b.mtime); // terlama dulu

    let total = files.reduce((s, f) => s + f.size, 0);
    let removed = 0;
    for (const f of files) {
      if (total <= maxBytes) break;
      if (safeUnlink(f.path)) {
        removed++;
        total -= f.size;
      }
    }
    if (removed > 0) {
      logger.info(`Cache cleanup: ${removed} file dihapus (limit ${MAX_CACHE_MB}MB)`);
    }
  } catch (err: any) {
    logger.error({ err: err.message }, 'enforceCacheLimit error');
  }
}

/**
 * 4. BERSIHKAN DATA SAMPAH DI data/ (aman)
 * Hanya hapus qr.png / qr.html lama (>1 jam). db.json TIDAK disentuh.
 */
export function cleanDataJunk(): void {
  try {
    ensureDir(DATA_DIR);
    for (const f of ['qr.png', 'qr.html']) {
      const p = path.join(DATA_DIR, f);
      if (!fs.existsSync(p)) continue;
      const st = fs.statSync(p);
      if (Date.now() - st.mtimeMs > 60 * 60 * 1000) safeUnlink(p);
    }
  } catch (err: any) {
    logger.error({ err: err.message }, 'cleanDataJunk error');
  }
}

/**
 * Jalankan semua tugas maintenance (dipanggil berkala dari index.ts)
 */
export function runMaintenance(): void {
  cleanLogs();
  cleanTempFiles();
  enforceCacheLimit();
  cleanDataJunk();
}

/**
 * Setup interval maintenance. Default tiap 15 menit.
 */
export function startMaintenanceScheduler(intervalMinutes = 15): NodeJS.Timeout {
  // jalankan sekali saat startup (delay 1 menit biar bot stabil dulu)
  setTimeout(runMaintenance, 60_000);
  const timer = setInterval(runMaintenance, intervalMinutes * 60 * 1000);
  logger.info(`Maintenance scheduler aktif (tiap ${intervalMinutes} menit)`);
  return timer;
}
