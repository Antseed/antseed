import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const CONTRACTS_ROOT = path.join(REPOSITORY_ROOT, 'packages/contracts');
export const CANONICAL_DEPLOYMENTS_ROOT = path.join(CONTRACTS_ROOT, 'deployments');
