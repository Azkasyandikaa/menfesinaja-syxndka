import { WASocket, WAMessage, downloadMediaMessage } from '@whiskeysockets/baileys';
import { parseMessage } from '../utils/parser.js';
import { db } from '../database/store.js';
import { CommandHandler } from './command.handler.js';
import { isRateLimited } from '../middleware/rate-limit.middleware.js';
import { isOwner } from '../middleware/owner.middleware.js';
import { checkCommandAccess, consumeLimit, getRole } from '../middleware/access.middleware.js';
import { extractNumber } from '../utils/jid.js';
import { sendWithTyping } from '../utils/chat-actions.js';
import { logger } from '../utils/logger.js';
import { syncGroupLidMappings, setLidMapping } from '../utils/lid-map.js';
import { getMenfessSession, findMenfessSession, isMenfessEnabled, createMenfessInvite, normalizeMenfessNumber, resolveAndStoreJid, claimPendingInviteByJid, getMessageJidFor, matchBareMenfessCommand, detectMenfessTypo, menfessGuideText } from '../services/menfess.service.js';
import { toJid } from '../utils/jid.js';
import { resolveLimitNumber } from '../middleware/access.middleware.js';

export class MessageHandler {
  public static async handleMessage(sock: WASocket, msg: WAMessage): Promise<void> {
    try {
      // Ignore broadcast or status messages
      if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

      const parsed = parseMessage(msg, db.settings.prefix);
      if (!parsed) return;

      const { from, sender, senderName, body, isGroup, command, mentionedJids } = parsed;

      // ── Capture LID <-> nomor HP dari remoteJidAlt (Baileys 7) ──
      // Pesan dari user yang chat bot lewat JID @lid membawa remoteJidAlt
      // berisi JID nomor HP ASLI pengirim. Tanpa mapping ini,
      // resolveLimitNumber() tidak bisa mengenali nomor user2 dan sesi
      // menfess-nya tidak pernah ketemu ("Tidak ada undangan menfess").
      try {
        const altJid = (msg.key as any).remoteJidAlt;
        if (altJid && msg.key.remoteJid?.endsWith('@lid')) {
          setLidMapping(msg.key.remoteJid, altJid);
        }
      } catch { /* abaikan */ }
      const senderIsOwner = isOwner(sender);

      // Pesan dari diri sendiri (fromMe) ada 2 kemungkinan:
      // 1. Echo pesan yang dikirim bot -> abaikan (mencegah bot membalas dirinya sendiri)
      // 2. Perintah prefix yang diketik owner dari nomor yang SAMA dengan bot
      //    (mode self-bot / pairing nomor sendiri) -> harus diproses!
      //    Tanpa ini, semua command (.menu, .status, dst) tidak pernah merespon
      //    ketika bot dipairing dengan nomor owner sendiri.
      const isSelfCommand = msg.key.fromMe && !!command && senderIsOwner;
      if (msg.key.fromMe && !isSelfCommand) return;

      logger.info({ from, sender, senderIsOwner, isGroup, command, body }, '📩 Pesan masuk');

      // Centang biru (read receipt)
      try {
        await sock.readMessages([{
          remoteJid: from,
          id: msg.key.id,
          participant: isGroup ? msg.key.participant : undefined,
          fromMe: msg.key.fromMe,
        }]);
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Gagal mengirim read receipt (centang biru)');
      }

      // Sinkronkan mapping LID <-> nomor HP anggota grup agar cek role & limit
      // per nomor tetap akurat (pemakaian grup & chat pribadi dihitung sama).
      if (isGroup) {
        try {
          const meta = await sock.groupMetadata(from);
          syncGroupLidMappings(from, meta.participants as any);
        } catch { /* abaikan jika metadata gagal diambil */ }
      }

      // ── MODE MENFESS / CONFESS (per nomor) ──
      // Selama sesi menfess aktif, fitur bot lain dimatikan khusus untuk
      // nomor yang terlibat; pesan biasa diteruskan ke partner via bot.
      const mfCommands = ['menfess', 'confess', 'kirim', 'terima', 'endsession', 'stopmenfess', 'menfesig', 'menfessig', 'igmenfess', 'menfes', 'lapor'];
      const mfPrefix = db.settings.prefix;
      if (!isGroup && sender) {
        // Bind undangan pending ke JID pengirim (@lid atau @s.whatsapp.net)
        // SEBELUM resolveLimitNumber — fallback jika mapping remoteJidAlt
        // tidak tersedia. Untuk @lid, nomor HP harus sudah diketahui.
        try {
          claimPendingInviteByJid(sender);
        } catch { /* abaikan */ }

        const myNumber = resolveLimitNumber(sender);
        const mfSession = findMenfessSession(myNumber, sender);
        logger.debug(
          { sender, myNumber, found: !!mfSession, status: mfSession?.status, role: mfSession?.role, cmd: command },
          '🔍 Menfess lookup'
        );

        // Mode menfess aktif tapi belum ada partner: chat biasa yang
        // menyebut nomor otomatis menjadi undangan (tanpa perlu .send)
        if (!mfSession && !command && isMenfessEnabled(myNumber) && !msg.key.fromMe) {
          let targetNum = '';
          if (mentionedJids.length > 0) {
            targetNum = normalizeMenfessNumber(extractNumber(mentionedJids[0]));
          } else {
            const numMatch = body.match(/(\+?62|0)\d{8,13}/);
            if (numMatch) targetNum = normalizeMenfessNumber(numMatch[0]);
          }

          if (targetNum && targetNum !== myNumber) {
            // Buang nomor dari pesan -> sisanya jadi pesan menfess
            const pesan = body.replace(/(\+?62|0)\d{8,13}/g, '').replace(/\s{2,}/g, ' ').trim() || 'Hai, aku pengen kenalan :)';
            const created = createMenfessInvite(myNumber, targetNum);
            if (created) {
              await resolveAndStoreJid(sock, myNumber, targetNum);
              await sock.sendMessage(
                from,
                { text: `✅ Undangan menfess terkirim ke +${targetNum}!\n💌 Pesan Anda:\n“${pesan}”\n\n⏳ Menunggu partner acc dengan \`${mfPrefix}terima\`...` },
                { quoted: msg }
              );
              await sendWithTyping(
                sock,
                toJid(targetNum),
                { text:
                  `╭───「 💌 *MENFESS / CONFESS* 」───\n` +
                  `│ 🤖 Pesan ini dikirim lewat *PERANTARA BOT*\n` +
                  `│ 🔒 Identitas pengirim dirahasiakan\n` +
                  `╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                  `Seseorang ingin mengobrol dengan Anda tanpa tukar nomor langsung.\n\n` +
                  `💌 *Isi pesan:*\n` +
                  `❝ ${pesan} ❞\n\n` +
                  `❓ *Apakah Anda ingin lanjut chatan?*\n` +
                  `▸ Acc: ketik \`${mfPrefix}terima\`\n` +
                  `▸ Abaikan/tolak: cukup diabaikan (pengirim tidak diberi tahu)\n\n` +
                  `_Jika acc, Anda & pengirim bisa chat lewat bot sampai salah satu mengirim \`${mfPrefix}endsession\`._` }
              );
            } else {
              await sock.sendMessage(
                from,
                { text: `❌ Gagal: +${targetNum} sedang terlibat sesi menfess lain.` },
                { quoted: msg }
              );
            }
            return;
          }
          // Tidak ada nomor di chat -> biarkan jadi chat biasa
        }

        // Cek salah ketik command menfess (.kirm, .terimas, .menfes, atau
        // nama lama .send/.accmenfes/.accmenfess) -> beri pemberitahuan + panduan.
        // Hanya di chat pribadi, dan hanya jika tidak terlibat sesi aktif.
        if (!isGroup && !mfSession) {
          const typo = detectMenfessTypo(command);
          if (typo) {
            const intro = typo.renamed
              ? `ℹ️ Command \`${mfPrefix}${command}\` sudah diganti menjadi \`${mfPrefix}${typo.command}\`.`
              : `❓ Command \`${mfPrefix}${command}\` tidak dikenal. Mungkin maksud Anda \`${mfPrefix}${typo.command}\`?`;
            await sock.sendMessage(
              from,
              { text: menfessGuideText(mfPrefix, intro) },
              { quoted: msg }
            );
            return;
          }
        }

        if (mfSession) {
          if (command && !mfCommands.includes(command)) {
            // Nama lama (.send/.accmenfes) selama sesi -> beri tahu sudah diganti
            const renamedTypo = detectMenfessTypo(command);
            if (renamedTypo?.renamed) {
              await sock.sendMessage(
                from,
                { text: `ℹ️ Command \`${mfPrefix}${command}\` sudah diganti menjadi \`${mfPrefix}${renamedTypo.command}\`.` },
                { quoted: msg }
              );
              return;
            }
            // Blokir semua command lain selama terlibat sesi menfess
            await sock.sendMessage(
              from,
              { text: `🔒 Perintah \`${mfPrefix}${command}\` nonaktif selama sesi menfess berjalan.\n▸ Lanjut chat: kirim pesan/media biasa\n▸ Akhiri sesi: \`${mfPrefix}endsession\`\n▸ Keluar mode menfess: \`${mfPrefix}stopmenfess\`` },
              { quoted: msg }
            );
            return;
          }

          // Deteksi media (foto/video/audio/stiker/dokumen), termasuk yang dibungkus
          const rawMsgType = Object.keys(msg.message || {})[0] || '';
          const inner: any = (msg.message as any)?.[rawMsgType] || {};
          const innerType = rawMsgType === 'ephemeralMessage' || rawMsgType === 'viewOnceMessage'
            ? Object.keys(inner.message || {})[0] || ''
            : rawMsgType;
          const innerMsg = rawMsgType === 'ephemeralMessage' || rawMsgType === 'viewOnceMessage'
            ? inner.message?.[innerType]
            : inner;
          const MEDIA_KIND: Record<string, string> = {
            imageMessage: 'image',
            videoMessage: 'video',
            audioMessage: 'audio',
            stickerMessage: 'sticker',
            documentMessage: 'document',
          };
          const mediaKind = MEDIA_KIND[innerType] || '';
          const hasMedia = !!mediaKind && !msg.key.fromMe;

          if (!command && !msg.key.fromMe && (body || hasMedia)) {
            if (mfSession.status === 'active') {
              try {
                const partnerJid = getMessageJidFor(mfSession);
                if (hasMedia) {
                  // Unduh -> langsung teruskan ke partner -> buffer tidak disimpan
                  const buffer: Buffer = await downloadMediaMessage(msg, 'buffer', {});
                  const content: any = { [mediaKind]: buffer };
                  if (innerMsg?.mimetype) content.mimetype = innerMsg.mimetype;
                  if (mediaKind === 'image' || mediaKind === 'video') {
                    // Teruskan apa adanya: caption asli (tanpa header bot)
                    if (body) content.caption = body;
                    if (mediaKind === 'video') content.gifPlayback = innerMsg?.gifPlayback;
                  }
                  if (mediaKind === 'audio') content.ptt = innerMsg?.ptt ?? true;
                  if (mediaKind === 'document') {
                    content.fileName = innerMsg?.fileName || 'file';
                  }
                  await sock.sendMessage(partnerJid, content);
                } else {
                  // Relay pesan teks apa adanya (tanpa header, tanpa konfirmasi)
                  await sendWithTyping(sock, partnerJid, { text: body });
                }
              } catch (err: any) {
                logger.warn({ err: err.message }, 'Gagal merelay pesan menfess');
                await sock.sendMessage(from, { text: '❌ Gagal meneruskan pesan. Coba kirim ulang.' }, { quoted: msg });
              }
            } else if (mfSession.initiator === resolveLimitNumber(sender)) {
              await sock.sendMessage(from, { text: `⏳ Menunggu partner acc undangan menfess Anda...` }, { quoted: msg });
            } else {
              await sock.sendMessage(from, { text: `💌 Ada undangan menfess untuk Anda. Acc dengan \`${mfPrefix}terima\` untuk mulai chat.` }, { quoted: msg });
            }
            return;
          }
          // Command menfess -> lanjut diproses CommandHandler
        } else if (!mfSession && !command && !msg.key.fromMe) {
          // User mengetik command TANPA prefix (lupa titik), mis. "kirim hai | 628xx"
          // atau "terima" -> beri pemberitahuan + panduan, jangan dibiarkan tanpa respon.
          const bare = matchBareMenfessCommand(body);
          if (bare) {
            const intro = bare === 'kirim'
              ? `⚠️ Sepertinya Anda mau kirim menfess, tapi *tanpa tanda titik (.)* di awal.`
              : `⚠️ Sepertinya Anda mau pakai fitur menfess, tapi *tanpa tanda titik (.)* di awal.`;
            const tip = bare === 'kirim'
              ? `Perintah yang benar: \`${mfPrefix}kirim <pesan> | <nomor>\``
              : `Perintah yang benar: \`${mfPrefix}${bare}\``;
            await sock.sendMessage(
              from,
              { text: `${intro}\n${tip}\n\n${menfessGuideText(mfPrefix, '📖 Cara pakai menfess:')}` },
              { quoted: msg }
            );
            return;
          }
        }
      }

      if (!isGroup && !msg.key.fromMe && sender && !db.greetedUsers[sender]) {
        const hour = new Date().getHours();
        const greeting = hour >= 5 && hour < 11
          ? 'Selamat pagi'
          : hour < 15
            ? 'Selamat siang'
            : hour < 18
              ? 'Selamat sore'
              : 'Selamat malam';
        await sendWithTyping(sock, from, { text: `${greeting}, ${senderName}!!` }, { quoted: msg });
        db.greetedUsers[sender] = new Date().toISOString();
        db.save();
      }

      // Rate limiting (owner tidak dibatasi)
      if (!senderIsOwner && isRateLimited(sender)) return;

      // 1. Process Commands if prefix used
      // Hak akses berjenjang: owner (penuh) > admin bot (pengaturan) > user (publik + limit)
      if (command) {
        const access = checkCommandAccess(sender, command);
        if (!access.allowed) {
          logger.debug({ sender, command, reason: access.reason }, 'Command ditolak');
          if (access.message) {
            await sock.sendMessage(from, { text: access.message }, { quoted: msg });
          }
          return;
        }

        // User biasa: catat pemakaian fitur publik ke limit harian
        if (getRole(sender) === 'user' && access.used !== undefined) {
          consumeLimit(sender, command);
        }

        const handled = await CommandHandler.handleCommand(sock, parsed);
        if (handled) return;
      }

      return;
    } catch (err: any) {
      logger.error({ err: err.message }, 'Error in MessageHandler');
    }
  }
}
