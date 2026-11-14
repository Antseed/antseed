import { describe, expect, it } from 'vitest';
import { compile } from 'sass';
import { fileURLToPath } from 'node:url';
import { modelMenuSpace } from './useModelMenuViewport';

describe('model picker viewport', () => {
  it('bounds the home composer menu above the status bar at the reported window size', () => {
    expect(modelMenuSpace({ top: 190, bottom: 304 }, { top: 0, bottom: 618 }))
      .toEqual({ upwards: false, maxHeight: 302 });
  });

  it('recalculates on smaller and larger windows without exceeding the view', () => {
    expect(modelMenuSpace({ top: 190, bottom: 304 }, { top: 0, bottom: 500 }))
      .toEqual({ upwards: false, maxHeight: 184 });
    expect(modelMenuSpace({ top: 190, bottom: 304 }, { top: 0, bottom: 900 }))
      .toEqual({ upwards: false, maxHeight: 380 });
  });

  it('opens above a low trigger while preserving the view top inset', () => {
    expect(modelMenuSpace({ top: 400, bottom: 436 }, { top: 40, bottom: 500 }))
      .toEqual({ upwards: true, maxHeight: 348 });
  });

  it('keeps the chat header menu below its trigger in a short view', () => {
    expect(modelMenuSpace({ top: 40, bottom: 76 }, { top: 40, bottom: 300 }))
      .toEqual({ upwards: false, maxHeight: 212 });
  });

  it('never produces a negative height when the anchor is outside a tiny view', () => {
    expect(modelMenuSpace({ top: 0, bottom: 304 }, { top: 0, bottom: 100 }))
      .toEqual({ upwards: false, maxHeight: 0 });
  });

  it('makes the home menu a scroll container without compressing its rows', () => {
    const css = compile(fileURLToPath(new URL('../components/views/VprHomeView.module.scss', import.meta.url))).css;
    const menu = css.match(/\.modelMenu \{([^}]+)\}/)?.[1];
    expect(menu).toContain('overflow-y: auto');
    expect(menu).toContain('overscroll-behavior: contain');
    expect(menu).toContain('max-height: 380px');
    expect(css).toMatch(/\.modelMenu > \* \{\s*flex-shrink: 0;/);
  });
});
