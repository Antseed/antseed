import { capture } from './exec.mjs';

// Public RPC pools sometimes route a read to a node that has not caught up with the newest block.
const TRANSIENT_RPC_ERROR = /no state found|error code -32603|timed out|connection (reset|refused|closed)|502 Bad Gateway|503 Service/i;
const READ_RETRIES = 5;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs cast against `rpcUrl`; reads are retried on transient RPC errors, sends never are. */
export function cast(rpcUrl, args, options = {}) {
  const retries = args[0] === 'send' ? 0 : READ_RETRIES;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return capture('cast', [...args, '--rpc-url', rpcUrl], options);
    } catch (error) {
      if (attempt >= retries || !TRANSIENT_RPC_ERROR.test(error.message)) throw error;
      sleepSync(1000 * (attempt + 1));
    }
  }
}

export function call(rpcUrl, address, signature, args = []) {
  return cast(rpcUrl, ['call', address, signature, ...args]);
}

export function callJson(rpcUrl, address, signature, args = []) {
  return JSON.parse(cast(rpcUrl, ['call', address, signature, ...args, '--json']));
}

export function firstValue(output) {
  return output.split(/\s+/)[0];
}

export function numberValue(output) {
  return Number(BigInt(firstValue(output)));
}

export function normalizeAddress(address) {
  return address?.toLowerCase();
}

export function sameAddress(left, right) {
  return normalizeAddress(left) === normalizeAddress(right);
}

export function booleanValue(output) {
  return output === true || output === 'true';
}

export function hasCode(rpcUrl, address) {
  return cast(rpcUrl, ['code', address]) !== '0x';
}

export function chainId(rpcUrl) {
  return Number(cast(rpcUrl, ['chain-id']));
}

export function transactionSucceeded(rpcUrl, hash) {
  try {
    return JSON.parse(cast(rpcUrl, ['receipt', hash, '--json'])).status === '0x1';
  } catch {
    return false;
  }
}

export function ownerOf(rpcUrl, address) {
  try {
    return call(rpcUrl, address, 'owner()(address)');
  } catch {
    return null;
  }
}
