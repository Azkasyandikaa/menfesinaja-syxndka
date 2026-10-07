import { WASocket } from '@whiskeysockets/baileys';
import { ParsedMessage } from '../utils/parser.js';
import { db } from '../database/store.js';
import { isOwner } from '../middleware/owner.middleware.js';
import {
  isAdminRole,
  getRole,
  getUsage,
  getUsageFor,
  getLimitBonus,
  addLimit,
  formatUserJid,
  resolveLimitNumber,
  COMMAND_LIMITS,
  getAllAdminNumbers,
} from '../middleware/access.middleware.js';
import { extractNumber, toJid } from '../utils/jid.js';
import { getPhoneForLid } from '../utils/lid-map.js';
import { logger } from '../utils/logger.js';
import { sendWithTyping } from '../utils/chat-actions.js';
import { formatDuration, botUptimeSeconds } from '../utils/bot-start.js';
import { renderChatQuoteImage } from '../services/quote-image.service.js';
import { sendInteractiveList, ListSection } from '../services/button.service.js';
import {
  getMenfessSession,
  findMenfessSession,
  createMenfessInvite,
  acceptMenfess,
  endMenfessSession,
  normalizeMenfessNumber,
  enableMenfess,
  isMenfessEnabled,
  clearMenfessEnabled,
  resolveAndStoreJid,
  getMessageJidFor,
  detectMenfessTypo,
  menfessGuideText,
  exitMenfess,
} from '../services/menfess.service.js';
import {
  getMenfessIgTargets,
  menfessIgTargetJid,
  getLaporTargets,
  laporTargetJid,
  menfessIgGuideText,
  laporGuideText,
  LAPOR_CATEGORIES,
  resolveLaporCategory,
  saveLaporReport,
  getLaporReport,
  listLaporReports,
  updateLaporStatus,
  buildLaporText,
  buildLaporConfirmation,
  buildLaporReplyText,
} from '../services/menfess-ig.service.js';

