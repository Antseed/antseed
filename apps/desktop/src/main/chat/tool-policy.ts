import path from 'node:path';
import type { ChatPermissionMode, ToolApprovalRequest } from './permissions.js';

const RISKY_TOOLS = new Set(['bash', 'edit', 'write', 'start_dev_server', 'web_fetch']);
const AUTO_ALLOWED_TOOL_PERMISSION_KEYS = new Set(['bash:read', 'bash:git-read']);

type BashPermissionClass = {
  key: string;
  label: string;
  title: string;
  alwaysAllowLabel: string;
  canAlwaysAllow: boolean;
};

export function requiresToolApproval(mode: ChatPermissionMode, toolName: string): boolean {
  return mode === 'manual' && RISKY_TOOLS.has(toolName);
}

export function isToolPermissionAutoAllowed(permissionKey: string): boolean {
  return AUTO_ALLOWED_TOOL_PERMISSION_KEYS.has(permissionKey);
}

function hasScope(scopeId: string | null | undefined): boolean {
  return Boolean(scopeId?.trim());
}

function scopeSuffix(scopeId: string | null | undefined): string {
  return hasScope(scopeId) ? 'for this model' : 'once';
}

function firstShellWord(command: string): string {
  const match = /^\s*(?:env\s+)?(?:\w+=\S+\s+)*([\w./-]+)/.exec(command);
  return path.basename(match?.[1] || '').toLowerCase();
}

function firstGitSubcommand(command: string): string {
  const match = /^\s*(?:env\s+)?(?:\w+=\S+\s+)*git\s+([\w-]+)/.exec(command);
  return (match?.[1] || '').toLowerCase();
}

function hasShellWriteOperator(command: string): boolean {
  return /(^|[^<>])>{1,2}([^>]|$)|\btee\b/.test(command);
}

function isSensitiveShellCommand(command: string): boolean {
  return [
    /\bsudo\b/,
    /\bsu(?:do)?\s+-/,
    /\brm\s+(?:-[^\n\s]*[rf][^\n\s]*\s+){1,}/,
    /\b(?:chmod|chown|chgrp|kill|killall|pkill|dd|mkfs|mount|umount|diskutil|launchctl|crontab)\b/,
    /\bgit\s+(?:reset\s+--hard|clean\s+-[^\n\s]*f|push\s+--force(?:-with-lease)?|checkout\s+-f)\b/,
    /\b(?:security|codesign|spctl|xattr)\b/,
  ].some((pattern) => pattern.test(command));
}

function isNetworkShellCommand(command: string): boolean {
  return /\b(?:curl|wget|ssh|scp|rsync|nc|netcat|telnet|ftp|sftp)\b/.test(command);
}

const READ_ONLY_SHELL_COMMANDS = new Set([
  'pwd', 'ls', 'find', 'grep', 'rg', 'cat', 'head', 'tail', 'wc', 'sed', 'awk',
  'echo', 'printf', 'which', 'whereis', 'type',
]);

