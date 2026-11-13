import { createContext, useContext } from 'react';
import type { EpochInfo, OverviewView } from '../../src/api-types';
import type { DashboardConfig } from './api';

export type Theme = 'dark' | 'light';

export interface AppValue {
  config: DashboardConfig;
  overview: OverviewView | null;
  overviewError?: string | null;
  theme: Theme;
  toggleTheme: () => void;
}

export const AppContext = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('AppContext is not mounted');
  return value;
}

export function useConfig(): DashboardConfig {
  return useApp().config;
}

export function useEpochInfo(): EpochInfo | null {
  return useApp().overview?.epoch ?? null;
}
