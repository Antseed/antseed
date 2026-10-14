import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { OAuthState, OAuthStateStore } from '@antseed/provider-core';

/** Single-process credential store for development/testing OAuth sessions. */
export class CredentialStore implements OAuthStateStore {
  constructor(private readonly path: string) {}

  load(): OAuthState {
    const text = readFileSync(this.path, 'utf8');
    // Do not include JSON parse errors: they can contain credential fragments.
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value !== 'object' || value === null) {
        throw new Error('Expected an object');
      }
      const state = value as Partial<OAuthState>;
      if (typeof state.accessToken !== 'string' || !state.accessToken
        || typeof state.refreshToken !== 'string' || !state.refreshToken
        || typeof state.expiresAt !== 'number' || !Number.isFinite(state.expiresAt)
        || state.expiresAt <= 0) {
        throw new Error('Invalid credential fields');
      }
      return { accessToken: state.accessToken, refreshToken: state.refreshToken, expiresAt: state.expiresAt };
    } catch {
      throw new Error('Invalid Claude OAuth credential file; expected accessToken, refreshToken and expiresAt');
    }
  }

  /** Bootstrap exclusively; an existing file always takes precedence over env. */
  initialize(state?: OAuthState): OAuthState {
    try {
      return this.load();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (!state) {
      throw new Error('CLAUDE_ACCESS_TOKEN and CLAUDE_REFRESH_TOKEN are required to initialize the credential file');
    }
    this.write(state, true);
    return this.load();
  }

  save(state: OAuthState): void {
    this.write(state, false);
  }

  private write(state: OAuthState, exclusive: boolean): void {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(state) + '\n');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // A hard link publishes a complete bootstrap without overwriting an
      // existing credential file. Later rotations use atomic replacement.
      if (exclusive) {
        linkSync(temporary, this.path);
      } else {
        renameSync(temporary, this.path);
      }
    } finally {
      try {
        unlinkSync(temporary);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  }
}
