export type FaultAttribution = 'buyer' | 'peer' | 'unknown';

/** Every error code; the exported type and the runtime check both come from it. */
const ANTSEED_ERROR_CODE_MAP = {
  'node-not-started': true, 'node-stopped': true, 'invalid-request': true, 'buyer-stream-limit': true,
  'buyer-budget-too-low': true, 'buyer-reserve-misconfigured': true, 'buyer-session-state': true,
  'buyer-deposits-insufficient': true, 'buyer-reserve-topup-timeout': true, 'buyer-transport-closed': true,
  'buyer-tee-connection-changed': true, 'invalid-spending-auth-header': true,
  'chain-rpc-unavailable': true, 'peer-not-authorized': true, 'peer-protocol-violation': true,
} as const;

export type AntseedErrorCode = keyof typeof ANTSEED_ERROR_CODE_MAP;

export interface AntseedRequestErrorOptions {
  cause?: unknown;
}

export class AntseedRequestError extends Error {
  readonly attribution: FaultAttribution;
  readonly code: AntseedErrorCode;

  constructor(
    message: string,
    code: AntseedErrorCode,
    attribution: FaultAttribution,
    options?: AntseedRequestErrorOptions,
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AntseedRequestError';
    this.code = code;
    this.attribution = attribution;
  }
}

export function buyerFault(
  message: string,
  code: AntseedErrorCode,
  options?: AntseedRequestErrorOptions,
): AntseedRequestError {
  return new AntseedRequestError(message, code, 'buyer', options);
}

export function peerFault(
  message: string,
  code: AntseedErrorCode,
  options?: AntseedRequestErrorOptions,
): AntseedRequestError {
  return new AntseedRequestError(message, code, 'peer', options);
}

export function faultAttributionOf(err: unknown, depth = 0): FaultAttribution {
  if (depth > 5) return 'unknown';
  const attribution = (err as { attribution?: unknown } | null)?.attribution;
  if (attribution === 'buyer' || attribution === 'peer' || attribution === 'unknown') {
    return attribution;
  }
  if (err instanceof Error && err.cause !== undefined && err.cause !== err) {
    return faultAttributionOf(err.cause, depth + 1);
  }
  return 'unknown';
}

export function faultCodeOf(err: unknown, depth = 0): AntseedErrorCode | null {
  if (depth > 5) return null;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && ANTSEED_ERROR_CODES.has(code as AntseedErrorCode)) {
    return code as AntseedErrorCode;
  }
  if (err instanceof Error && err.cause !== undefined && err.cause !== err) {
    return faultCodeOf(err.cause, depth + 1);
  }
  return null;
}

const ANTSEED_ERROR_CODES: ReadonlySet<AntseedErrorCode> = new Set(Object.keys(ANTSEED_ERROR_CODE_MAP) as AntseedErrorCode[]);