// Shell constructs that can smuggle a second, unclassified command past a
// first-word allowlist: command/process substitution, newlines (multi-statement
// scripts), and chaining/background operators. A command containing any of these
// is never eligible for the silent auto-allow path — it must be classified by
// its riskiest reachable command, which forces an explicit prompt.
function hasUnsafeShellComposition(command: string): boolean {
  return /[\r\n]/.test(command)
    || /\$\(|`|<\(|>\(/.test(command)
    || /[;&]/.test(command);
}

// Several allowlisted commands are general-purpose interpreters or have
// file-writing flags, so the first-word match alone is not sufficient. These
// guards reject intra-command escape forms that would otherwise smuggle a
// silent `bash:read` auto-allow (awk `system()`/`getline`, sed `e`/`w`
// commands and flags, sed `-f` script-from-file, find `-exec*`/`-ok*`, and
// find `-fprint*`/`-fls` arbitrary file write).
function isReadOnlySegment(segment: string): boolean {
  const word = firstShellWord(segment);
  return READ_ONLY_SHELL_COMMANDS.has(word)
    && !hasShellWriteOperator(segment)
    && !/\bfind\b[^\n]*(?:\s-delete|\s-(?:exec|execdir|ok|okdir)\b|\s-fprint(?:f|0)?\b|\s-fls\b)/.test(segment)
    && !/\bsed\b[^\n]*\s(?:-i(?:\s|$)|-f(?:\s|=)|['"](?:\s*(?:[0-9$~!,]+|\/[^\/'"]*\/)?\s*!?[ew](?:[\s'";}]|$)|[^'"]*(?:\/[gipm0-9]*[ew][gipm0-9]*(?:['"\s]|$)|[;{\s](?:[0-9$~!,]+|\/[^\/'"]*\/)?\s*!?[ew](?:[\s'";}]|$))))/.test(segment)
    && !/\bawk\b[^\n]*(?:\bsystem\s*\(|\bgetline\b|\{[^}]*(?:\|\s*["']|["']\s*\|))/.test(segment);
}

function isReadOnlyShellCommand(command: string): boolean {
  if (hasUnsafeShellComposition(command)) return false;
  // Pipes are allowed only when every stage is itself read-only (e.g.
  // `grep foo file | wc -l`), so a pipe into `sh`/`node`/etc. cannot auto-allow.
  const segments = command.split('|').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every(isReadOnlySegment);
}

function isFileChangingShellCommand(command: string): boolean {
  return hasShellWriteOperator(command)
    || /\b(?:mv|cp|mkdir|touch|install|ln|python|python3|node|npm|pnpm|yarn|bun)\b/.test(command);
}

function classifyBashCommand(command: string, scopeId?: string | null): BashPermissionClass {
  const normalized = command.trim().toLowerCase();
  const word = firstShellWord(command);
  const gitSubcommand = firstGitSubcommand(command);
  const canAlwaysAllow = hasScope(scopeId);

  if (isSensitiveShellCommand(normalized)) {
    return {
      key: 'bash:sensitive',
      label: 'sensitive shell commands',
      title: 'Allow sensitive shell command?',
      alwaysAllowLabel: 'Always allow sensitive shell commands',
      canAlwaysAllow: false,
    };
  }

  if (isNetworkShellCommand(normalized)) {
    return {
      key: 'bash:network',
      label: 'network shell commands',
      title: 'Allow network shell command?',
      alwaysAllowLabel: `Always allow network commands ${scopeSuffix(scopeId)}`,
      canAlwaysAllow,
    };
  }

  if (word === 'git') {
    const readOnlyGit = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'remote', 'config']);
    if (readOnlyGit.has(gitSubcommand) && !hasUnsafeShellComposition(normalized)) {
      return {
        key: 'bash:git-read',
        label: 'read-only git commands',
        title: 'Allow read-only git command?',
        alwaysAllowLabel: `Always allow read-only git ${scopeSuffix(scopeId)}`,
        canAlwaysAllow,
      };
    }
    return {
      key: 'bash:git-write',
      label: 'git change commands',
      title: 'Allow git change command?',
      alwaysAllowLabel: `Always allow git changes ${scopeSuffix(scopeId)}`,
      canAlwaysAllow,
    };
  }

  if (isReadOnlyShellCommand(normalized)) {
    return {
      key: 'bash:read',
      label: 'read-only shell commands',
      title: 'Allow read-only shell command?',
      alwaysAllowLabel: `Always allow read-only shell ${scopeSuffix(scopeId)}`,
      canAlwaysAllow,
    };
  }

  if (isFileChangingShellCommand(normalized)) {
    return {
      key: 'bash:write',
      label: 'shell commands that can change files',
      title: 'Allow file-changing shell command?',
      alwaysAllowLabel: `Always allow file-changing shell ${scopeSuffix(scopeId)}`,
      canAlwaysAllow,
    };
  }

  return {
    key: 'bash:other',
    label: 'other shell commands',
    title: 'Allow shell command?',
    alwaysAllowLabel: `Always allow shell commands ${scopeSuffix(scopeId)}`,
    canAlwaysAllow: false,
  };
}

export function describeToolApproval(toolName: string, input: Record<string, unknown>, scopeId?: string | null): Pick<ToolApprovalRequest, 'permissionKey' | 'permissionLabel' | 'title' | 'description' | 'subject' | 'alwaysAllowLabel' | 'canAlwaysAllow'> {
  const canAlwaysAllow = hasScope(scopeId);
  if (toolName === 'bash') {
    const command = typeof input.command === 'string' ? input.command : JSON.stringify(input, null, 2);
    const bashClass = classifyBashCommand(command, scopeId);
    return {
      permissionKey: bashClass.key,
      permissionLabel: bashClass.label,
      title: bashClass.title,
      description: '',
      subject: command,
      alwaysAllowLabel: bashClass.alwaysAllowLabel,
      canAlwaysAllow: bashClass.canAlwaysAllow,
    };
  }
  if (toolName === 'edit') {
    return {
      permissionKey: 'edit',
      permissionLabel: 'file edits',
      title: 'Allow file edit?',
      description: '',
      subject: typeof input.path === 'string' ? input.path : JSON.stringify(input, null, 2),
      alwaysAllowLabel: `Always allow file edits ${scopeSuffix(scopeId)}`,
      canAlwaysAllow,
    };
  }
  if (toolName === 'write') {
    return {
      permissionKey: 'write',
      permissionLabel: 'file writes',
      title: 'Allow file write?',
      description: '',
      subject: typeof input.path === 'string' ? input.path : JSON.stringify(input, null, 2),
      alwaysAllowLabel: `Always allow file writes ${scopeSuffix(scopeId)}`,
      canAlwaysAllow,
    };
  }
  if (toolName === 'start_dev_server') {
    return {
      permissionKey: 'start_dev_server',
      permissionLabel: 'dev server starts',
      title: 'Allow dev server?',
      description: '',
      subject: typeof input.command === 'string' ? input.command : JSON.stringify(input, null, 2),
      alwaysAllowLabel: `Always allow dev servers ${scopeSuffix(scopeId)}`,
      canAlwaysAllow,
    };
  }
  if (toolName === 'web_fetch') {
    const url = typeof input.url === 'string' ? input.url : typeof input.URL === 'string' ? input.URL : '';
    return {
      permissionKey: 'web_fetch',
      permissionLabel: 'web fetches',
      title: 'Allow web fetch?',
      description: '',
      subject: url || JSON.stringify(input, null, 2),
      alwaysAllowLabel: `Always allow web fetches ${scopeSuffix(scopeId)}`,
      canAlwaysAllow,
    };
  }
  return {
    permissionKey: toolName,
    permissionLabel: toolName,
    title: `Allow ${toolName}?`,
    description: `The agent wants to run ${toolName}.`,
    subject: JSON.stringify(input, null, 2),
    alwaysAllowLabel: `Always allow ${toolName} ${scopeSuffix(scopeId)}`,
    canAlwaysAllow,
  };
}
