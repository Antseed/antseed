/**
 * "Use it with your agent": installs Antseed's skills into an AI agent's own
 * skills folder, so the agent keeps its model and calls Antseed only when the
 * user asks ("using Antseed, generate an image"). The installed copies point
 * at this desktop's gateway: its URL is written into them and its API key
 * sits in a private file they read, so a replaced key or a new gateway only
 * needs `syncAgentSkills()`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { WORKSPACE_APPS_DIR } from './paths.js';
import type { AgentSkillStatus } from '../shared/gateway-types.js';

export const AGENT_SKILL_NAMES = ['antseed-ask', 'antseed-images', 'antseed-videos'] as const;

/** Written into every installed skill folder; only folders carrying it are updated or removed. */
const MARKER_FILE = '.antseed-desktop';
const LEGACY_PROXY_URL = 'http://127.0.0.1:8377';
const LEGACY_KEY_DEFAULT = '${ANTSEED_API_KEY:-antseed-desktop}';

export type AgentSkillTarget = {
  id: string;
  label: string;
  /** Skills folder, relative to the home directory. */
  skillsDir: string;
  /** Any of these (relative to home) means the agent is on this computer. */
  detect: string[];
};

export const AGENT_SKILL_TARGETS: readonly AgentSkillTarget[] = [
  { id: 'claude-code', label: 'Claude Code', skillsDir: '.claude/skills', detect: ['.claude'] },
  { id: 'codex', label: 'Codex', skillsDir: '.agents/skills', detect: ['.codex'] },
  { id: 'opencode', label: 'OpenCode', skillsDir: '.config/opencode/skills', detect: ['.config/opencode', '.local/share/opencode'] },
  { id: 'hermes', label: 'Hermes', skillsDir: '.hermes/skills', detect: ['.hermes'] },
  { id: 'pi', label: 'Pi', skillsDir: '.pi/agent/skills', detect: ['.pi'] },
  { id: 'droid', label: 'Droid', skillsDir: '.factory/skills', detect: ['.factory'] },
];

export type { AgentSkillStatus };

export type AgentSkillsEndpoint = { origin: string; apiKey: string };

type Options = { home?: string; sourceRoot?: string; keyFile?: string };

function homeOf(options: Options): string {
  return options.home ?? homedir();
}

/** The API key the installed skills read; private to the user. */
export function agentSkillsKeyFile(options: Options = {}): string {
  return options.keyFile ?? path.join(homeOf(options), '.antseed', 'agent-skills.key');
}

