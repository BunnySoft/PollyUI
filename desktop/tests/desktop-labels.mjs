import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';
register('./root-loader.mjs', import.meta.url);
const { parseThemeCatalog, parseThemeFile, applyThemeOverrides } = await import('../shared/ui/theme-schema.mjs');
const { desktopView } = await import('../shell/desktop-view.mjs');
const catalog = parseThemeCatalog(readFileSync(new URL('../resources/themes/builtin.json', import.meta.url), 'utf8'));
const recovery = parseThemeCatalog(readFileSync(new URL('../resources/themes/fallback.json', import.meta.url), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const find = (node, id) => node.props?.id === id ? node : node.children?.map(child => find(child, id)).find(Boolean);
const item = { id: 'fixture', name: 'Long \u4e2d\u6587\napplication \ud83d\udcda e\u0301', x: 117, y: 231 };
const labelView = (theme, selected = false, images = new Map()) => {
  const view = desktopView(theme, '', { items: [item], selected: new Set(selected ? [item.id] : []),
    focused: item.id }, [item], '', images);
  return find(view, 'shell-desktop-icon-fixture');
};
const parseFile = theme => parseThemeFile(JSON.stringify({ schemaVersion: 1, theme }));
const override = (id, value) => applyThemeOverrides(catalog, JSON.stringify({ schemaVersion: 1,
  themes: { [id]: { icons: { desktopLabelStyle: value } } } }));

test('only reference-qualified presets enable shadow; builtin and recovery remain identical', () => {
  assert.deepEqual(catalog, recovery);
  assert.deepEqual(catalog.themes.filter(theme => theme.icons.desktopLabelStyle === 'shadow').map(theme => theme.id),
    ['aqua', 'bigsur']);
});
test('optional appearance validates through file/catalog/overrides and old schema-1 files remain accepted', () => {
  for (const theme of catalog.themes) {
    const legacy = clone(theme);
    delete legacy.icons.desktopLabelStyle;
    assert.equal(parseFile(legacy).icons.desktopLabelStyle, undefined);
    for (const style of ['capsule', 'shadow']) {
      const custom = { ...legacy, id: 'user-label', icons: { ...legacy.icons, desktopLabelStyle: style } };
      assert.equal(parseFile(custom).icons.desktopLabelStyle, style);
      assert.equal(parseThemeCatalog(JSON.stringify({ schemaVersion: 1, default: custom.id,
        themes: [custom] })).themes[0].icons.desktopLabelStyle, style);
      assert.equal(override(theme.id, style).themes.find(value => value.id === theme.id).icons.desktopLabelStyle, style);
    }
    for (const value of ['', 'transparent', 'Shadow', null, true, 1, {}, []]) {
      const bad = { ...legacy, icons: { ...legacy.icons, desktopLabelStyle: value } };
      assert.throws(() => parseFile(bad), /icons.desktopLabelStyle is unsupported/);
      assert.throws(() => parseThemeCatalog(JSON.stringify({ schemaVersion: 1, default: bad.id,
        themes: [bad] })), /icons.desktopLabelStyle is unsupported/);
      assert.throws(() => override(theme.id, value), /icons.desktopLabelStyle is unsupported/);
    }
  }
});
test('missing optional appearance is structurally identical to explicit original capsules', () => {
  for (const theme of catalog.themes) {
    const legacy = clone(theme); delete legacy.icons.desktopLabelStyle;
    const explicit = { ...theme, icons: { ...theme.icons, desktopLabelStyle: 'capsule' } };
    for (const selected of [false, true]) {
      assert.deepEqual(labelView(legacy, selected), labelView(explicit, selected));
      const node = labelView(legacy, selected), label = node.children[1];
      assert.equal(node.props.style.left, item.x);
      assert.equal(node.props.style.top, item.y);
      assert.equal(label.props.style.backgroundColor, selected ? theme.colors.selection : '#243348');
      assert.equal(label.children.length, 1);
      assert.equal(label.children[0].props.nodeValue, item.name);
    }
  }
});
test('shadow adds one hidden, noninteractive native text copy without changing foreground or option contracts', () => {
  for (const theme of catalog.themes) {
    const shadowTheme = { ...theme, icons: { ...theme.icons, desktopLabelStyle: 'shadow' } };
    for (const images of [new Map(), new Map([[item.id, 'polly-memory:fixture']])]) {
      const node = labelView(shadowTheme, false, images), label = node.children[1];
      const [shadow, foreground] = label.children;
      assert.equal(label.props.style.backgroundColor, 'transparent');
      assert.equal(label.props.style.maxWidth, 86);
      assert.equal(label.props.style.maxHeight, 44);
      assert.equal(label.props.style.fontSize, 12);
      assert.equal(label.props.style.overflow, 'hidden');
      assert.equal(label.props.style.padding, 2);
      assert.equal(shadow.props['aria-hidden'], 'true');
      assert.equal(shadow.props.style.pointerEvents, 'none');
      assert.equal(shadow.props.style.left, 2);
      assert.equal(shadow.props.style.right, 2);
      assert.equal(shadow.props.style.top, 3);
      assert.equal(shadow.props.style.fontSize, 12);
      assert.equal(shadow.children[0].props.nodeValue, foreground.props.nodeValue);
      assert.equal(foreground.props.nodeValue, item.name);
      assert.equal(node.props.role, 'option');
      assert.equal(node.props['aria-label'], item.name);
      assert.equal(node.props.tabIndex, 0);
      assert.equal(node.children[0].props.style.width, 36);
      assert.equal(node.children[0].props.style.height, 36);
      assert.deepEqual(labelView(shadowTheme, true, images), labelView(theme, true, images),
        'selection keeps the same node structure, colors, hover and focus contract');
    }
  }
});
