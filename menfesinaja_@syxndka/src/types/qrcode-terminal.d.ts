declare module 'qrcode-terminal' {
  export function generate(
    input: string,
    options?: { small?: boolean },
    cb?: (qrcode: string) => void
  ): void;
}
