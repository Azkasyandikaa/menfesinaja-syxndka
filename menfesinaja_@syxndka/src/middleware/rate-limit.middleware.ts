const userLastMsgMap = new Map<string, number>();

export function isRateLimited(senderJid: string, cooldownMs: number = 1500): boolean {
  const now = Date.now();
  const lastTime = userLastMsgMap.get(senderJid) || 0;
  if (now - lastTime < cooldownMs) {
    return true;
  }
  userLastMsgMap.set(senderJid, now);
  return false;
}
