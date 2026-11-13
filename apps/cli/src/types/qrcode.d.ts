// Minimal local declaration for the `qrcode` package — just the terminal
// rendering surface the CLI uses (mirrors the desktop's local declaration;
// @types/qrcode is not part of the workspace).
declare module 'qrcode' {
  export type QRCodeToStringOptions = {
    type?: 'terminal' | 'utf8' | 'svg';
    small?: boolean;
    margin?: number;
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  };
  function toString(text: string, options?: QRCodeToStringOptions): Promise<string>;
  const QRCode: { toString: typeof toString };
  export default QRCode;
}
