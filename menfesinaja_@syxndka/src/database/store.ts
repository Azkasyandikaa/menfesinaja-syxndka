import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

export interface UsageLimitItem {
  /** Tanggal pemakaian (YYYY-MM-DD, WIB) - counter reset otomatis saat ganti hari */
  date: string;
  /** Jumlah pemakaian fitur hari ini */
  count: number;
}

export interface LimitBonusItem {
  /** Tanggal bonus diberikan (YYYY-MM-DD, WIB) - kadaluarsa saat reset harian */
  date: string;
  /** Jumlah limit ekstra untuk semua fitur publik */
  amount: number;
}

/** Laporan user via fitur lapor (dikirim sebagai teks berformat ke nomor tujuan). */
export interface LaporReportItem {
  /** ID unik laporan, contoh: LP-7F3K2M */
  id: string;
  /** Nomor pelapor (tanpa +) */
  reporter: string;
  /** Kategori laporan (bug, saran, pengguna, lainnya, dst) */
  category: string;
  /** Isi laporan */
  message: string;
  createdAt: string;
  /** Status laporan: baru / diproses / selesai */
  status: 'baru' | 'diproses' | 'selesai';
}

/** Sesi chat perantara (menfess/confess): nomor -> sesi dengan partner */
export interface MenfessSessionItem {
  partner: string;
  status: 'waiting' | 'active';
  initiator: string;
  createdAt: string;
  activatedAt?: string;
  /** JID kanonik pemilik record ini (hasil onWhatsApp, antisipasi @lid) */
  selfJid?: string;
  /** Digit LID pemilik record ini (dipelajari saat target chat bot) */
  selfLid?: string;
  /** JID kanonik partner */
  partnerJid?: string;
  /** Nomor pihak yang acc (harus == partner record initiator) */
  acceptor?: string;
  /** Peran pemilik record ini: 'initiator' = user1 pengirim, 'target' = user2 penerima */
  role: 'initiator' | 'target';
}

export interface DatabaseSchema {
  settings: {
    botName: string;
    prefix: string;
    ownerNumbers: string[];
    /** Nomor Admin Bot: bisa memakai fitur pengaturan bot tanpa limit (selain owner) */
    adminNumbers: string[];
    /** Nomor tujuan fitur menfess IG (tanpa +); override env MENFESS_IG_TARGET */
    menfessIgTarget?: string[];
    /** Nomor tujuan khusus laporan .lapor (tanpa +); override menfessIgTarget untuk laporan */
    laporTarget?: string[];
  };
  greetedUsers: Record<string, string>;
  /** Limit pemakaian fitur publik per user: "nomor|command" -> { date, count } */
  usageLimits?: Record<string, UsageLimitItem>;
  /** Bonus limit harian via .addlimit: "nomor" -> { date, amount } (reset 00:00 WIB) */
  limitBonus?: Record<string, LimitBonusItem>;
  /** Sesi menfess/confess per nomor (dihapus saat sesi berakhir) */
  menfessSessions?: Record<string, MenfessSessionItem>;
  /** Nomor yang mengaktifkan mode menfess (belum punya partner): nomor -> tanggal */
  menfessEnabled?: Record<string, string>;
  /** Laporan fitur lapor: id -> laporan */
  laporReports?: Record<string, LaporReportItem>;
  /** Counter ID lapor berurutan */
  laporCounter?: number;
}

const DATA_DIR = path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_SETTINGS: DatabaseSchema = {
  settings: {
    botName: process.env.BOT_NAME || 'Menfesin Aja Bot',
    prefix: process.env.PREFIX || '.',
    ownerNumbers: process.env.OWNER_NUMBERS ? process.env.OWNER_NUMBERS.split(',').map((n) => n.trim()) : [],
    adminNumbers: process.env.ADMIN_NUMBERS
      ? process.env.ADMIN_NUMBERS.split(',').map((n) => n.trim())
      : [],
  },
  greetedUsers: {},
};

class Store {
  private data: DatabaseSchema;

  constructor() {
    this.data = this.loadData();
  }

  private loadData(): DatabaseSchema {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          settings: { ...DEFAULT_SETTINGS.settings, ...(parsed.settings || {}) },
          greetedUsers: parsed.greetedUsers || {},
          usageLimits: parsed.usageLimits || {},
          limitBonus: parsed.limitBonus || {},
          menfessSessions: parsed.menfessSessions || {},
          menfessEnabled: parsed.menfessEnabled || {},
          laporReports: parsed.laporReports || {},
          laporCounter: parsed.laporCounter || 0,
        };
      } else {
        this.saveDataDirect(DEFAULT_SETTINGS);
        return DEFAULT_SETTINGS;
      }
    } catch (err) {
      logger.error({ err }, 'Failed to load database. Using default configuration.');
      return DEFAULT_SETTINGS;
    }
  }

  public save(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      logger.error({ err }, 'Failed to save database.');
    }
  }

  private saveDataDirect(data: DatabaseSchema): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      logger.error({ err }, 'Failed to write default database.');
    }
  }

  public get get(): DatabaseSchema {
    return this.data;
  }

  public get settings() {
    return this.data.settings;
  }

  public get greetedUsers() {
    return this.data.greetedUsers;
  }

  public get usageLimits() {
    return this.data.usageLimits || (this.data.usageLimits = {});
  }

  public get limitBonus() {
    return this.data.limitBonus || (this.data.limitBonus = {});
  }

  public get menfessSessions() {
    return this.data.menfessSessions || (this.data.menfessSessions = {});
  }

  public get menfessEnabled() {
    return this.data.menfessEnabled || (this.data.menfessEnabled = {});
  }

  public get laporReports() {
    return this.data.laporReports || (this.data.laporReports = {});
  }

  public get laporCounter(): number {
    if (this.data.laporCounter === undefined) this.data.laporCounter = 0;
    return this.data.laporCounter;
  }

  public set laporCounter(value: number) {
    this.data.laporCounter = value;
  }
}

export const db = new Store();
