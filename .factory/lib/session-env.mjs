// The settings every factory step session gets: model pin, audit headers, and the no-push / no-GitHub layers.
// Used by scripts/native-step.mjs (to write each session's --settings file) and by scripts/check-push-gap.sh
// (to prove the layers in exactly that environment).
//
// No-push layers, outermost first (each one alone refuses the push; see check-push-gap.sh):
//   1. permission deny rules for push and for anything that rewrites remotes, hooks, credentials or inline config
//   2. url.<dead>.pushInsteadOf for https://, http://, ssh:// and git@ (every remote, also explicit URLs)
//   3. remote.origin.pushurl = a dead URL
//   4. core.hooksPath = .factory/hooks, whose pre-push refuses unless FACTORY_ALLOW_PUBLISH=1
//   5. no credentials: the github.com credential helpers are reset, GH_TOKEN is unusable, prompts and ssh disabled
import { join } from 'node:path'
import { AUDIT_URL, FACTORY, PEER } from './common.mjs'

export const DEAD = 'factory-blocked-push:///'
export const DENY = [
  'Bash(git push:*)', 'Bash(git push)', 'Bash(git -C * push*)', 'Bash(git * push *)', 'Bash(git * push)',
  'Bash(git remote set-url*)', 'Bash(git remote add*)', 'Bash(git -C * remote set-url*)', 'Bash(git -C * remote add*)',
  'Bash(git config *url*)', 'Bash(git -C * config *url*)', 'Bash(git config *hooksPath*)', 'Bash(git -C * config *hooksPath*)',
  'Bash(git config *credential*)', 'Bash(git -C * config *credential*)', 'Bash(git -c *)', 'Bash(git -C * -c *)', 'Bash(git * --no-verify*)',
  'Bash(gh pr create:*)', 'Bash(gh pr merge:*)', 'Bash(gh pr comment:*)', 'Bash(gh pr review:*)', 'Bash(gh pr edit:*)', 'Bash(gh pr close:*)',
  'Bash(gh pr ready:*)', 'Bash(gh issue:*)', 'Bash(gh api:*)', 'Bash(gh repo:*)', 'Bash(gh auth:*)',
  'Bash(pnpm sandbox mainnet:*)', 'Bash(git stash:*)',
]

const gitConfig = [
  ...['https://', 'http://', 'ssh://', 'git@'].map((prefix) => [`url.${DEAD}.pushInsteadOf`, prefix]),
  ['remote.origin.pushurl', DEAD],
  ['core.hooksPath', join(FACTORY, 'hooks')],
  ['credential.helper', ''],
  ['credential.https://github.com.helper', ''],
  ['credential.https://gist.github.com.helper', ''],
]

export function noPushEnv() {
  const env = { GIT_CONFIG_COUNT: String(gitConfig.length) }
  gitConfig.forEach(([key, value], i) => { env[`GIT_CONFIG_KEY_${i}`] = key; env[`GIT_CONFIG_VALUE_${i}`] = value })
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', SSH_ASKPASS: '/bin/false', GIT_SSH_COMMAND: '/bin/false', GH_TOKEN: 'factory-sessions-have-no-github-access' }
}

export function sessionEnv(model, tag) {
  return {
    ANTHROPIC_BASE_URL: AUDIT_URL,
    ANTHROPIC_CUSTOM_HEADERS: ['x-antseed-system-proxy-source: claude-code', `x-antseed-pin-peer: ${PEER}`, `x-factory-step: ${tag}`].join('\n'),
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    DISABLE_AUTOUPDATER: '1',
    ...noPushEnv(),
  }
}

// `node lib/session-env.mjs` prints the no-push env as `export K='V'` lines for shell tests.
if (process.argv[1] && process.argv[1].endsWith('session-env.mjs')) {
  for (const [k, v] of Object.entries(noPushEnv())) console.log(`export ${k}='${v}'`)
}
