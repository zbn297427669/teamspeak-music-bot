import { describe, expect, it } from 'vitest';
import {
  decodeCollapsePrefs,
  encodeCollapsePrefs,
  isCollapsed,
  toggleCollapse,
} from './radioSections.js';

describe('decodeCollapsePrefs', () => {
  it('starts empty when nothing was stored', () => {
    expect(decodeCollapsePrefs(null).size).toBe(0);
    expect(decodeCollapsePrefs('').size).toBe(0);
  });

  it('reads the current object form', () => {
    const prefs = decodeCollapsePrefs('{"favorites":true,"local":false}');
    expect(isCollapsed(prefs, 'favorites')).toBe(true);
    expect(isCollapsed(prefs, 'local')).toBe(false);
  });

  it('migrates the legacy array of collapsed keys', () => {
    const prefs = decodeCollapsePrefs('["favorites","local"]');
    expect(isCollapsed(prefs, 'favorites')).toBe(true);
    expect(isCollapsed(prefs, 'local')).toBe(true);
    expect(isCollapsed(prefs, 'directory')).toBe(false);
  });

  it('ignores junk instead of throwing', () => {
    expect(decodeCollapsePrefs('{ not json').size).toBe(0);
    expect(decodeCollapsePrefs('null').size).toBe(0);
    expect(decodeCollapsePrefs('"a string"').size).toBe(0);
    // Non-boolean values in an object are dropped, valid ones kept.
    expect([...decodeCollapsePrefs('{"a":1,"b":true}').keys()]).toEqual(['b']);
    expect([...decodeCollapsePrefs('["a",1,null]').keys()]).toEqual(['a']);
  });
});

describe('isCollapsed', () => {
  it('collapses an empty section by default', () => {
    expect(isCollapsed(new Map(), 'favorites', true)).toBe(true);
  });

  it('leaves a section with content open by default', () => {
    expect(isCollapsed(new Map(), 'favorites', false)).toBe(false);
  });

  it('lets an explicit choice win over the empty default', () => {
    // The user opened the empty section themselves.
    expect(isCollapsed(new Map([['favorites', false]]), 'favorites', true)).toBe(false);
    // The user collapsed a section that still has content.
    expect(isCollapsed(new Map([['favorites', true]]), 'favorites', false)).toBe(true);
  });
});

describe('toggleCollapse', () => {
  it('flips one section without touching the others', () => {
    const prefs = new Map([
      ['favorites', false],
      ['local', true],
    ]);
    const next = toggleCollapse(prefs, 'favorites', false);
    expect(isCollapsed(next, 'favorites')).toBe(true);
    expect(isCollapsed(next, 'local')).toBe(true);
    // The original map is not mutated, so the Vue ref can detect the change.
    expect(isCollapsed(prefs, 'favorites')).toBe(false);
  });

  it('expands an empty section that starts collapsed', () => {
    const next = toggleCollapse(new Map(), 'local', true);
    expect(isCollapsed(next, 'local', true)).toBe(false);
  });

  it('survives a storage round trip', () => {
    const next = toggleCollapse(new Map(), 'directory', false);
    const restored = decodeCollapsePrefs(encodeCollapsePrefs(next));
    expect(isCollapsed(restored, 'directory')).toBe(true);
  });
});
