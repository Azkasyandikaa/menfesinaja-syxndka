import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WASocket,
  WAMessage,
  Browsers,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import { baileysLogger, logger } from '../utils/logger.js';
import { MessageHandler } from '../handlers/message.handler.js';
import { shouldReconnect } from './reconnect.js';
import { registerLidMappings, getLidForPhone, setLidMapping } from '../utils/lid-map.js';
import { getAllOwnerNumbers } from '../middleware/owner.middleware.js';
import { getAllAdminNumbers } from '../middleware/access.middleware.js';

// Cache pesan terakhir untuk retry dekripsi (mencegah "No matching sessions")
const messageStore = new Map<string, WAMessage>();
const MAX_MESSAGE_STORE = 1000;

let sockInstance: WASocket | null = null;
let isConnecting = false;
let reconnectAttempts = 0;
let lastConnectionTime = 0;
let hasEverConnected = false; // Track if we've EVER had a successful connection
const MAX_RECONNECT_ATTEMPTS = 20;
const MAX_515_RESTARTS = 5; // 515 beruntun tanpa 'open' dianggap sesi korup
const INITIAL_RECONNECT_DELAY = 5000; // Increased from 3s to reduce spam
const MAX_RECONNECT_DELAY = 60000;
// Auto pairing: delay 30 detik & maks 3x per start bot (hemat kuota kode pairing WA)
const AUTO_PAIRING_DELAY = 30000;
const MAX_AUTO_PAIRING_ATTEMPTS = 3;
let autoPairingAttempts = 0;
let restart515Count = 0;
let conflictCount = 0;
let healthCheckInterval: NodeJS.Timeout | null = null;
let connectStuckTimer: NodeJS.Timeout | null = null;
let pairingRequestTimer: NodeJS.Timeout | null = null;
let pairingCodeRequested = false; // sekali per socket - cegah request dobel
let isConnected = false; // true setelah event 'open' - mencegah request pairing saat sudah konek

/**
 * CATATAN PENTING soal error 515 (DisconnectReason.restartRequired):
 * Di Baileys 6.7.x, server WA SELALU memutus koneksi dengan 515 tepat SETELAH
 * QR di-scan / pairing berhasil, lalu meminta client login ulang dengan kunci baru.
 * Ini NORMAL dan bukan tanda session korup. Jika kita menghapus folder session
 * setiap 515, bot akan terjebak loop QR tanpa akhir (session tidak pernah tersimpan).
 * 515 hanya dianggap fatal jika terjadi berulang tanpa pernah mencapai 'open'.
 */