export class CommandHandler {
  public static async handleCommand(sock: WASocket, parsed: ParsedMessage): Promise<boolean> {
    const { command, args, argText, from, sender, isGroup, mentionedJids } = parsed;
    const prefix = db.settings.prefix;
    const senderIsOwner = isOwner(sender);

    switch (command) {
      // -------------------------------------------------------------------
      // MENU & STATUS
      // -------------------------------------------------------------------
      case 'menu':
      case 'help': {
        const hr = '━━━━━━━━━━━━━━━━━━━━━━━━━';
        const role = getRole(sender);
        const roleLabel = role === 'owner' ? '👑 Owner' : role === 'admin' ? '🛡️ Admin Bot' : '👤 User';

        const menuText =
          `╭───「 💕 *${db.settings.botName.toUpperCase()}* 」───\n` +
          `│ 👤 Role : ${roleLabel}\n` +
          `│ 📌 Prefix : \`${prefix}\`\n` +
          `│ 📅 ${new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}\n` +
          `╰${hr}╯\n\n` +
          `💌 *MENFESS / CONFESS*\n` +
          `▸ \`${prefix}menfess\` — Aktifkan mode menfess (chat anonim)\n` +
          `▸ \`${prefix}kirim <pesan> | <nomor>\` — Kirim undangan menfess\n` +
          `▸ \`${prefix}terima\` — Acc undangan menfess\n` +
          `▸ \`${prefix}endsession\` — Akhiri sesi chat\n` +
          `▸ \`${prefix}stopmenfess\` — Keluar mode menfess\n\n` +
          `📸 *MENFESS IG (foto chat)*\n` +
          `▸ \`${prefix}menfesig <pesan>\` — Kirim menfess sebagai foto chat\n` +
          `▸ \`${prefix}setmenfessig <nomor>\` — Atur nomor tujuan (khusus owner)\n\n` +
          `🛡️ *LAPOR*\n` +
          `▸ \`${prefix}lapor <kategori> | <isi>\` — Kirim laporan\n` +
          `  Kategori: ${Object.keys(LAPOR_CATEGORIES).join(', ')}\n` +
          `▸ \`${prefix}setlapor <nomor>\` — Atur nomor tujuan laporan (khusus owner)\n` +
          `▸ \`${prefix}listlapor [jumlah]\` — Daftar laporan masuk\n` +
          `▸ \`${prefix}balaslapor <id> <balasan>\` — Balas laporan\n` +
          `▸ \`${prefix}dellapor <id>\` — Hapus laporan\n\n` +
          `📊 *INFO*\n` +
          `▸ \`${prefix}status\` • \`${prefix}runtime\` • \`${prefix}limit\`\n\n` +
          `🛡️ *ADMIN* — addadmin, deladmin, listadmin, addlimit`;

        await sock.sendMessage(from, { text: menuText }, { quoted: parsed.rawMessage });

        if (isAdminRole(sender)) {
          const adminSections: ListSection[] = [
            {
              title: '💌 Menfess & Lapor',
              rows: [
                { rowId: `${prefix}menfesig `, title: '💌 Kirim Menfess IG', description: `Format: ${prefix}menfesig <pesan>` },
                { rowId: `${prefix}setmenfessig `, title: '🎯 Set Tujuan Menfess IG', description: `Format: ${prefix}setmenfessig <nomor>` },
                { rowId: `${prefix}lapor `, title: '🛡️ Buat Laporan', description: `Format: ${prefix}lapor <kategori> | <isi>` },
                { rowId: `${prefix}listlapor`, title: '📋 Daftar Laporan', description: 'Laporan masuk terbaru' },
                { rowId: `${prefix}setlapor `, title: '🎯 Set Tujuan Lapor', description: `Format: ${prefix}setlapor <nomor>` },
              ],
            },
            {
              title: '🛡️ Manajemen Bot',
              rows: [
                { rowId: `${prefix}addadmin `, title: '👑 Tambah Admin Bot', description: `Format: ${prefix}addadmin 62812xxxx` },
                { rowId: `${prefix}deladmin `, title: '❌ Cabut Admin Bot', description: `Format: ${prefix}deladmin 62812xxxx` },
                { rowId: `${prefix}listadmin`, title: '📜 Daftar Admin Bot', description: 'Nomor dengan akses pengaturan' },
                { rowId: `${prefix}addlimit `, title: '🚦 Tambah Limit User', description: `Format: ${prefix}addlimit @user 10` },
              ],
            },
          ];

          try {
            await sendInteractiveList(
              sock,
              from,
              '🛡️ *MENU ADMIN & OWNER*\nPilih perintah di bawah — tap langsung dijalankan!',
              `🤖 ${db.settings.botName}`,
              '📜 Menu Admin',
              adminSections,
              { quoted: parsed.rawMessage }
            );
          } catch (err: any) {
            logger.warn({ err: err.message }, 'Interactive menu admin ditolak, fallback teks dikirim');
          }
        }
        return true;
      }

      case 'status':
      case 'info': {
        const statusMsg =
          `📊 *STATUS BOT*\n` +
          `-------------------------------\n` +
          `🤖 Bot Name: *${db.settings.botName}*\n` +
          `⚡ Prefix: \`${db.settings.prefix}\` \n` +
          `⏱ Runtime: *${formatDuration(botUptimeSeconds())}*\n` +
          `🎯 Tujuan Menfess IG: *${getMenfessIgTargets().join(', ') || '(belum diatur)'}*\n` +
          `🛡️ Tujuan Lapor: *${getLaporTargets().join(', ') || '(ikut menfess IG)'}*\n` +
          `🛡️ Admin Bot: *${getAllAdminNumbers().length} nomor*\n` +
          `📨 Total Laporan: *${Object.keys(db.laporReports).length}*`;

        await sock.sendMessage(from, { text: statusMsg }, { quoted: parsed.rawMessage });
        return true;
      }

      case 'runtime': {
        const mem = process.memoryUsage();
        const runtimeMsg =
          `🤖 *STATUS BOT*\n\n` +
          `⏱ Runtime: *${formatDuration(botUptimeSeconds())}*\n` +
          `⚡ Prefix: \`${prefix}\`\n\n` +
          `🧠 *Memory Bot*\n` +
          `- Heap Used: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB\n` +
          `- Heap Total: ${(mem.heapTotal / 1024 / 1024).toFixed(2)} MB\n` +
          `- RSS: ${(mem.rss / 1024 / 1024).toFixed(2)} MB`;
        await sock.sendMessage(from, { text: runtimeMsg }, { quoted: parsed.rawMessage });
        return true;
      }

      // -------------------------------------------------------------------
      // LIMIT — cek sisa pemakaian fitur harian
      // -------------------------------------------------------------------
      case 'limit': {
        const targetArg = args[0]?.toLowerCase();
        let targetNumber = '';

        if (targetArg) {
          if (mentionedJids.length > 0) {
            targetNumber = extractNumber(mentionedJids[0]);
          } else {
            let cleaned = targetArg.replace(/[^0-9]/g, '');
            if (cleaned.startsWith('0')) cleaned = '62' + cleaned.slice(1);
            targetNumber = cleaned;
          }
        }

        if (targetNumber) {
          const resolved = getPhoneForLid(targetNumber) || targetNumber;
          let text = `🚦 *LIMIT USER +${resolved}*\n━━━━━━━━━━━━━━━━━━━━━\n`;
          for (const cmd of Object.keys(COMMAND_LIMITS)) {
            const { used, limit: effLimit } = getUsageFor(resolved, cmd);
            const remaining = Math.max(0, effLimit - used);
            const icon = remaining === 0 ? '🔴' : remaining <= effLimit / 3 ? '🟡' : '🟢';
            text += `${icon} \`${prefix}${cmd}\` — ${used}/${effLimit}\n`;
          }
          const bonus = getLimitBonus(resolved);
          text += `━━━━━━━━━━━━━━━━━━━━━\n`;
          text += `📦 Bonus: *+${bonus}* per fitur\n`;
          text += `♻️ Reset otomatis pukul 00:00 WIB`;
          await sock.sendMessage(
            from,
            { text, ...(mentionedJids[0] ? { mentions: [mentionedJids[0]] } : {}) },
            { quoted: parsed.rawMessage }
          );
          return true;
        }

        let text = `🚦 *LIMIT HARIAN ANDA*\n━━━━━━━━━━━━━━━━━━━━━\n`;
        for (const cmd of Object.keys(COMMAND_LIMITS)) {
          const { used, limit } = getUsage(sender, cmd);
          const remaining = Math.max(0, limit - used);
          const icon = remaining === 0 ? '🔴' : remaining <= limit / 3 ? '🟡' : '🟢';
          text += `${icon} \`${prefix}${cmd}\` — ${used}/${limit}\n`;
        }
        const myBonus = getLimitBonus(resolveLimitNumber(sender));
        text += `━━━━━━━━━━━━━━━━━━━━━\n`;
        text += `📦 Bonus: *+${myBonus}* per fitur\n`;
        text += `♻️ Reset otomatis pukul 00:00 WIB\n`;
        text += `👑 Butuh akses lebih? Hubungi owner untuk jadi *Admin Bot*.`;

        await sock.sendMessage(from, { text }, { quoted: parsed.rawMessage });
        return true;
      }

      // -------------------------------------------------------------------
      // ADDLIMIT — beri bonus limit harian ke user (khusus owner & admin bot)
      // -------------------------------------------------------------------
      case 'addlimit': {
        if (!isAdminRole(sender)) {
          await sock.sendMessage(from, { text: '❌ Fitur ini khusus Owner & Admin Bot!' }, { quoted: parsed.rawMessage });
          return true;
        }

        let targetNumber = '';
        let amount = 0;
        let mentionJid: string | undefined;

        if (mentionedJids.length > 0) {
          targetNumber = extractNumber(mentionedJids[0]);
          mentionJid = mentionedJids[0];
          amount = parseInt(args.find((a) => /^-?\d+$/.test(a)) || '0', 10);
        } else {
          const parsedArgs = args.filter((a) => /^-?\d+$/.test(a));
          const rest = args.filter((a) => !/^-?\d+$/.test(a) && a.trim());
          amount = parseInt(parsedArgs[0] || '0', 10);
          if (rest.length > 0) {
            let cleaned = rest[0].replace(/[^0-9]/g, '');
            if (cleaned.startsWith('0')) cleaned = '62' + cleaned.slice(1);
            targetNumber = cleaned;
          }
        }

        if (targetNumber) {
          targetNumber = getPhoneForLid(targetNumber) || targetNumber;
        }

        if (!targetNumber) {
          targetNumber = resolveLimitNumber(sender);
        }

        if (!amount || !targetNumber) {
          await sock.sendMessage(
            from,
            { text: `⚠️ Format: \`${prefix}addlimit <nomor/@user> <jumlah>\`\nContoh:\n▸ \`${prefix}addlimit 62812xxxx 20\`\n▸ \`${prefix}addlimit @user 10\`\n\n💡 Tanpa target: bonus untuk diri sendiri.\n💡 Gunakan angka negatif untuk mengurangi bonus.` },
            { quoted: parsed.rawMessage }
          );
          return true;
        }

        const newBonus = addLimit(targetNumber, amount);
        const replyJid = mentionJid || formatUserJid(targetNumber);

        await sock.sendMessage(
          from,
          {
            text:
              `🚦 *LIMIT DITAMBAHKAN*\n━━━━━━━━━━━━━━━━━━━━━\n` +
              `👤 User: @${extractNumber(replyJid)}\n` +
              `➕ Perubahan: *${amount > 0 ? '+' : ''}${amount}*\n` +
              `📦 Total bonus hari ini: *+${newBonus}* per fitur\n` +
              `⏳ Hangus saat reset harian (00:00 WIB)\n\n` +
              `_Bonus berlaku untuk semua fitur publik dengan limit._`,
            mentions: [replyJid],
          },
          { quoted: parsed.rawMessage }
        );
        return true;
      }

      // -------------------------------------------------------------------
      // ADMIN BOT — kelola nomor admin (khusus owner)
      // -------------------------------------------------------------------
      case 'addadmin': {
        if (!senderIsOwner) {
          await sock.sendMessage(from, { text: '❌ Perintah ini khusus *Owner*!' }, { quoted: parsed.rawMessage });
          return true;
        }

        const target = (mentionedJids[0] ? extractNumber(mentionedJids[0]) : args[0]) || '';
        const number = target.replace(/[^0-9]/g, '').replace(/^0/, '62');
        if (!number) {
          await sock.sendMessage(
            from,
            { text: `⚠️ Format: \`${prefix}addadmin 62812xxxx\` atau tag user: \`${prefix}addadmin @user\`` },
            { quoted: parsed.rawMessage }
          );
          return true;
        }

        if (isOwner(`${number}@s.whatsapp.net`)) {
          await sock.sendMessage(from, { text: 'ℹ️ Nomor tersebut sudah menjadi Owner.' }, { quoted: parsed.rawMessage });
          return true;
        }

        if (!db.settings.adminNumbers) db.settings.adminNumbers = [];
        if (db.settings.adminNumbers.includes(number)) {
          await sock.sendMessage(from, { text: `ℹ️ *+${number}* sudah terdaftar sebagai Admin Bot.` }, { quoted: parsed.rawMessage });
          return true;
        }

        db.settings.adminNumbers.push(number);
        db.save();
        await sock.sendMessage(
          from,
          { text: `🛡️ *+${number}* sekarang menjadi *Admin Bot*!\n✅ Bisa memakai fitur pengaturan bot tanpa limit.` },
          { quoted: parsed.rawMessage }
        );
        return true;
      }

      case 'deladmin': {
        if (!senderIsOwner) {
          await sock.sendMessage(from, { text: '❌ Perintah ini khusus *Owner*!' }, { quoted: parsed.rawMessage });
          return true;
        }

        const target = (mentionedJids[0] ? extractNumber(mentionedJids[0]) : args[0]) || '';
        const number = target.replace(/[^0-9]/g, '').replace(/^0/, '62');
        if (!number) {
          await sock.sendMessage(
            from,
            { text: `⚠️ Format: \`${prefix}deladmin 62812xxxx\` atau tag user: \`${prefix}deladmin @user\`` },
            { quoted: parsed.rawMessage }
          );
          return true;
        }

        if (!db.settings.adminNumbers?.includes(number)) {
          await sock.sendMessage(from, { text: `⚠️ *+${number}* bukan Admin Bot.` }, { quoted: parsed.rawMessage });
          return true;
        }

        db.settings.adminNumbers = db.settings.adminNumbers.filter((n) => n !== number);
        db.save();
        await sock.sendMessage(from, { text: `✅ *+${number}* dicabut dari Admin Bot. Kembali jadi user biasa (dengan limit).` }, { quoted: parsed.rawMessage });
        return true;
      }

      case 'listadmin': {
        const admins = getAllAdminNumbers();
        let text = `🛡️ *DAFTAR ADMIN BOT*\n━━━━━━━━━━━━━━━━━━━━━\n`;
        db.settings.ownerNumbers.filter(Boolean).forEach((n, i) => {
          text += `👑 ${i + 1}. +${n.replace(/[^0-9]/g, '')} (Owner)\n`;
        });
        if (admins.length === 0) {
          text += `_Belum ada Admin Bot tambahan._\n💡 Owner tambah dengan: \`${prefix}addadmin <nomor>\``;
        } else {
          admins.forEach((n, i) => {
            text += `🛡️ ${i + 1}. +${n}\n`;
          });
        }
        await sock.sendMessage(from, { text }, { quoted: parsed.rawMessage });
        return true;
      }

      // -------------------------------------------------------------------
      // MENFESS IG — kirim pesan anonim sebagai foto chat ke nomor tujuan
      // -------------------------------------------------------------------
      case 'menfesig':
      case 'menfessig':
      case 'igmenfess':
      case 'menfes': {
        if (isGroup) {
          await sock.sendMessage(from, { text: '⚠️ Fitur menfess IG hanya bisa dipakai di chat pribadi dengan bot!' }, { quoted: parsed.rawMessage });
          return true;
        }

        const targetJid = menfessIgTargetJid();
        if (!targetJid) {
          await sock.sendMessage(
            from,
            { text: `⚙️ Nomor tujuan menfess IG belum diatur.\nOwner bisa atur dengan:\n▸ \`${prefix}setmenfessig <nomor>\`\n▸ atau env \`MENFESS_IG_TARGET\`` },
            { quoted: parsed.rawMessage }
          );
          return true;
        }

        const mfIgText = argText.trim();
        if (!mfIgText) {
          await sock.sendMessage(
            from,
            { text: `⚠️ Format: \`${prefix}menfesig <pesan>\`\nContoh: \`${prefix}menfesig hai kak, semoga harimu seindah senyummu :)\`\n\n${menfessIgGuideText(prefix)}` },
            { quoted: parsed.rawMessage }
          );
          return true;
        }
        if (mfIgText.length > 700) {
          await sock.sendMessage(from, { text: `❌ Pesan terlalu panjang (maks 700 karakter, punyamu ${mfIgText.length}).` }, { quoted: parsed.rawMessage });
          return true;
        }

        const senderNumIg = resolveLimitNumber(sender);
        const igName = `Anonim ${String((senderNumIg || '').slice(-3) || '000')}`;

        try {
          const quoteJpeg = await renderChatQuoteImage({ message: mfIgText, senderName: igName });
          await sock.sendMessage(targetJid, {
            image: quoteJpeg,
            caption: `💌 *MENFESS IG* — pesan anonim dari pengguna bot`,
          });

          await sock.sendMessage(
            from,
            { text: `✅ *Menfess terkirim!*\n💌 Pesanmu sudah sampai ke tujuan dalam bentuk foto chat anonim.\n🔒 Menfess bersifat satu arah — tidak bisa dibalas.` },
            { quoted: parsed.rawMessage }
          );
        } catch (err: any) {
          logger.warn({ err: err.message }, 'Gagal render foto menfess IG');
          await sock.sendMessage(from, { text: '❌ Gagal membuat foto menfess. Coba lagi atau hubungi admin.' }, { quoted: parsed.rawMessage });
        }
        return true;
      }

      // -------------------------------------------------------------------
      // LAPOR — laporan user ke pengelola, format TEKS berformat + ID
      // -------------------------------------------------------------------
      case 'lapor': {
        const laporText = argText.trim();
        if (!laporText) {
          await sock.sendMessage(
            from,
            { text: `⚠️ Format: \`${prefix}lapor <kategori> | <isi laporan>\`\nKategori: ${Object.keys(LAPOR_CATEGORIES).join(', ')}\nContoh: \`${prefix}lapor bug | fitur stiker error saat kirim video\`\n\n${laporGuideText(prefix)}` },
            { quoted: parsed.rawMessage }
          );
          return true;
        }
        if (laporText.length > 600) {
          await sock.sendMessage(from, { text: `❌ Isi laporan terlalu panjang (maks 600 karakter, punyamu ${laporText.length}).` }, { quoted: parsed.rawMessage });
          return true;
        }

        // Parsing: "kategori | isi" (tanpa kategori = Lainnya)
        const laporParts = laporText.split('|');
        const laporIsi = (laporParts.length >= 2 ? laporParts.slice(1).join('|') : laporText).trim();
        const laporCatRaw = laporParts.length >= 2 ? laporParts[0].trim() : '';
        const { category: laporCategory } = resolveLaporCategory(laporCatRaw);

        if (!laporIsi) {
          await sock.sendMessage(from, { text: `❌ Isi laporan kosong.\nFormat: \`${prefix}lapor <kategori> | <isi laporan>\`` }, { quoted: parsed.rawMessage });
          return true;
        }

        const reporterNum = resolveLimitNumber(sender);
        const laporId = saveLaporReport(reporterNum, laporCategory, laporIsi);
        const laporTarget = laporTargetJid() || (getAllAdminNumbers()[0] ? toJid(getAllAdminNumbers()[0]) : from);

        // Nomor pelapor TIDAK ditampilkan di pesan (privasi) — reporterNum
        // tetap disimpan via saveLaporReport untuk routing balasan.

        await sendWithTyping(
          sock,
          laporTarget,
          { text: buildLaporText(laporId, laporCategory, laporIsi) },
          { quoted: parsed.rawMessage },
          1400
        );

        await sock.sendMessage(
          from,
          { text: buildLaporConfirmation(laporId, laporCategory) },
          { quoted: parsed.rawMessage }
        );
        return true;
      }

      // -------------------------------------------------------------------
      // MANAJEMEN MENFESS IG & LAPOR (owner/admin bot)
      // -------------------------------------------------------------------
      case 'setmenfessig': {
        // Hanya OWNER yang boleh mengatur nomor tujuan menfess IG
        if (!senderIsOwner) {
          await sock.sendMessage(from, { text: '❌ Fitur ini khusus *Owner Bot*!' }, { quoted: parsed.rawMessage });
          return true;
        }

        const rawNum = args[0] || '';
        let cleanNum = rawNum.replace(/[^0-9]/g, '');
        if (cleanNum.startsWith('0')) cleanNum = '62' + cleanNum.slice(1);
        if (!cleanNum || cleanNum.length < 8) {
          const current = getMenfessIgTargets().join(', ') || '(belum diatur)';
          await sock.sendMessage(
            from,
            { text: `⚠️ Format: \`${prefix}setmenfessig <nomor>\`\nContoh: \`${prefix}setmenfessig 6281234567890\`\n\n📌 Nomor tujuan saat ini: ${current}` },
            { quoted: parsed.rawMessage }
          );
          return true;
        }

        db.settings.menfessIgTarget = [cleanNum];
        db.save();
        await sock.sendMessage(
          from,
          { text: `✅ Nomor tujuan menfess IG diatur ke *+${cleanNum}*.\nSemua menfess (.menfesig) akan dikirim ke nomor ini.\n📌 Laporan (.lapor) ikut ke sini selama \`${prefix}setlapor\` belum diatur.` },
          { quoted: parsed.rawMessage }
        );
        return true;
      }

      case 'setlapor': {
        // Hanya OWNER yang boleh mengatur nomor tujuan laporan
        if (!senderIsOwner) {
          await sock.sendMessage(from, { text: '❌ Fitur ini khusus *Owner Bot*!' }, { quoted: parsed.rawMessage });
          return true;
        }

        const rawNumLapor = args[0] || '';
        let cleanNumLapor = rawNumLapor.replace(/[^0-9]/g, '');
        if (cleanNumLapor.startsWith('0')) cleanNumLapor = '62' + cleanNumLapor.slice(1);
        if (!cleanNumLapor || cleanNumLapor.length < 8) {
          const currentLapor = getLaporTargets().join(', ') || '(belum diatur — ikut nomor menfess IG)';
          await sock.sendMessage(
            from,
            { text: `⚠️ Format: \`${prefix}setlapor <nomor>\`\nContoh: \`${prefix}setlapor 6281234567890\`\n\n📌 Nomor tujuan lapor saat ini: ${currentLapor}` },
            { quoted: parsed.rawMessage }
          );
          return true;
        }

        db.settings.laporTarget = [cleanNumLapor];
        db.save();
        await sock.sendMessage(
          from,
          { text: `✅ Nomor tujuan lapor diatur ke *+${cleanNumLapor}*.\nSemua laporan (.lapor) akan dikirim ke nomor ini.` },
          { quoted: parsed.rawMessage }
        );
        return true;
      }

      case 'listlapor': {
        const limitN = Math.min(Math.max(parseInt(args[0] || '10', 10) || 10, 1), 25);
        const reports = listLaporReports(limitN);
        if (reports.length === 0) {
          await sock.sendMessage(from, { text: 'ℹ️ Belum ada laporan masuk.' }, { quoted: parsed.rawMessage });
          return true;
        }
        const statusIcon: Record<string, string> = { baru: '🆕', diproses: '⏳', selesai: '✅' };
        const listText = reports
          .map((r, i) => {
            const excerpt = r.message.length > 60 ? `${r.message.slice(0, 60)}…` : r.message;
            return `${i + 1}. ${statusIcon[r.status] || '❔'} *${r.id}* [${r.category}]\n   “${excerpt}”\n   _${r.createdAt.slice(0, 10)}_`;
          })
          .join('\n\n');
        await sock.sendMessage(
          from,
          { text: `🛡️ *DAFTAR LAPORAN (${reports.length} terbaru)*\n\n${listText}\n\n▸ Balas: \`${prefix}balaslapor <id> <balasan>\`` },
          { quoted: parsed.rawMessage }
        );
        return true;
      }

      case 'balaslapor': {
        const laporId = (args[0] || '').toUpperCase();
        const laporReply = args.slice(1).join(' ').trim();
        if (!laporId || !laporReply) {
          await sock.sendMessage(
            from,
            { text: `⚠️ Format: \`${prefix}balaslapor <id> <balasan>\`\nContoh: \`${prefix}balaslapor LP-7F3K2M Terima kasih, bugnya sudah kami perbaiki!\`` },
            { quoted: parsed.rawMessage }
          );
          return true;
        }

        const report = getLaporReport(laporId);
        if (!report) {
          await sock.sendMessage(from, { text: `❌ Laporan *${laporId}* tidak ditemukan.\nCek daftar: \`${prefix}listlapor\`` }, { quoted: parsed.rawMessage });
          return true;
        }

        try {
          // Varianta update status saja: .balaslapor <id> selesai|<catatan opsional>
          const statusMatch = laporReply.match(/^(diproses|selesai)\s*\|\s*([\s\S]*)$/i);
          if (statusMatch) {
            const newStatus = statusMatch[1].toLowerCase() as 'diproses' | 'selesai';
            const note = statusMatch[2].trim();
            if (note) {
              await sendWithTyping(sock, toJid(report.reporter), { text: buildLaporReplyText(report.id, note) });
            }
            updateLaporStatus(report.id, newStatus);
            await sock.sendMessage(
              from,
              { text: note
                ? `✅ Balasan untuk *${report.id}* terkirim ke pelapor.\n📌 Status laporan: *${newStatus}*`
                : `📌 Status laporan *${report.id}* diubah menjadi *${newStatus}*.\n🛡️ Kirim balasan: \`${prefix}balaslapor ${report.id} <balasan>\`` },
              { quoted: parsed.rawMessage }
            );
            return true;
          }

          await sendWithTyping(
            sock,
            toJid(report.reporter),
            { text: buildLaporReplyText(report.id, laporReply) }
          );
          updateLaporStatus(report.id, 'diproses');
          await sock.sendMessage(
            from,
            { text: `✅ Balasan untuk *${report.id}* terkirim ke pelapor.\n📌 Status laporan: *diproses*\n🛡️ Tandai selesai: \`${prefix}balaslapor ${report.id} selesai|<catatan>\`` },
            { quoted: parsed.rawMessage }
          );
        } catch (err: any) {
          logger.warn({ err: err.message }, 'Gagal kirim balasan lapor');
          await sock.sendMessage(from, { text: '❌ Gagal mengirim balasan ke pelapor. Mungkin nomornya tidak terdaftar WA.' }, { quoted: parsed.rawMessage });
        }
        return true;
      }

      case 'dellapor': {
        const delId = (args[0] || '').toUpperCase();
        if (!delId || !db.laporReports[delId]) {
          await sock.sendMessage(from, { text: `❌ Laporan *${delId || '(kosong)'}* tidak ditemukan.\nCek daftar: \`${prefix}listlapor\`` }, { quoted: parsed.rawMessage });
          return true;
        }
        delete db.laporReports[delId];
        db.save();
        await sock.sendMessage(from, { text: `🗑️ Laporan *${delId}* dihapus.` }, { quoted: parsed.rawMessage });
        return true;
      }

      // -------------------------------------------------------------------
      // MENFESS / CONFESS — chat anonim perantara bot antar 2 nomor
      // -------------------------------------------------------------------
      case 'menfess':
      case 'confess': {
        if (isGroup) {
          await sock.sendMessage(from, { text: '⚠️ Fitur menfess hanya bisa dipakai di chat pribadi dengan bot!' }, { quoted: parsed.rawMessage });
          return true;
        }

        const myNum = resolveLimitNumber(sender);
        const existing = findMenfessSession(myNum, sender);
        if (existing) {
          const statusText = existing.status === 'active'
            ? 'sedang berjalan'
            : 'menunggu acc';
          await sock.sendMessage(
            from,
            { text: `ℹ️ Anda sudah punya sesi menfess (${statusText}) dengan +${existing.partner}.\n▸ Lanjut chat: kirim pesan biasa lewat bot\n▸ Akhiri: \`${prefix}endsession\`` },
            { quoted: parsed.rawMessage }
          );
          return true;
        }

        enableMenfess(resolveLimitNumber(sender));

        await sock.sendMessage(
          from,
          { text:
            `╭───「 💌 *MENFESS / CONFESS AKTIF* 」───\n` +
            `│ 🤖 Bot jadi perantara chat anonim\n` +
            `│ 🔒 Nomor Anda dirahasiakan\n` +
            `╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
            `📖 Cara mulai (pilih salah satu):\n` +
            `▸ Chat biasa yang menyebut nomor tujuan, contoh:\n` +
            `  _"hai, boleh kenalan? 62812xxxxxxx"_\n` +
            `▸ Atau command: \`${prefix}kirim <pesan> | <nomor>\`\n` +
            `    Contoh: \`${prefix}kirim Hai, boleh kenalan? | 6281234567890\`\n\n` +
            `▸ Jika pihak lain acc dengan \`${prefix}terima\`, kalian bisa chat lewat bot\n` +
            `▸ Akhiri sesi kapan saja: \`${prefix}endsession\`` },
          { quoted: parsed.rawMessage }
        );
        return true;
      }

      case 'kirim': {
        if (isGroup) {
          await sock.sendMessage(from, { text: '⚠️ Fitur menfess hanya bisa dipakai di chat pribadi dengan bot!' }, { quoted: parsed.rawMessage });
          return true;
        }

        const parts = argText.split('|').map((s) => s.trim());
        const pesan = parts[0] || '';
        const rawTarget = parts[1] || '';

        if (!pesan || !rawTarget) {
          let formatHint = `⚠️ Format: \`${prefix}kirim <pesan> | <nomor>\`\nContoh: \`${prefix}kirim Hai, aku pengen kenalan | 62812xxxxxxx\``;
          // Pesan ada tapi tanda "|" atau nomornya hilang -> beri pemberitahuan spesifik
          if (pesan && !rawTarget) {
            formatHint += `\n\n💡 Pesan Anda: “${pesan}”\nNomor tujuan belum ada. Tambahkan di akhir, dipisah tanda *|\n▸ Contoh: \`${prefix}kirim ${pesan} | 62812xxxxxxx\``;
          }
          await sock.sendMessage(
            from,
            { text: formatHint },
            { quoted: parsed.rawMessage }
          );
          return true;
        }

        const initiatorNum = resolveLimitNumber(sender);
        const targetNum = normalizeMenfessNumber(rawTarget);

        if (targetNum === initiatorNum) {
          await sock.sendMessage(from, { text: '❌ Tidak bisa mengirim menfess ke nomor sendiri!' }, { quoted: parsed.rawMessage });
          return true;
        }

        const created = createMenfessInvite(initiatorNum, targetNum);
        if (!created) {
          await sock.sendMessage(
            from,
            { text: `❌ Gagal: Anda atau +${targetNum} sedang terlibat sesi menfess lain. Akhiri dulu dengan \`${prefix}endsession\`.` },
            { quoted: parsed.rawMessage }
          );
          return true;
        }

        // Simpan JID kanonik target agar lookup @lid tetap cocok
        await resolveAndStoreJid(sock, initiatorNum, targetNum);

        // Kirim undangan ke JID kanonik target (bukan toJid() buta)
        const targetRec = getMenfessSession(targetNum);
        const inviteJid = targetRec?.selfJid || toJid(targetNum);

        await sock.sendMessage(
          from,
          { text: `✅ Undangan menfess terkirim ke +${targetNum}!\n💌 Pesan Anda:\n“${pesan}”\n\n⏳ Menunggu pihak lain acc dengan \`${prefix}terima\`...` },
          { quoted: parsed.rawMessage }
        );

        await sendWithTyping(
          sock,
          inviteJid,
          { text:
            `╭───「 💌 *MENFESS / CONFESS* 」───\n` +
            `│ 🤖 Pesan ini dikirim lewat *PERANTARA BOT*\n` +
            `│ 🔒 Identitas pengirim dirahasiakan\n` +
            `╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
            `Seseorang ingin mengobrol dengan Anda tanpa tukar nomor langsung.\n\n` +
            `💌 *Isi pesan:*\n` +
            `❝ ${pesan} ❞\n\n` +
            `❓ *Apakah Anda ingin lanjut chatan?*\n` +
            `▸ Acc: ketik \`${prefix}terima\`\n` +
            `▸ Abaikan/tolak: cukup diabaikan (pengirim tidak diberi tahu)\n\n` +
            `_Jika acc, Anda & pengirim bisa chat lewat bot sampai salah satu mengirim \`${prefix}endsession\`._` }
        );
        return true;
      }

      case 'terima': {
        if (isGroup) return true;

        const myNum = resolveLimitNumber(sender);
        const mfSession = findMenfessSession(myNum, sender);
        const result = acceptMenfess(mfSession, sender);
        if (result.error === 'initiator') {
          // User1 (pengirim) mencoba acc undangannya sendiri -> tolak
          await sock.sendMessage(
            from,
            { text: `❌ Anda adalah *pengirim* menfess ini — undangan hanya bisa di-acc oleh penerima.\n⏳ Menunggu +${mfSession!.partner} acc dengan \`${prefix}terima\`.` },
            { quoted: parsed.rawMessage }
          );
          return true;
        }
        const accepted = result.session;
        if (!accepted) {
          await sock.sendMessage(
            from,
            { text: `⚠️ Tidak ada undangan menfess yang menunggu acc untuk nomor Anda.\n💡 Pengirim harus kirim dulu: \`${prefix}kirim <pesan> | <nomor_anda>\`` },
            { quoted: parsed.rawMessage }
          );
          return true;
        }

        await sock.sendMessage(
          from,
          { text: `✅ *CHAT DITERIMA!* Anda sekarang bisa chat lewat bot dengan dia.\n▸ Kirim pesan biasa (tanpa command) untuk diteruskan\n▸ Akhiri sesi: \`${prefix}endsession\`\n\n🔒 Selama sesi aktif, fitur bot lain nonaktif untuk nomor Anda.` },
          { quoted: parsed.rawMessage }
        );

        await sendWithTyping(
          sock,
          getMessageJidFor(accepted),
          { text:
            `🎉 *CHAT DITERIMA!*\n\n` +
            `Dia telah acc undangan menfess Anda.\nAnda sekarang bisa chatan lewat bot — kirim pesan biasa (tanpa command) untuk diteruskan.\n▸ Akhiri sesi: \`${prefix}endsession\`` }
        );
        return true;
      }

      case 'endsession': {
        if (isGroup) return true;

        const myNum = resolveLimitNumber(sender);
        const mfSession = findMenfessSession(myNum, sender);
        const partnerNum = mfSession ? endMenfessSession(mfSession) : undefined;
        if (!partnerNum) {
          await sock.sendMessage(from, { text: '⚠️ Anda tidak sedang dalam sesi menfess.' }, { quoted: parsed.rawMessage });
          return true;
        }

        await sock.sendMessage(
          from,
          { text: `🚪 *SESI MENFESS BERAKHIR.* Semua catatan chat Anda dihapus dari bot. Fitur bot sudah aktif kembali untuk nomor Anda.` },
          { quoted: parsed.rawMessage }
        );
        await sendWithTyping(
          sock,
          getMessageJidFor(mfSession!),
          { text:
            `╭───「 🚪 *MENFESS / CONFESS* 」───\n` +
            `│ 🚪 SESI CHAT BERAKHIR\n` +
            `│ 🗑️ Semua catatan dihapus dari bot\n` +
            `╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
            `Sesi diakhiri salah satu pihak. Fitur bot sudah aktif kembali untuk nomor Anda.` }
        );
        return true;
      }

      case 'stopmenfess': {
        // Keluar dari fitur menfess: batalkan undangan pending ATAU akhiri sesi aktif.
        if (isGroup) {
          await sock.sendMessage(from, { text: '⚠️ Fitur menfess hanya bisa dipakai di chat pribadi dengan bot!' }, { quoted: parsed.rawMessage });
          return true;
        }

        const myNum = resolveLimitNumber(sender);
        const mfSession = findMenfessSession(myNum, sender);

        if (!mfSession) {
          // Tidak terlibat sesi — matikan juga mode menfess yang masih nyala
          const hadEnabled = isMenfessEnabled(myNum);
          clearMenfessEnabled(myNum);
          await sock.sendMessage(
            from,
            { text: hadEnabled
              ? `✅ *Mode menfess dimatikan.*\nFitur bot sudah aktif kembali untuk nomor Anda.`
              : `ℹ️ Anda tidak sedang dalam sesi/mode menfess.` },
            { quoted: parsed.rawMessage }
          );
          return true;
        }

        const { partner, wasActive } = exitMenfess(mfSession);

        await sock.sendMessage(
          from,
          { text: wasActive
            ? `🚪 *SESI MENFESS BERAKHIR.* Semua catatan chat Anda dihapus dari bot. Fitur bot sudah aktif kembali untuk nomor Anda.`
            : `🚪 *Undangan menfess dibatalkan.* Fitur bot sudah aktif kembali untuk nomor Anda.` },
          { quoted: parsed.rawMessage }
        );

        // Beri tahu partner hanya jika sesi sebelumnya aktif (chat benar-benar berjalan)
        if (wasActive) {
          try {
            await sendWithTyping(
              sock,
              getMessageJidFor(mfSession),
              { text:
                `╭───「 🚪 *MENFESS / CONFESS* 」───\n` +
                `│ 🚪 SESI CHAT BERAKHIR\n` +
                `│ 🗑️ Semua catatan dihapus dari bot\n` +
                `╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                `Sesi diakhiri salah satu pihak. Fitur bot sudah aktif kembali untuk nomor Anda.` }
            );
          } catch (err: any) {
            logger.warn({ err: err.message }, 'Gagal kirim notifikasi stopmenfess ke partner');
          }
        }
        return true;
      }

      default: {
        // Command belum dikenal: cek kemungkinan salah ketik command menfess
        // (.kirm, .terimas, .menfes, atau nama lama .send/.accmenfess)
        // ATAU command menfess yang salah ketik sekalipun cocok fitur lain.
        const typo = detectMenfessTypo(command);
        if (typo) {
          const intro = typo.renamed
            ? `ℹ️ Command \`${prefix}${command}\` sudah diganti menjadi \`${prefix}${typo.command}\`.`
            : `❓ Command \`${prefix}${command}\` tidak dikenal. Mungkin maksud Anda \`${prefix}${typo.command}\`?`;
          await sock.sendMessage(
            from,
            { text: menfessGuideText(prefix, intro) },
            { quoted: parsed.rawMessage }
          );
          return true;
        }
        return false;
      }
    }
  }
}
