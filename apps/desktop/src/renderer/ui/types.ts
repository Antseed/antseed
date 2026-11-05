export const VPR_VIEW_NAMES = ['home', 'tools', 'rewards', 'preferences', 'deposit', 'chat', 'help'] as const;
export const DEV_VIEW_NAMES = ['connection', 'desktop', 'config'] as const;

export const VIEW_NAMES = [...VPR_VIEW_NAMES, ...DEV_VIEW_NAMES] as const;

export type VprViewName = (typeof VPR_VIEW_NAMES)[number];
export type DevViewName = (typeof DEV_VIEW_NAMES)[number];
export type ViewName = (typeof VIEW_NAMES)[number];
