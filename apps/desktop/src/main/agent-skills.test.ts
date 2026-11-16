import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WORKSPACE_APPS_DIR } from './paths.js';
import {
  agentSetupPrompt,
  agentSkillsKeyFile,
  AGENT_SKILL_NAMES,
  installAgentSkills,
  listAgentSkillTargets,
  pointSkillAtGateway,
  removeAgentSkills,
  syncAgentSkills,
  syncManagedAgentSkills,
} from './agent-skills.js';

const MISSING = '${ANTSEED_PROXY_URL:?No Antseed gateway found. Ask the user which gateway to use and do not pick one yourself.}';

function fixture(): { home: string; sourceRoot: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-skills-'));
  const sourceRoot = path.join(root, 'skills');
  for (const name of AGENT_SKILL_NAMES) {
    mkdirSync(path.join(sourceRoot, name, 'references'), { recursive: true });
    writeFileSync(path.join(sourceRoot, name, 'SKILL.md'), [
      '---', `name: ${name}`, 'description: test', '---', '', `# ${name}`, '',
      `proxy_url="\${proxy_url:-${MISSING}}"`,
      'Or their own CLI buyer at `http://127.0.0.1:8377`, if they say so.',
      'curl -H "authorization: Bearer ${ANTSEED_API_KEY:-antseed-desktop}" "$proxy_url/v1/models"',
    ].join('\n'));
    writeFileSync(path.join(sourceRoot, name, 'references', 'requests.md'), `proxy_url="\${proxy_url:-${MISSING}}"\nBearer \${ANTSEED_API_KEY:-antseed-desktop}\n`);
  }
  const home = path.join(root, 'home');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  return { home, sourceRoot };
}

const endpoint = { origin: 'http://127.0.0.1:8379', apiKey: 'sk-antseed-test' };

test('pointSkillAtGateway swaps the missing-gateway stop for the gateway, and the default key for the key file', () => {
  const text = pointSkillAtGateway(`${MISSING} \${ANTSEED_API_KEY:-antseed-desktop}`, 'https://gw.example', "/home/o'neil/.antseed/agent-skills.key");
  assert.equal(text, `\${ANTSEED_PROXY_URL:-https://gw.example} \${ANTSEED_API_KEY:-$(cat '/home/o'\\''neil/.antseed/agent-skills.key')}`);
  // The CLI buyer the skill may offer the user keeps its own address.
  assert.equal(pointSkillAtGateway('their own CLI buyer at `http://127.0.0.1:8377`', 'https://gw.example', '/k'), 'their own CLI buyer at `http://127.0.0.1:8377`');
});

