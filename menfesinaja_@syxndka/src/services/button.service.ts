import { WASocket, generateWAMessageFromContent, proto } from '@whiskeysockets/baileys';

export interface ListRow {
  rowId: string;
  title: string;
  description?: string;
}

export interface ListSection {
  title: string;
  rows: ListRow[];
}

/**
 * Build a WhatsApp interactive "single_select" list message payload.
 *
 * PENTING (Baileys 6.7.x): payload ini TIDAK BISA dikirim lewat sock.sendMessage()
 * karena generateWAMessageContent tidak punya branch untuk interactiveMessage —
 * pesannya akan terkirim kosong/tidak valid. Gunakan sendInteractiveList() di bawah
 * yang memakai generateWAMessageFromContent + sock.relayMessage().
 */
export function buildInteractiveList(
  bodyText: string,
  footerText: string,
  buttonTitle: string,
  sections: ListSection[]
) {
  return {
    viewOnceMessage: {
      message: {
        messageContextInfo: {
          deviceListMetadataVersion: 2,
          deviceListMetadata: {},
        },
        interactiveMessage: proto.Message.InteractiveMessage.fromObject({
          body: proto.Message.InteractiveMessage.Body.create({ text: bodyText }),
          footer: proto.Message.InteractiveMessage.Footer.create({ text: footerText }),
          nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
            buttons: [
              {
                name: 'single_select',
                buttonParamsJson: JSON.stringify({
                  has_multiple_buttons: false,
                  title: buttonTitle,
                  sections,
                }),
              },
            ],
          }),
        }),
      },
    },
  };
}

/**
 * Kirim interactive list ke chat. Jika gagal (versi WA tidak mendukung, dsb.),
 * otomatis fallback ke pesan teks biasa agar bot tetap merespon.
 */
export async function sendInteractiveList(
  sock: WASocket,
  jid: string,
  bodyText: string,
  footerText: string,
  buttonTitle: string,
  sections: ListSection[],
  opts?: { quoted?: any }
): Promise<boolean> {
  const content = buildInteractiveList(bodyText, footerText, buttonTitle, sections);
  try {
    const msg = generateWAMessageFromContent(
      jid,
      content as any,
      { userJid: sock.user?.id || '' }
    );
    if (!msg.message) throw new Error('Gagal membuat konten interactive message');
    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id || undefined, ...opts });
    return true;
  } catch {
    // Fallback teks supaya user tetap mendapat informasi
    const lines = sections.map((s) =>
      [`*${s.title}*`, ...s.rows.map((r) => `▸ ${r.title}${r.description ? ` — ${r.description}` : ''}`)].join('\n')
    );
    await sock.sendMessage(jid, { text: `${bodyText}\n\n${lines.join('\n\n')}` }, { quoted: opts?.quoted });
    return false;
  }
}
