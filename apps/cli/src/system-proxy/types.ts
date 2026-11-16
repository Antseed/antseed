export type SystemProxySource = string

export type SystemProxyJsonPath = readonly string[]

export type SystemProxyRequestTransform =
  | {
    readonly kind: 'chat-completions-from-messages'
    readonly messagesPath: SystemProxyJsonPath
    readonly modelPath?: SystemProxyJsonPath
    readonly missingModel?: string
    readonly stream?: boolean
  }
  | {
    readonly kind: 'responses-from-messages'
    readonly messagesPath: SystemProxyJsonPath
    readonly modelPath?: SystemProxyJsonPath
    readonly stream?: boolean
  }

export type SystemProxyResponseTransform =
  | {
    readonly kind: 'conversation-sse'
    readonly assistantParent?: 'request-parent' | 'user-message'
  }
  | {
    readonly kind: 'responses-sse'
    readonly injectResponseId?: boolean
    readonly stripDataType?: boolean
    readonly stripItemPhase?: boolean
    readonly emptyContentPartDoneText?: boolean
    readonly emptyOutputItemDoneContent?: boolean
    readonly messageOutputIndex?: number
    readonly messageItemId?: string
  }

export interface SystemProxyCorsRule {
  readonly allowOrigin?: 'request' | '*' | string
  readonly allowCredentials?: boolean
  readonly allowMethods?: readonly string[]
  readonly allowHeaders?: 'request' | readonly string[]
  readonly exposeHeaders?: readonly string[]
  readonly maxAgeSeconds?: number
}

export interface SystemProxyForwardRule {
  readonly source: SystemProxySource
  readonly targetPath?: string
  readonly headers?: 'preserve' | 'browser-sse'
  readonly stripHeaders?: readonly string[]
  readonly request?: SystemProxyRequestTransform
  readonly response?: SystemProxyResponseTransform
  readonly cors?: SystemProxyCorsRule
}

/**
 * Config patches are applied by the desktop app, not the CLI child — the CLI
 * only needs to know a profile is config-patch kind. The patch payload is
 * format-specific (opencode JSONC, codex TOML, pi models.json), so beyond the
 * common keys it is passed through untouched.
 */
export interface SystemProxyConfigPatch {
  readonly configPath: string
  /** Absent for formats without a provider entry (claude-desktop). */
  readonly providerKey?: string
  readonly [key: string]: unknown
}

export interface SystemProxyProfileMetadata {
  readonly icon?: string
  readonly displayLabel?: string
  readonly methodLabel?: string
  readonly appAction?: 'none' | 'open-url' | 'open-tool' | 'restart-app'
  readonly openUrl?: string
  readonly toolName?: string
  readonly restartAppName?: string
}

export interface SystemProxyProfile {
  readonly name: string
  readonly displayName: string
  readonly kind?: 'proxy' | 'config-patch'
  readonly domains: readonly string[]
  readonly pathPrefixes: readonly string[]
  readonly forward?: SystemProxyForwardRule
  readonly configPatch?: SystemProxyConfigPatch
  readonly metadata?: SystemProxyProfileMetadata
}

export interface SystemProxyState {
  port: number
  peerId: string
  defaultModel?: string
  activeProfileNames: string[]
  running: boolean
}
