import { homedir } from 'node:os';
import path from 'node:path';
import { resolveBuyerStateDir } from './runtime/attach-only.js';

export const DEFAULT_CONFIG_PATH = path.join(homedir(), '.antseed', 'config.json');
export const DEFAULT_BUYER_STATE_PATH = path.join(resolveBuyerStateDir(), 'buyer.state.json');
export const DEFAULT_DASHBOARD_PORT = 3117;

export const LOCALHOST = '127.0.0.1';
export const LOCALHOST_URL = `http://${LOCALHOST}`;