export async function connectToWhatsApp(): Promise<WASocket> {
  if (isConnecting) {
    logger.warn('Connection attempt already in progress, skipping duplicate call.');
    return sockInstance!;
  }
  isConnecting = true;
  pairingCodeRequested = false; // reset per koneksi baru
  if (pairingRequestTimer) {
    clearTimeout(pairingRequestTimer);
    pairingRequestTimer = null;
  }

  // Clean up existing socket if any.
  // PENTING: matikan socket lama TOTAL + lepas SEMUA listener-nya.
  // close() saja TIDAK membatalkan handshake yang sedang berjalan -> socket
  // "hantu" bisa menyelesaikan login di belakang punggung, dan server WA akan
  // memutus koneksi BARU dengan 440 (connectionReplaced) -> loop
  // putus-sambung 440/401 tanpa akhir. Ini penyebab utama "koneksi terputus
  // mulu" setelah pairing ulang.
  if (sockInstance) {
    const oldSock = sockInstance;
    sockInstance = null;
    if (pairingRequestTimer) {
      clearTimeout(pairingRequestTimer);
      pairingRequestTimer = null;
    }
    try {
      (oldSock.ev as any).removeAllListeners();
    } catch {}
    try {
      oldSock.ws?.removeAllListeners?.();
    } catch {}
    try {
      // Baileys 7: WebSocketClient tidak punya terminate(), gunakan end(error)
      // yang memaksa socket close sinkron - memutus handshake yang berjalan.
      (oldSock as any).end?.(new Error('socket replaced'));
    } catch {}
    try {
      oldSock.ws?.close?.();
    } catch {}
  }

  const sessionDir = path.resolve('session');
  const dataDir = path.resolve('data');
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Deteksi session fresh: creds.json belum ada = benar-benar baru (first run
  // atau habis di-wipe). Hanya pada kondisi ini auto request pairing code boleh
  // jalan. JANGAN pakai creds.registered sebagai acuan: di Baileys 7 flag itu
  // hanya di-set true lewat jalur pairing code (bukan QR), jadi session yang
  // dipairing via QR selamanya registered=false padahal valid.
  const hadExistingCreds = fs.existsSync(path.join(sessionDir, 'creds.json'));

  // Initialize auth state with error handling
  let state;
  let saveCreds;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(sessionDir));
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to initialize auth state, creating fresh session');
    // Force clean auth state if initialization fails
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    ({ state, saveCreds } = await useMultiFileAuthState(sessionDir));
  }
  const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1023223821] as [number, number, number], isLatest: false }));

  // Cache signal keys di memori - PENTING: tanpa ini sering terjadi kegagalan
  // dekripsi pesan (Bad MAC) sehingga bot "connect" tapi tidak bisa baca chat
  const cachedAuth = {
    creds: state.creds,
    keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
  };

  logger.info(`Using Baileys v${version.join('.')}, isLatest: ${isLatest}`);

  const pairingNumber = process.env.PAIRING_NUMBER
    ? process.env.PAIRING_NUMBER.replace(/[^0-9]/g, '')
    : '';

  const sock = makeWASocket({
    version,
    auth: cachedAuth,
    logger: baileysLogger,
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
    browser: Browsers.ubuntu('Chrome'),
    // PENTING: false agar WA tetap mengirim pesan ke socket bot.
    // Jika true, WA sering menganggap perangkat ini "online utama"
    // dan menahan/menyalahkan routing pesan -> bot connect tapi tidak terima chat
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // 180 detik terlalu lama: koneksi yang gagal handshake menggantung ~3 menit
    // sebelum ditendang server (408). 60 detik cukup & pemulihan jauh lebih cepat.
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 30_000, // Increased: less aggressive during QR scanning
    retryRequestDelayMs: 5000, // Increased: more patience during initial connection
    // Callback retry dekripsi: ambil pesan dari cache agar WA bisa
    // mengirim ulang / bot bisa mendekripsi ulang saat WA minta retry.
    getMessage: async (key) => messageStore.get(`${key.remoteJid}|${key.id}`)?.message ?? undefined,
    shouldSyncHistoryMessage: () => false,
  });

  sockInstance = sock;

  // Request pairing code hanya jika: PAIRING_NUMBER diisi, BELUM terdaftar,
  // dan BELUM terkoneksi. PENTING: jangan pernah request pairing code saat
  // sesi sudah aktif/terdaftar - WA akan mencabut registrasi perangkat
  // (503 -> 401 logged out) dan session di-wipe. Inilah loop
  // "pairing ulang terus" yang terjadi sebelumnya.
  if (pairingNumber && !hadExistingCreds && !sock.authState.creds.registered) {
    pairingRequestTimer = setTimeout(async () => {
      // Batal jika sudah konek (open) - jangan ganggu sesi yang hidup!
      if (isConnected) {
        logger.info('Skip request pairing code: bot sudah terkoneksi dengan sesi yang valid.');
        return;
      }
      // Batal jika socket ini sudah digantikan socket baru (reconnect)
      if (sockInstance !== sock) return;
      if (pairingCodeRequested) return; // sekali per socket saja
      pairingCodeRequested = true;
      try {
        const code = await sock.requestPairingCode(pairingNumber);
        console.log('\n================================━━━━━━━━━━━');
        console.log(`🔑 KODE PAIRING WHATSAPP (Alternative):  ${code}`);
        console.log('Jika QR tidak muncul, gunakan kode ini:');
        console.log('Buka WA -> Perangkat Tertaut -> Tautkan dengan nomor telepon -> Masukkan kode!');
        console.log('================================━━━━━━━━━━━\n');
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Pairing code request skipped (socket may have closed)');
      }
    }, 8000); // Increased delay to 8 seconds to ensure socket is more stable
  }

  // Aktifkan watchdog SETELAH socket dibuat & listener terpasang
  armConnectWatchdog(sock);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    // Reset watchdog setiap ada event koneksi (QR/open/close/notify) -
    // artinya socket masih hidup. Watchdog hanya menghukum socket yang
    // BENAR-BENAR bisu (tidak ada event sama sekali dalam 90 detik).
    armConnectWatchdog(sock);

    if (update.receivedPendingNotifications) {
      logger.info('Historis sinkron selesai - bot siap menerima pesan baru');
    }
    const { connection, lastDisconnect, qr } = update;

    // Debug logging for connection states - log ALL updates
    logger.info(
      { 
        connection, 
        hasQr: !!qr, 
        hasError: !!lastDisconnect?.error,
        disconnectReason: (lastDisconnect?.error as any)?.output?.statusCode,
        errorMessage: (lastDisconnect?.error as any)?.message || (lastDisconnect?.error as any)?.toString?.()
      }, 
      'CONNECTION UPDATE EVENT'
    );

    if (qr) {
      logger.info('QR code generated! Displaying now...');
      console.clear();
      console.log('================================━━━━━━━━━━━');
      console.log('📱 SCAN QR CODE INI DENGAN WHATSAPP DI HP ANDA:');
      console.log('WhatsApp -> Perangkat Tertaut -> Tautkan Perangkat');
      console.log('🖼️ Atau buka file gambar QR: tmp/qr.png');
      console.log('================================━━━━━━━━━━━');
      try {
        qrcodeTerminal.generate(qr, { small: true });
      } catch (err: any) {
        logger.error({ err: err.message }, 'Error generating QR code');
        console.log('QR Code:', qr);
      }
      // Simpan QR sebagai gambar PNG agar mudah discan dari HP
      try {
        fs.mkdirSync(path.resolve('tmp'), { recursive: true });
        await QRCode.toFile(path.resolve('tmp', 'qr.png'), qr, {
          width: 1024,
          margin: 2,
          color: { dark: '#000000ff', light: '#ffffffff' },
        });
        logger.info('QR tersimpan: tmp/qr.png');
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Gagal menyimpan QR PNG');
      }
      console.log('⏳ QR berlaku ~60 detik. Jika expired, QR baru akan muncul otomatis.');
    }

    if (connection === 'close') {
      isConnecting = false;
      isConnected = false;
      if (connectStuckTimer) {
        clearTimeout(connectStuckTimer);
        connectStuckTimer = null;
      }
      stopHealthCheck();
      const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
      logger.warn({ reason }, 'Koneksi terputus.');

      if (reason === DisconnectReason.connectionReplaced) {
        // 440 (conflict): sesi dipakai koneksi lain. Sering kali ini RACE normal
        // sesaat setelah pairing/reconnect - koneksi lama belum rampung dilepas
        // server WA. Mati total (process.exit) justru mematikan bot;
        // cukup reconnect dengan backoff. Jika benar-benar ada instance duplikat,
        // pesan 440 akan berulang - log akan menunjukkannya.
        conflictCount++;
        logger.warn(`Koneksi ditolak (440) konflik #${conflictCount} - reconnect...`);
        if (conflictCount <= 3) {
          setTimeout(() => {
            connectToWhatsApp().catch((err: any) => {
              logger.error({ err: err.message }, 'Reconnect setelah 440 gagal');
            });
          }, 5000 * conflictCount);
        } else {
          // Jangan menyerah selamanya: tetap reconnect dengan jeda panjang.
          // 440 berulang biasanya berarti INSTANCE LAIN memakai folder session
          // yang sama - tapi berhenti total membuat bot mati permanen.
          if (conflictCount % 10 === 0) {
            logger.error(`440 sudah ${conflictCount}x: kemungkinan besar ada INSTANCE LAIN memakai folder session yang sama. Matikan duplikatnya (pm2 list di semua device) atau hapus folder session untuk pairing ulang.`);
          }
          setTimeout(() => {
            connectToWhatsApp().catch((err: any) => {
              logger.error({ err: err.message }, 'Reconnect setelah 440 gagal');
            });
          }, 60_000);
        }
        return;
      }

      if (reason === DisconnectReason.loggedOut) {
        // loggedOut (401): WA mencabut registrasi perangkat ini secara permanen.
        // Satu-satunya kasus yang BENAR-BENAR butuh hapus session + pairing ulang.
        logger.error('Logged out (401): sesi dicabut WhatsApp. Wipe session & pairing ulang diperlukan.');
        wipeSession();
        hasEverConnected = false;

        if (autoPairingAttempts >= MAX_AUTO_PAIRING_ATTEMPTS) {
          logger.error(
            `Auto pairing dihentikan (maks ${MAX_AUTO_PAIRING_ATTEMPTS}x). Pairing manual diperlukan - jalankan ulang bot.`
          );
          return;
        }
        autoPairingAttempts++;
        restart515Count = 0;
        reconnectAttempts = 0;
        const delay = AUTO_PAIRING_DELAY;
        logger.info(
          `🔄 Pairing ulang otomatis dalam ${delay / 1000} detik (percobaan ${autoPairingAttempts}/${MAX_AUTO_PAIRING_ATTEMPTS})...`
        );
        setTimeout(() => {
          connectToWhatsApp().catch((err: any) => {
            logger.error({ err: err.message }, 'Gagal pairing ulang otomatis');
          });
        }, delay);
        return;
      }

      if (reason === DisconnectReason.restartRequired) {
        // 515 setelah scan QR = NORMAL di Baileys 6.7.x (login ulang dengan kunci baru).
        // JANGAN wipe session. Cukup reconnect - creds sudah tersimpan oleh saveCreds.
        if (hasEverConnected) {
          logger.info('Stream error 515 setelah pairing (normal di Baileys 6.7.x) - reconnect dengan session yang ada...');
          restart515Count = 0;
          const delay = 3000;
          setTimeout(() => {
            connectToWhatsApp().catch((err: any) => {
              logger.error({ err: err.message }, 'Reconnect setelah 515 gagal');
            });
          }, delay);
          return;
        }

        // 515 berulang TANPA pernah 'open' -> kemungkinan besar sesi korup.
        restart515Count++;
        if (restart515Count >= MAX_515_RESTARTS) {
          logger.error(`515 berulang ${restart515Count}x tanpa berhasil connect - sesi dianggap korup. Wipe session & pairing ulang.`);
          wipeSession();
          restart515Count = 0;
          if (autoPairingAttempts >= MAX_AUTO_PAIRING_ATTEMPTS) {
            logger.error(`Auto pairing dihentikan (maks ${MAX_AUTO_PAIRING_ATTEMPTS}x). Jalankan ulang bot untuk pairing manual.`);
            return;
          }
          autoPairingAttempts++;
          const delay = AUTO_PAIRING_DELAY;
          setTimeout(() => {
            connectToWhatsApp().catch((err: any) => {
              logger.error({ err: err.message }, 'Gagal pairing ulang otomatis');
            });
          }, delay);
          return;
        }

        logger.info(`515 tanpa koneksi sukses (percobaan ${restart515Count}/${MAX_515_RESTARTS}) - reconnect...`);
        const delay = 3000;
        setTimeout(() => {
          connectToWhatsApp().catch((err: any) => {
            logger.error({ err: err.message }, 'Reconnect setelah 515 gagal');
          });
        }, delay);
        return;
      }

      if (shouldReconnect(lastDisconnect?.error)) {
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          logger.error('Max reconnect attempts reached. Exiting...');
          process.exit(1);
        }

        // Exponential backoff: 3s, 6s, 12s, 24s, ... max 60s
        const delay = Math.min(
          INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttempts),
          MAX_RECONNECT_DELAY
        );
        reconnectAttempts++;

        logger.info(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        setTimeout(() => {
          connectToWhatsApp().catch((err) => {
            logger.error({ err: err.message }, 'Reconnect attempt failed');
          });
        }, delay);
      } else {
        logger.error('Should not reconnect based on error reason');
      }
    } else if (connection === 'open') {
      isConnecting = false;
      isConnected = true; // tandai sesi aktif - pairing code batal otomatis
      if (connectStuckTimer) {
        clearTimeout(connectStuckTimer);
        connectStuckTimer = null;
      }
      reconnectAttempts = 0; // Reset on successful connection
      restart515Count = 0;
      conflictCount = 0; // Koneksi sukses - konflik lampau selesai
      autoPairingAttempts = 0; // Budget pairing ulang kembali penuh untuk 401 di masa depan
      lastConnectionTime = Date.now();
      hasEverConnected = true; // Mark that we've successfully connected at least once

      logger.info('================================━━━━━━━━━━━');
      logger.info('🚀 WhatsApp Bot Bisnis Berhasil Terhubung & Stabil!');
      logger.info(`📱 User ID: ${sock.user?.id}`);
      logger.info('================================━━━━━━━━━━━');

      // Simpan LID bot sendiri -> nomor bot. Penting untuk self-chat:
      // saat bot dipairing dengan nomor owner, perintah yang diketik di "Message
      // Yourself" masuk dengan JID @lid milik bot.
      const userAny = sock.user as any;
      if (userAny?.lid) {
        setLidMapping(userAny.lid, userAny.id || '');
        logger.info(`🔗 LID bot sendiri terdaftar: ${userAny.lid}`);
      }

      // Bangun mapping LID <-> nomor HP untuk owner + admin bot, agar perintah
      // mereka yang masuk dengan JID @lid tetap dikenali (WA baru sering kirim JID @lid).
      const ownerNumbers = [...new Set([...getAllOwnerNumbers(), ...getAllAdminNumbers()])];
      if (ownerNumbers.length > 0) {
        registerLidMappings(sock.onWhatsApp.bind(sock), ownerNumbers)
          .then((n) => {
            if (n > 0) {
              logger.info({ mapped: n }, 'Mapping LID owner terdaftar');
              ownerNumbers.forEach((num) => {
                const lid = getLidForPhone(num);
                if (lid) logger.info(`👑 Owner ${num} -> LID ${lid}`);
              });
            }
          })
          .catch(() => { });
      }

      // Start health check interval
      startHealthCheck(sock);
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    logger.info({ type: m.type, count: m.messages.length }, 'messages.upsert diterima');
    // Simpan pesan ke cache untuk retry dekripsi
    for (const msg of m.messages) {
      const storeKey = `${msg.key.remoteJid}|${msg.key.id}`;
      messageStore.set(storeKey, msg);
      if (messageStore.size > MAX_MESSAGE_STORE) {
        const first = messageStore.keys().next().value;
        if (first) messageStore.delete(first);
      }
    }
    // Log semua upsert agar mudah debug kenapa chat tidak dibalas
    for (const msg of m.messages) {
      const msgType = Object.keys(msg.message || {})[0] || 'NO_MESSAGE_BODY';
      logger.info(
        { type: m.type, msgType, from: msg.key.remoteJid, fromMe: msg.key.fromMe, id: msg.key.id },
        'PESAN MASUK'
      );

      // Pesan tanpa body (dekripsi gagal / protocol / receipt) - lewati dengan log
      if (!msg.message) {
        logger.warn({ id: msg.key.id, from: msg.key.remoteJid }, 'Pesan tanpa body (kemungkinan gagal dekripsi), dilewati');
        continue;
      }

      if (m.type !== 'notify') continue;

      // Handle message with timeout protection
      try {
        await Promise.race([
          MessageHandler.handleMessage(sock, msg),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Message handler timeout')), 30000)
          ),
        ]);
      } catch (err: any) {
        logger.error(
          { err: err.message, msgId: msg.key.id },
          'Error processing message (timeout or error)'
        );
      }
    }
  });

  return sock;
}

