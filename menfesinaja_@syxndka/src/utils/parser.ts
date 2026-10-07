import { WAMessage } from '@whiskeysockets/baileys';

export interface ParsedMessage {
  rawMessage: WAMessage;
  from: string;
  sender: string;
  senderName: string;
  isGroup: boolean;
  body: string;
  command: string;
  prefix: string;
  args: string[];
  argText: string;
  mentionedJids: string[];
  quotedMessage?: WAMessage;
  quotedSender?: string;
  quotedText?: string;
}

export function parseMessage(msg: WAMessage, defaultPrefix: string = '.'): ParsedMessage | null {
  if (!msg.message) return null;

  const mType = Object.keys(msg.message)[0];
  
  // Skip internal WhatsApp protocol messages (typing, read receipts, etc)
  if (mType === 'protocolMessage' || mType === 'senderKeyDistributionMessage') {
    return null;
  }

  const from = msg.key.remoteJid || '';
  const isGroup = from.endsWith('@g.us');
  // Extract sender JID - prefer participant in groups, use from for direct messages
  const sender = isGroup
    ? (msg.key.participant || msg.key.remoteJid || '')
    : (msg.key.remoteJid || from);
  const senderName = msg.pushName || 'Customer';

  let body = '';

  if (mType === 'conversation') {
    body = msg.message.conversation || '';
  } else if (mType === 'extendedTextMessage') {
    body = msg.message.extendedTextMessage?.text || '';
  } else if (mType === 'imageMessage') {
    body = msg.message.imageMessage?.caption || '';
  } else if (mType === 'videoMessage') {
    body = msg.message.videoMessage?.caption || '';
  } else if (mType === 'buttonsResponseMessage') {
    body = msg.message.buttonsResponseMessage?.selectedButtonId || '';
  } else if (mType === 'templateButtonReplyMessage') {
    body = msg.message.templateButtonReplyMessage?.selectedId || '';
  } else if (mType === 'listResponseMessage') {
    body = msg.message.listResponseMessage?.singleSelectReply?.selectedRowId || '';
  } else if (mType === 'interactiveResponseMessage') {
    const nativeFlowResponse = msg.message.interactiveResponseMessage?.nativeFlowResponseMessage;
    try {
      const params = JSON.parse(nativeFlowResponse?.paramsJson || '{}');
      body = params.id || params.row_id || params.selected_row_id || '';
    } catch {
      body = '';
    }
  }

  body = body.trim();

  // Command & prefix parsing
  let prefix = '';
  let command = '';
  let args: string[] = [];
  let argText = '';

  if (body.startsWith(defaultPrefix)) {
    prefix = defaultPrefix;
    const split = body.slice(prefix.length).trim().split(/\s+/);
    command = (split.shift() || '').toLowerCase();
    args = split;
    argText = split.join(' ');
  } else if (body.startsWith('!')) {
    prefix = '!';
    const split = body.slice(prefix.length).trim().split(/\s+/);
    command = (split.shift() || '').toLowerCase();
    args = split;
    argText = split.join(' ');
  } else if (body.startsWith('/')) {
    prefix = '/';
    const split = body.slice(prefix.length).trim().split(/\s+/);
    command = (split.shift() || '').toLowerCase();
    args = split;
    argText = split.join(' ');
  }

  // Mentions
  const mentionedJids: string[] = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];

  // Quoted message handling
  const contextInfo = msg.message.extendedTextMessage?.contextInfo;
  let quotedMessage: WAMessage | undefined;
  let quotedSender: string | undefined;
  let quotedText: string | undefined;

  if (contextInfo?.quotedMessage) {
    // PENTING: wrapper WAMessage agar quotedMessage bisa dipakai handler
    // (reply media, reply user, dst). Tanpa ini selalu undefined.
    quotedMessage = {
      key: {
        remoteJid: from,
        id: contextInfo.stanzaId || 'QUOTED',
        fromMe: false,
        participant: contextInfo.participant,
      },
      message: contextInfo.quotedMessage,
    } as WAMessage;
    quotedSender = contextInfo.participant || undefined;
    const qType = Object.keys(contextInfo.quotedMessage)[0];
    if (qType === 'conversation') {
      quotedText = contextInfo.quotedMessage.conversation || '';
    } else if (qType === 'extendedTextMessage') {
      quotedText = contextInfo.quotedMessage.extendedTextMessage?.text || '';
    } else if (qType === 'imageMessage') {
      quotedText = contextInfo.quotedMessage.imageMessage?.caption || '';
    }
  }

  return {
    rawMessage: msg,
    from,
    sender,
    senderName,
    isGroup,
    body,
    command,
    prefix,
    args,
    argText,
    mentionedJids,
    quotedMessage,
    quotedSender,
    quotedText,
  };
}
