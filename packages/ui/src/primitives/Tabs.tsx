import { useId, type HTMLAttributes, type ReactNode } from 'react';
import { focusSibling, rovingIndex } from './roving';

export function tabId(base: string, id: string): string {
  return `${base}-tab-${id}`;
}

export function tabPanelId(base: string, id: string): string {
  return `${base}-panel-${id}`;
}

export interface TabsProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  tabs: Array<{ id: T; label: ReactNode }>;
  /** Base id shared with the matching `TabPanel`s; generated when omitted. */
  id?: string;
  /** Accessible name of the tab list. */
  label?: string;
  className?: string;
}

/** Tab list with roving focus (arrow keys, Home/End); selection follows focus. */
export function Tabs<T extends string>({ value, onChange, tabs, id, label, className }: TabsProps<T>) {
  const autoId = useId();
  const base = id ?? autoId;
  const selected = Math.max(0, tabs.findIndex((tab) => tab.id === value));
  return (
    <div className={['as-tabs', className].filter(Boolean).join(' ')} role="tablist" aria-label={label}>
      {tabs.map((tab, index) => {
        const on = tab.id === value;
        return (
          <button
            key={tab.id}
            id={tabId(base, tab.id)}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={tabPanelId(base, tab.id)}
            tabIndex={index === selected ? 0 : -1}
            className={on ? 'as-tabs__tab as-tabs__tab--on' : 'as-tabs__tab'}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              const next = rovingIndex(event, index, tabs.length);
              if (next === null) return;
              event.preventDefault();
              onChange(tabs[next]!.id);
              focusSibling(event, next, '.as-tabs__tab');
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps extends HTMLAttributes<HTMLDivElement> {
  /** The `id` given to `Tabs`. */
  tabsId: string;
  /** The tab this panel belongs to. */
  tab: string;
  children: ReactNode;
}

export function TabPanel({ tabsId, tab, children, className, ...rest }: TabPanelProps) {
  return (
    <div
      id={tabPanelId(tabsId, tab)}
      role="tabpanel"
      aria-labelledby={tabId(tabsId, tab)}
      tabIndex={0}
      className={['as-tabpanel', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </div>
  );
}