/**
 * Watchdog anti-stuck: jika dalam 90 detik TIDAK ada event koneksi sama sekali
 * (QR/open/close), anggap socket macet -> terminate agar event 'close' terpicu
 * dan alur reconnect normal jalan. Di-reset setiap ada event connection.update.
 */
function armConnectWatchdog(sock: WASocket) {
  if (connectStuckTimer) clearTimeout(connectStuckTimer);
  connectStuckTimer = setTimeout(() => {
    if (!isConnecting) return;
    isConnecting = false;
    logger.warn('Tidak ada event koneksi dalam 90 detik - reset status & akhiri socket macet agar reconnect jalan');
    // JANGAN lepas listener di sini: kita justru butuh event 'close' terpicu
    // supaya handler close menjadwalkan reconnect. end() Baileys 7 = terminate.
    try {
      (sock as any).end?.(new Error('connect watchdog timeout'));
    } catch {}
    try {
      sock.ws?.close?.();
    } catch {}
  }, 90_000);
}

/**
 * Cek apakah websocket Baileys terbuka.
 * Tergantung versi Baileys, ws.isOpen bisa berupa GETTER boolean (6.7.24)
 * atau METHOD isOpen() — dukung keduanya agar tidak TypeError.
 */
function isWsOpen(ws: unknown): boolean {
  try {
    if (!ws) return false;
    const anyWs = ws as { isOpen?: boolean | (() => boolean) };
    if (typeof anyWs.isOpen === 'function') return anyWs.isOpen() === true;
    return anyWs.isOpen === true;
  } catch {
    return false;
  }
}

