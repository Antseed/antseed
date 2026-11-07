import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  agentSetupPrompt,
  agentSkillsKeyFile,
  AGENT_SKILL_NAMES,
  installAgentSkills,
  listAgentSkillTargets,
  pointSkillAtGateway,
  removeAgentSkills,
  syncAgentSkills,
} from './agent-skills.js';

function fixture(): { home: string; sourceRoot: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-skills-'));
  const sourceRoot = path.join(root, 'skills');
  for (const name of AGENT_SKILL_NAMES) {
    mkdirSync(path.join(sourceRoot, name, 'references'), { recursive: true });
    writeFileSync(path.join(sourceRoot, name, 'SKILL.md'), [
      '---', `name: ${name}`, 'description: test', '---', '', `# ${name}`, '',
      'proxy_url="${proxy_url:-${ANTSEED_PROXY_URL:-http://127.0.0.1:8377}}"',
      'curl -H "authorization: Bearer ${ANTSEED_API_KEY:-antseed-desktop}" "$proxy_url/v1/models"',
    ].join('\n'));
    writeFileSync(path.join(sourceRoot, name, 'references', 'requests.md'), 'Bearer ${ANTSEED_API_KEY:-antseed-desktop} at http://127.0.0.1:8377\n');
  }
  const home = path.join(root, 'home');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  return { home, sourceRoot };
}

const endpoint = { origin: 'http://127.0.0.1:8379', apiKey: 'sk-antseed-test' };

test('pointSkillAtGateway swaps the buyer defaults for the gateway and the key file', () => {
  const text = pointSkillAtGateway('${ANTSEED_PROXY_URL:-http://127.0.0.1:8377} ${ANTSEED_API_KEY:-antseed-desktop}', 'https://gw.example', "/home/o'neil/.antseed/agent-skills.key");
  assert.equal(text, `\${ANTSEED_PROXY_URL:-https://gw.example} \${ANTSEED_API_KEY:-$(cat '/home/o'\\''neil/.antseed/agent-skills.key')}`);
});

test('installs the skills for one agent, pointed at the gateway, with a private key file', async () => {
  const options = fixture();
  assert.deepEqual(listAgentSkillTargets(options).filter((target) => target.detected).map((target) => target.id), ['claude-code']);

  await installAgentSkills('claude-code', endpoint, options);
  const skillsDir = path.join(options.home, '.claude', 'skills');
  const skill = readFileSync(path.join(skillsDir, 'antseed-images', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: antseed-images\n/);
  assert.match(skill, /Your Antseed gateway is at `http:\/\/127\.0\.0\.1:8379`/);
  assert.ok(!skill.includes('8377') && !skill.includes('antseed-desktop}'));
  assert.ok(readFileSync(path.join(skillsDir, 'antseed-videos', 'references', 'requests.md'), 'utf8').includes('http://127.0.0.1:8379'));
  const keyFile = agentSkillsKeyFile(options);
  assert.equal(readFileSync(keyFile, 'utf8').trim(), endpoint.apiKey);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(listAgentSkillTargets(options).find((target) => target.id === 'claude-code')?.installed, true);
});

test('sync re-points installed copies; remove deletes them and the key file', async () => {
  const options = fixture();
  await installAgentSkills('claude-code', endpoint, options);
  const next = { origin: 'https://gw.example', apiKey: 'sk-new' };
  await syncAgentSkills(next, options);
  assert.equal(readFileSync(agentSkillsKeyFile(options), 'utf8').trim(), next.apiKey);
  assert.ok(readFileSync(path.join(options.home, '.claude', 'skills', 'antseed-ask', 'SKILL.md'), 'utf8').includes(`\`${next.origin}\``));

  await removeAgentSkills('claude-code', options);
  assert.ok(!existsSync(path.join(options.home, '.claude', 'skills', 'antseed-ask')));
  assert.ok(!existsSync(agentSkillsKeyFile(options)));
});

test('never overwrites a skill folder the user made', async () => {
  const options = fixture();
  mkdirSync(path.join(options.home, '.claude', 'skills', 'antseed-images'), { recursive: true });
  await assert.rejects(installAgentSkills('claude-code', endpoint, options), /not installed by Antseed Desktop/);
  await removeAgentSkills('claude-code', options);
  assert.ok(existsSync(path.join(options.home, '.claude', 'skills', 'antseed-images')));
});

test('a conflict on a later skill changes nothing: not the key, not the earlier skills', async () => {
  const { home, sourceRoot } = fixture();
  const options = { home, sourceRoot, keyFile: path.join(home, '.antseed', 'key') };
  await installAgentSkills('claude-code', endpoint, options);
  const skillsDir = path.join(home, '.claude', 'skills');
  const first = path.join(skillsDir, AGENT_SKILL_NAMES[0]!, 'SKILL.md');
  const before = readFileSync(first, 'utf8');

  const last = AGENT_SKILL_NAMES[AGENT_SKILL_NAMES.length - 1]!;
  rmSync(path.join(skillsDir, last), { recursive: true });
  mkdirSync(path.join(skillsDir, last));
  writeFileSync(path.join(skillsDir, last, 'SKILL.md'), 'mine');

  await assert.rejects(
    installAgentSkills('claude-code', { origin: 'https://other.example', apiKey: 'sk-new' }, options),
    /already exists/,
  );
  assert.equal(readFileSync(options.keyFile, 'utf8').trim(), endpoint.apiKey);
  assert.equal(readFileSync(first, 'utf8'), before);
  assert.equal(readFileSync(path.join(skillsDir, last, 'SKILL.md'), 'utf8'), 'mine');
});

test('a failed copy changes nothing and leaves no staging folder behind', async () => {
  const { home, sourceRoot } = fixture();
  const options = { home, sourceRoot, keyFile: path.join(home, '.antseed', 'key') };
  await installAgentSkills('claude-code', endpoint, options);
  const skillsDir = path.join(home, '.claude', 'skills');
  const first = path.join(skillsDir, AGENT_SKILL_NAMES[0]!, 'SKILL.md');
  const before = readFileSync(first, 'utf8');

  rmSync(path.join(sourceRoot, AGENT_SKILL_NAMES[AGENT_SKILL_NAMES.length - 1]!), { recursive: true });
  await assert.rejects(installAgentSkills('claude-code', { origin: 'https://other.example', apiKey: 'sk-new' }, options));
  assert.equal(readFileSync(options.keyFile, 'utf8').trim(), endpoint.apiKey);
  assert.equal(readFileSync(first, 'utf8'), before);
  assert.deepEqual(readdirSync(skillsDir).sort(), [...AGENT_SKILL_NAMES].sort());
});

test('the copy prompt carries the base URL and key', () => {
  const prompt = agentSetupPrompt(endpoint);
  assert.ok(prompt.includes('http://127.0.0.1:8379/v1'));
  assert.ok(prompt.includes('sk-antseed-test'));
});