/** Packaged app: resources/skills; dev: the repo's skills folder. */
export function bundledSkillsRoot(options: Options = {}): string | null {
  const roots = options.sourceRoot
    ? [options.sourceRoot]
    : [process.resourcesPath ? path.join(process.resourcesPath, 'skills') : '', path.resolve(WORKSPACE_APPS_DIR, '..', 'skills')];
  return roots.find((root) => root && AGENT_SKILL_NAMES.every((name) => existsSync(path.join(root, name, 'SKILL.md')))) ?? null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Points a skill file at this gateway: the default URL becomes the gateway's,
 * and the default key is read from the key file. `$ANTSEED_PROXY_URL` and
 * `$ANTSEED_API_KEY` still win when set (the desktop chat sets them).
 */
export function pointSkillAtGateway(text: string, origin: string, keyFile: string): string {
  return text
    .split(LEGACY_PROXY_URL).join(origin)
    .split(LEGACY_KEY_DEFAULT).join(`\${ANTSEED_API_KEY:-$(cat ${shellQuote(keyFile)})}`);
}

function gatewayNote(origin: string, keyFile: string): string {
  return [
    '',
    '> Installed by Antseed Desktop. Your Antseed gateway is at `' + origin + '`; its API key is in `' + keyFile + '`.',
    '> Use them unless `$ANTSEED_PROXY_URL` and `$ANTSEED_API_KEY` are set. The agent keeps its own model; call Antseed only for what this skill covers.',
    '',
  ].join('\n');
}

/** Adds the note after the front matter so the skill's name and description stay first. */
function withGatewayNote(skillMd: string, origin: string, keyFile: string): string {
  const match = /^---\n[\s\S]*?\n---\n/.exec(skillMd);
  if (!match) return gatewayNote(origin, keyFile) + skillMd;
  return match[0] + gatewayNote(origin, keyFile) + skillMd.slice(match[0].length);
}

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdown(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function targetById(id: string): AgentSkillTarget {
  const target = AGENT_SKILL_TARGETS.find((candidate) => candidate.id === id);
  if (!target) throw new Error(`Unknown agent: ${id}`);
  return target;
}

function skillsDirOf(target: AgentSkillTarget, options: Options): string {
  return path.join(homeOf(options), target.skillsDir);
}

function isInstalledIn(skillsDir: string): boolean {
  return AGENT_SKILL_NAMES.every((name) => existsSync(path.join(skillsDir, name, MARKER_FILE)));
}

export function listAgentSkillTargets(options: Options = {}): AgentSkillStatus[] {
  const home = homeOf(options);
  return AGENT_SKILL_TARGETS.map((target) => {
    const skillsDir = skillsDirOf(target, options);
    const installed = isInstalledIn(skillsDir);
    return {
      id: target.id,
      label: target.label,
      detected: installed || target.detect.some((rel) => existsSync(path.join(home, rel))),
      installed,
      skillsDir,
    };
  });
}

async function writeKeyFile(apiKey: string, options: Options): Promise<string> {
  const keyFile = agentSkillsKeyFile(options);
  await mkdir(path.dirname(keyFile), { recursive: true });
  await writeFile(keyFile, `${apiKey}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(keyFile, 0o600);
  return keyFile;
}

type StagedInstall = { swap: () => Promise<void>; rollback: () => Promise<void>; discard: () => Promise<void> };

/**
 * Builds a target's copies beside its final folders, pointed at `endpoint`, so
 * a conflict or failed copy changes nothing. `swap` puts them in place, as renames.
 */
async function stageInstall(skillsDir: string, endpoint: AgentSkillsEndpoint, options: Options): Promise<StagedInstall> {
  const sourceRoot = bundledSkillsRoot(options);
  if (!sourceRoot) throw new Error('The Antseed skills are missing from this install.');
  // Never overwrite a skill of that name the user put there themselves.
  for (const name of AGENT_SKILL_NAMES) {
    const dest = path.join(skillsDir, name);
    if (existsSync(dest) && !existsSync(path.join(dest, MARKER_FILE))) {
      throw new Error(`${dest} already exists and was not installed by Antseed Desktop. Remove or rename it, then try again.`);
    }
  }
  const keyFile = agentSkillsKeyFile(options);
  await mkdir(skillsDir, { recursive: true });
  const staging = await mkdtemp(path.join(skillsDir, '.antseed-install-'));
  const discard = () => rm(staging, { recursive: true, force: true });
  try {
    for (const name of AGENT_SKILL_NAMES) {
      const dest = path.join(staging, name);
      await cp(path.join(sourceRoot, name), dest, { recursive: true });
      for (const file of listMarkdown(dest)) {
        let text = pointSkillAtGateway(await readFile(file, 'utf8'), endpoint.origin, keyFile);
        if (path.basename(file) === 'SKILL.md' && path.dirname(file) === dest) text = withGatewayNote(text, endpoint.origin, keyFile);
        await writeFile(file, text, 'utf8');
      }
      await writeFile(path.join(dest, MARKER_FILE), 'Installed by Antseed Desktop. Removing the skill from the app deletes this folder.\n', 'utf8');
    }
  } catch (err) {
    await discard();
    throw err;
  }
  // What `swap` replaced, kept in the staging folder until the whole update has landed.
  const swapped: Array<{ dest: string; backup: string | null }> = [];
  return {
    swap: async () => {
      for (const name of AGENT_SKILL_NAMES) {
        const dest = path.join(skillsDir, name);
        const backup = existsSync(dest) ? path.join(staging, `${name}.previous`) : null;
        if (backup) await rename(dest, backup);
        swapped.push({ dest, backup });
        await rename(path.join(staging, name), dest);
      }
    },
    rollback: async () => {
      for (const { dest, backup } of swapped.reverse()) {
        if (backup && !existsSync(backup)) continue;
        await rm(dest, { recursive: true, force: true });
        if (backup) await rename(backup, dest);
      }
      swapped.length = 0;
    },
    discard,
  };
}

/**
 * Puts every staged copy in place and then the key, as one change: if any
 * step fails, the copies already swapped and the previous key come back.
 */
async function commitInstalls(staged: readonly StagedInstall[], apiKey: string, options: Options): Promise<void> {
  const keyFile = agentSkillsKeyFile(options);
  const previousKey = await readFile(keyFile, 'utf8').catch(() => null);
  try {
    for (const copy of staged) await copy.swap();
    await writeKeyFile(apiKey, options);
  } catch (err) {
    for (const copy of [...staged].reverse()) await copy.rollback().catch(() => undefined);
    if (previousKey === null) await rm(keyFile, { force: true }).catch(() => undefined);
    else await writeKeyFile(previousKey.trim(), options).catch(() => undefined);
    throw err;
  }
}

async function installInto(skillsDir: string, endpoint: AgentSkillsEndpoint, options: Options): Promise<void> {
  const staged = await stageInstall(skillsDir, endpoint, options);
  try {
    await commitInstalls([staged], endpoint.apiKey, options);
  } finally {
    await staged.discard();
  }
}

export async function installAgentSkills(id: string, endpoint: AgentSkillsEndpoint, options: Options = {}): Promise<void> {
  await installInto(skillsDirOf(targetById(id), options), endpoint, options);
}

export async function removeAgentSkills(id: string, options: Options = {}): Promise<void> {
  const skillsDir = skillsDirOf(targetById(id), options);
  for (const name of AGENT_SKILL_NAMES) {
    const dest = path.join(skillsDir, name);
    if (existsSync(path.join(dest, MARKER_FILE))) await rm(dest, { recursive: true, force: true });
  }
  // The key file goes with the last agent that used it.
  if (!listAgentSkillTargets(options).some((target) => target.installed)) {
    await rm(agentSkillsKeyFile(options), { force: true });
  }
}

/** Re-points every installed copy at the current gateway and key (after a key replacement or a gateway switch). */
export async function syncAgentSkills(endpoint: AgentSkillsEndpoint, options: Options = {}): Promise<void> {
  const installed = listAgentSkillTargets(options).filter((target) => target.installed);
  if (installed.length === 0) return;
  // Every copy is built before anything changes, then all of them and the key
  // land together: a failure on any agent leaves all of them on the old gateway and key.
  const staged: StagedInstall[] = [];
  try {
    for (const target of installed) staged.push(await stageInstall(target.skillsDir, endpoint, options));
    await commitInstalls(staged, endpoint.apiKey, options);
  } finally {
    for (const copy of staged) await copy.discard();
  }
}

/** For any other agent: what to paste so it can call the gateway. Holds the key, so it is only built on request. */
export function agentSetupPrompt(endpoint: AgentSkillsEndpoint): string {
  return [
    'You can use Antseed as a second AI API, alongside your own model. Use it only when I ask for it (for example "using Antseed, generate an image").',
    '',
    `- Base URL: ${endpoint.origin}/v1 (OpenAI-compatible; Anthropic /v1/messages works too)`,
    `- API key: ${endpoint.apiKey} (send it as "Authorization: Bearer <key>")`,
    '- The key is a secret that spends my balance: store it as a secret or environment variable, never print it, and keep it out of logs, files you share and replies.',
    '- Models: GET /v1/models?type=text, ?type=images or ?type=videos. Send the bare model id; the gateway picks the seller.',
    '- Text: POST /v1/chat/completions. Images: POST /v1/images/generations (response_format "b64_json"; save data[0].b64_json as a file).',
    '- Videos: follow https://github.com/Antseed/antseed/tree/main/skills/antseed-videos',
    '',
    'Skills with the exact requests: https://github.com/Antseed/antseed/tree/main/skills (antseed-ask, antseed-images, antseed-videos).',
    'Ask me before anything that costs more than a few cents.',
  ].join('\n');
}