function startHealthCheck(sock: WASocket) {
  // Clear existing interval if any
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }

  // Health check tiap 60 detik: deteksi "zombie socket".
  healthCheckInterval = setInterval(() => {
    try {
      // Jangan trigger recovery saat koneksi sedang dalam proses -
      // bisa menimbulkan dua socket bersamaan (sumber 440 conflict).
      if (isConnecting) return;
      if (!isWsOpen(sock.ws)) {
        logger.warn('WebSocket tidak sehat (isOpen=false), mencoba pulihkan...');
        reconnectAttempts = 0;
        stopHealthCheck();
        setTimeout(() => connectToWhatsApp().catch(() => { }), 2000);
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Health check error');
    }
  }, 60000);
}

function stopHealthCheck() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

/**
 * Hapus folder session saat sesi WA mati permanen (logged out / conflict /
 * restart required). Sesi korup tidak bisa dipulihkan, jadi dihapus agar
 * pairing berikutnya mulai dari nol.
 */
function wipeSession() {
  const sessionDir = path.resolve('session');
  try {
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      logger.warn('🗑️  Sesi WA mati permanen - folder session otomatis dihapus. Pairing ulang diperlukan.');
    }
    // Recreate empty session directory so next auth state initialization won't fail
    fs.mkdirSync(sessionDir, { recursive: true });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Gagal menghapus folder session');
  }
}

export function getSocket(): WASocket | null {
  return sockInstance;
}

export function getConnectionStatus() {
  const isOpen = isWsOpen(sockInstance?.ws);
  return {
    connected: sockInstance?.user !== undefined && isOpen,
    reconnectAttempts,
    lastConnectionTime,
    wsExists: !!sockInstance?.ws,
  };
}
