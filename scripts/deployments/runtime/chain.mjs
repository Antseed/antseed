import { capture } from './exec.mjs';

export function cast(rpcUrl, args, options = {}) {
  return capture('cast', [...args, '--rpc-url', rpcUrl], options);
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
