import { type Static, Type } from 'typebox';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { LOCALHOST } from '../constants.js';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

type SendToRenderer = (channel: string, payload: unknown) => void;

function sendBrowserPreviewOpen(sendToRenderer: SendToRenderer | undefined, url: string): void {
  if (!sendToRenderer) {
    return;
  }
  try {
    sendToRenderer('browser-preview:open', { url });
  } catch {
    // Renderer notifications are best-effort; do not fail the tool call.
  }
}

const BrowserPreviewParams = Type.Object({
  url: Type.String({
    description: 'The URL to open in the browser preview panel (e.g. http://localhost:3000).',
  }),
});

export function createBrowserPreviewTool(sendToRenderer?: SendToRenderer): ToolDefinition {
  return {
    name: 'open_browser_preview',
    label: 'Browser Preview',
    description:
      'Open a URL in the in-app browser preview panel. Call this tool after starting a dev ' +
      'server with start_dev_server, when making visible UI changes, or when the user ' +
      'asks to preview their work.',
    parameters: BrowserPreviewParams,
    async execute(_toolCallId, params) {
      const { url } = params as Static<typeof BrowserPreviewParams>;
      try {
        new URL(url);
      } catch {
        return {
          content: [{ type: 'text', text: `Invalid URL: ${url}` }],
          details: { url, error: 'invalid URL' },
          isError: true,
        };
      }

      sendBrowserPreviewOpen(sendToRenderer, url);
      return {
        content: [{ type: 'text', text: `Opened ${url} in the preview panel.` }],
        details: { url },
      };
    },
  };
}

export const browserPreviewTool: ToolDefinition = createBrowserPreviewTool();

const StartDevServerParams = Type.Object({
  command: Type.String({
    description:
      'The shell command to start the dev server, e.g. "pnpm run dev", "npm run dev", "npx vite", "docusaurus start".',
  }),
  cwd: Type.String({
    description: 'Absolute path to the project directory where the command should run.',
  }),
  port: Type.Optional(
    Type.Number({
      description:
        'Expected port the server will listen on. If omitted, the tool scans the output for a URL.',
    }),
  ),
});

/** Track running dev servers so we can kill them on new starts. */
const runningDevServers = new Map<string, { pid: number; kill: () => void }>();

function getDevServerShell(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const comspec = process.env['ComSpec']?.trim() || 'cmd.exe';
    return {
      file: comspec,
      args: ['/d', '/s', '/c', command],
    };
  }

  const userShell = process.env['SHELL']?.trim() || '/bin/bash';
  return {
    file: userShell,
    args: ['-lc', command],
  };
}

function killDetachedDevServer(pid: number): void {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.unref();
    return;
  }

  process.kill(-pid, 'SIGTERM');
}

function waitForPort(port: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (signal?.aborted) { resolve(false); return; }
      if (Date.now() > deadline) { resolve(false); return; }
      const sock = createConnection({ host: LOCALHOST, port });
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => { setTimeout(check, 500); });
    };
    check();
  });
}

function extractUrlFromOutput(output: string): string | null {
  // Match common dev server URL patterns
  const m = output.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+\/?/);
  return m ? m[0].replace('0.0.0.0', 'localhost') : null;
}