test('the real skills, once installed, use this gateway and key with nothing set', async () => {
  const options = { ...fixture(), sourceRoot: path.resolve(WORKSPACE_APPS_DIR, '..', 'skills') };
  await installAgentSkills('claude-code', endpoint, { ...options, keyFile: path.join(options.home, '.antseed', 'key') });
  const skillsDir = path.join(options.home, '.claude', 'skills');
  const files = ['antseed-ask/SKILL.md', 'antseed-images/SKILL.md', 'antseed-videos/references/requests.md'];
  for (const file of files) {
    const text = readFileSync(path.join(skillsDir, file), 'utf8');
    assert.ok(!text.includes('ANTSEED_PROXY_URL:?'), `${file} still stops for a missing gateway`);
    const line = text.split('\n').find((candidate) => candidate.startsWith('proxy_url='));
    assert.ok(line, `${file} has its gateway line`);
    const run = spawnSync('bash', ['-c', `${line}\nprintf '%s' "$proxy_url"`], { env: { PATH: process.env['PATH'] ?? '' }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, endpoint.origin, file);
  }
});

test('installs the skills for one agent, pointed at the gateway, with a private key file', async () => {
  const options = fixture();
  assert.deepEqual(listAgentSkillTargets(options).filter((target) => target.detected).map((target) => target.id), ['claude-code']);

  await installAgentSkills('claude-code', endpoint, options);
  const skillsDir = path.join(options.home, '.claude', 'skills');
  const skill = readFileSync(path.join(skillsDir, 'antseed-images', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: antseed-images\n/);
  assert.match(skill, /Your Antseed gateway is at `http:\/\/127\.0\.0\.1:8379`/);
  assert.ok(!skill.includes('ANTSEED_PROXY_URL:?') && !skill.includes('antseed-desktop}'));
  assert.ok(skill.includes('${ANTSEED_PROXY_URL:-http://127.0.0.1:8379}'));
  // The CLI buyer option keeps its own address.
  assert.ok(skill.includes('CLI buyer at `http://127.0.0.1:8377`'));
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

test('a sync that fails for any agent changes neither the key nor any installed copy', async () => {
  const options = fixture();
  await installAgentSkills('claude-code', endpoint, options);
  await installAgentSkills('codex', endpoint, options);
  const skill = path.join(options.home, '.claude', 'skills', 'antseed-ask', 'SKILL.md');
  const before = readFileSync(skill, 'utf8');
  rmSync(options.sourceRoot, { recursive: true });
  await assert.rejects(syncAgentSkills({ origin: 'https://gw.example', apiKey: 'sk-new' }, options));
  assert.equal(readFileSync(agentSkillsKeyFile(options), 'utf8').trim(), endpoint.apiKey);
  assert.equal(readFileSync(skill, 'utf8'), before);
});

test('a key that cannot be written puts every swapped copy back', async () => {
  const options = fixture();
  await installAgentSkills('claude-code', endpoint, options);
  await installAgentSkills('codex', endpoint, options);
  const skills = [path.join(options.home, '.claude', 'skills', 'antseed-ask', 'SKILL.md'), path.join(options.home, '.agents', 'skills', 'antseed-ask', 'SKILL.md')];
  const before = skills.map((file) => readFileSync(file, 'utf8'));
  chmodSync(agentSkillsKeyFile(options), 0o400);
  await assert.rejects(syncAgentSkills({ origin: 'https://gw.example', apiKey: 'sk-new' }, options));
  chmodSync(agentSkillsKeyFile(options), 0o600);
  assert.deepEqual(skills.map((file) => readFileSync(file, 'utf8')), before);
  assert.equal(readFileSync(agentSkillsKeyFile(options), 'utf8').trim(), endpoint.apiKey);
  assert.deepEqual(readdirSync(path.join(options.home, '.claude', 'skills')).filter((name) => name.startsWith('.antseed-install-')), []);
});

test('installing one agent after a failed sync never leaves another agent naming the old gateway with the new key', async () => {
  const options = fixture();
  await installAgentSkills('claude-code', endpoint, options);
  await installAgentSkills('codex', endpoint, options);
  const codexDir = path.join(options.home, '.agents', 'skills');
  const codexSkill = path.join(codexDir, 'antseed-ask', 'SKILL.md');
  const next = { origin: 'https://gw-b.example', apiKey: 'sk-gateway-b' };
  // Codex's skills folder can't be written, so the switch to gateway B fails for every agent.
  chmodSync(codexDir, 0o500);
  try {
    await assert.rejects(syncAgentSkills(next, options));
    // Adding the skills again to the agent that can be written: B's key must not
    // land in the shared key file while Codex still sends it to gateway A.
    await assert.rejects(installAgentSkills('claude-code', next, options));
    assert.equal(readFileSync(agentSkillsKeyFile(options), 'utf8').trim(), endpoint.apiKey);
    assert.ok(readFileSync(codexSkill, 'utf8').includes(`\`${endpoint.origin}\``));
  } finally {
    chmodSync(codexDir, 0o700);
  }
  // Once Codex can be written, installing one agent puts every agent on B.
  await installAgentSkills('claude-code', next, options);
  assert.equal(readFileSync(agentSkillsKeyFile(options), 'utf8').trim(), next.apiKey);
  assert.ok(readFileSync(codexSkill, 'utf8').includes(`\`${next.origin}\``));
});

test('a partly removed agent is re-pointed with the rest, so none of its skills pairs the old gateway with the new key', async () => {
  const options = fixture();
  await installAgentSkills('claude-code', endpoint, options);
  await installAgentSkills('codex', endpoint, options);
  // One of Codex's skills is deleted by hand; the others still read the shared key file.
  const codexDir = path.join(options.home, '.agents', 'skills');
  rmSync(path.join(codexDir, AGENT_SKILL_NAMES[0]), { recursive: true, force: true });
  const next = { origin: 'https://gw-b.example', apiKey: 'sk-gateway-b' };
  await syncAgentSkills(next, options);
  assert.equal(readFileSync(agentSkillsKeyFile(options), 'utf8').trim(), next.apiKey);
  for (const name of AGENT_SKILL_NAMES) {
    const skill = readFileSync(path.join(codexDir, name, 'SKILL.md'), 'utf8');
    assert.ok(skill.includes(`\`${next.origin}\``), `${name} names gateway B`);
    assert.ok(!skill.includes(`\`${endpoint.origin}\``), `${name} no longer names gateway A`);
  }

  // Removing the fully installed agent keeps the key file while a partly installed one still reads it.
  rmSync(path.join(codexDir, AGENT_SKILL_NAMES[0]), { recursive: true, force: true });
  await removeAgentSkills('claude-code', options);
  assert.ok(existsSync(agentSkillsKeyFile(options)));
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
  // It tells the agent the key is a secret to store, not print.
  assert.match(prompt, /secret/);
});

test('the automatic sync re-points an agent whose only install lost a skill, and asks for no key when none is left', async () => {
  const options = fixture();
  await installAgentSkills('claude-code', endpoint, options);
  const skillsDir = path.join(options.home, '.claude', 'skills');
  rmSync(path.join(skillsDir, AGENT_SKILL_NAMES[0]), { recursive: true, force: true });
  assert.equal(listAgentSkillTargets(options).some((target) => target.installed), false);
  const next = { origin: 'https://gw-b.example', apiKey: 'sk-gateway-b' };
  let asked = 0;
  await syncManagedAgentSkills(async () => { asked += 1; return next; }, options);
  assert.equal(asked, 1);
  assert.equal(readFileSync(agentSkillsKeyFile(options), 'utf8').trim(), next.apiKey);
  for (const name of AGENT_SKILL_NAMES.slice(1)) {
    assert.ok(readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8').includes(`\`${next.origin}\``), `${name} names gateway B`);
  }

  await removeAgentSkills('claude-code', options);
  await syncManagedAgentSkills(async () => { asked += 1; return next; }, options);
  assert.equal(asked, 1);
});

test('a removal requested while a sync is staging its copies stays removed', async () => {
  const options = fixture();
  await installAgentSkills('claude-code', endpoint, options);
  let staged!: () => void;
  const reachedStaging = new Promise<void>((resolve) => { staged = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const sync = syncAgentSkills({ ...endpoint, apiKey: 'sk-antseed-next' }, { ...options, onStaged: () => { staged(); return held; } });
  await reachedStaging;
  const removal = removeAgentSkills('claude-code', options);
  release();
  await Promise.all([sync, removal]);
  const skillsDir = path.join(options.home, '.claude', 'skills');
  assert.deepEqual(AGENT_SKILL_NAMES.filter((name) => existsSync(path.join(skillsDir, name))), []);
  assert.equal(existsSync(agentSkillsKeyFile(options)), false);
});