export function createStartDevServerTool(sendToRenderer?: SendToRenderer): ToolDefinition {
  return {
    name: 'start_dev_server',
    label: 'Start Dev Server',
    description:
      'Start a development server as a persistent background process. The server runs in ' +
      'a detached session so it survives tool timeouts. Use this instead of bash for any ' +
      'long-running dev server (npm run dev, pnpm run dev, vite, next dev, docusaurus start, etc.). ' +
      'The tool waits for the server to be ready, returns the URL, and opens it in the preview panel.',
    parameters: StartDevServerParams,
    async execute(_toolCallId, params, signal) {
      const { command, cwd, port: expectedPort } = params as Static<typeof StartDevServerParams>;

      if (!existsSync(cwd)) {
        return {
          content: [{ type: 'text', text: `Directory does not exist: ${cwd}` }],
          details: { cwd, error: 'directory not found' },
          isError: true,
        };
      }

      const prev = runningDevServers.get(cwd);
      if (prev) {
        try { prev.kill(); } catch { /* ignore */ }
        runningDevServers.delete(cwd);
      }

      let output = '';

      const shellCommand = getDevServerShell(command);
      const child = spawn(shellCommand.file, shellCommand.args, {
        cwd,
        detached: true, // new process group — immune to parent signals
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' },
        windowsHide: true,
      });

      if (!child.pid) {
        return {
          content: [{ type: 'text', text: `Failed to start dev server for command: ${command}` }],
          details: { cwd, command, error: 'missing child pid' },
          isError: true,
        };
      }

      // Unref so the Electron process can exit even if the dev server is still running
      child.unref();

      child.on('exit', () => {
        runningDevServers.delete(cwd);
      });

      const collectOutput = (chunk: Buffer) => {
        output += chunk.toString();
        // Cap collected output to avoid unbounded memory
        if (output.length > 32_000) output = output.slice(-16_000);
      };

      let spawnError: string | null = null;
      let exitCode: number | null = null;

      child.stdout?.on('data', collectOutput);
      child.stderr?.on('data', collectOutput);
      child.on('error', (error) => {
        spawnError = error.message;
        output += `\n[spawn error] ${error.message}`;
      });
      child.on('exit', (code) => {
        exitCode = code;
      });

      const killFn = () => {
        try { killDetachedDevServer(child.pid!); } catch { /* ignore */ }
      };

      runningDevServers.set(cwd, { pid: child.pid, kill: killFn });

      // Wait for the server to become ready
      const startTime = Date.now();
      const maxWaitMs = 30_000;

      // If we know the port, poll for it
      if (expectedPort) {
        const ready = await waitForPort(expectedPort, maxWaitMs, signal ?? undefined);
        if (ready) {
          const url = `http://localhost:${expectedPort}`;
          sendBrowserPreviewOpen(sendToRenderer, url);
          return {
            content: [{ type: 'text', text: `Dev server running at ${url} (pid ${child.pid})` }],
            details: { url, pid: child.pid, cwd },
          };
        }
      }

      // Otherwise, watch the output for a URL
      const foundUrl = await new Promise<string | null>((resolve) => {
        const deadline = startTime + maxWaitMs;

        const poll = () => {
          if (signal?.aborted) { resolve(null); return; }
          const url = extractUrlFromOutput(output);
          if (url) { resolve(url); return; }
          if (Date.now() > deadline) { resolve(null); return; }
          setTimeout(poll, 500);
        };
        poll();
      });

      if (foundUrl) {
        // Give it a tiny bit more time after URL appears (compilation may still be running)
        const port = parseInt(new URL(foundUrl).port, 10);
        if (port) await waitForPort(port, 10_000, signal ?? undefined);

        sendBrowserPreviewOpen(sendToRenderer, foundUrl);
        return {
          content: [{ type: 'text', text: `Dev server running at ${foundUrl} (pid ${child.pid})` }],
          details: { url: foundUrl, pid: child.pid, cwd },
        };
      }

      if (spawnError || exitCode !== null) {
        const tail = output.slice(-2000);
        return {
          content: [
            {
              type: 'text',
              text: `Dev server failed to stay running for command "${command}".\n\nOutput tail:\n${tail}`,
            },
          ],
          details: { pid: child.pid, cwd, command, spawnError, exitCode, outputTail: tail },
          isError: true,
        };
      }

      // Server didn't produce a URL — return what we have
      const tail = output.slice(-2000);
      return {
        content: [
          {
            type: 'text',
            text: `Dev server started (pid ${child.pid}) but no URL detected within ${maxWaitMs / 1000}s.\n\nOutput tail:\n${tail}`,
          },
        ],
        details: { pid: child.pid, cwd, outputTail: tail },
      };
    },
  };
}

export const startDevServerTool: ToolDefinition = createStartDevServerTool();
