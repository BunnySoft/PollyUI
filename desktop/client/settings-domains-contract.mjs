import { validateShortcuts } from './desktop/shared/shortcuts.mjs';

export function fields(value, keys, label = 'Settings payload') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))
    throw new TypeError('Invalid ' + label + ' fields');
}
export function text(value, limit = 16384) {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0'))
    throw new TypeError('Invalid Settings text');
}
export function number(value, minimum, maximum, integer = true) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum ||
      (integer && !Number.isInteger(value))) throw new TypeError('Invalid Settings numeric field');
}
export function token(value, zero = false) { number(value, zero ? 0 : 1, 0xffffffff); }
function boolean(value) { if (typeof value !== 'boolean') throw new TypeError('Invalid Settings boolean'); }
export function payload(source) { text(source, 1024 * 1024); return JSON.parse(source); }
const identityFields = ['id', 'name', 'make', 'model', 'serialNumber'];
const geometryFields = ['enabled', 'width', 'height', 'refresh', 'x', 'y', 'scale', 'transform', 'adaptiveSync'];
export const displayIdentity = head => JSON.stringify(identityFields.map(key => head[key]));
export function validateDisplayDraft(value, snapshot = false) {
  fields(value, ['serial', 'heads']); token(value.serial, true);
  if (!Array.isArray(value.heads) || value.heads.length > 32) throw new TypeError('Invalid display list');
  const seen = new Set();
  for (const head of value.heads) {
    fields(head, [...identityFields, ...geometryFields, ...(snapshot ? ['description', 'modes'] : [])], 'display head');
    token(head.id);
    for (const key of identityFields.slice(1)) text(head[key], 256);
    if (seen.has(head.id)) throw new TypeError('Duplicate display head');
    seen.add(head.id); boolean(head.enabled); boolean(head.adaptiveSync);
    for (const key of ['width', 'height']) number(head[key], 0, 16384);
    number(head.refresh, 0, 1000000); number(head.scale, 0.25, 4, false); number(head.transform, 0, 7);
    number(head.x, -32768, 32768); number(head.y, -32768, 32768);
    if (head.enabled && (!head.width || !head.height || head.width * head.height > 32 * 1024 * 1024 ||
        head.width / head.scale > 32700 || head.height / head.scale > 32700))
      throw new TypeError('Display geometry exceeds supported bounds');
    if (snapshot) {
      text(head.description, 1024);
      if (!Array.isArray(head.modes) || head.modes.length > 256) throw new TypeError('Invalid display modes');
      for (const mode of head.modes) {
        fields(mode, ['width', 'height', 'refresh', 'preferred']);
        number(mode.width, 1, 16384); number(mode.height, 1, 16384);
        number(mode.refresh, 0, 1000000); boolean(mode.preferred);
      }
    }
  }
  if (!snapshot && (!value.heads.length || !value.heads.some(head => head.enabled)))
    throw new TypeError('At least one display must remain enabled');
  return value;
}
export function displayDraft(value) {
  return validateDisplayDraft({ serial: value.serial,
    heads: value.heads.map(head => Object.fromEntries([...identityFields, ...geometryFields].map(key => [key, head[key]]))) });
}
export function parseDisplays(source) {
  const value = payload(source);
  fields(value, ['version', 'available', 'error', 'status', 'serial', 'pendingToken', 'remainingMs',
    'outcome', 'message', 'heads']);
  if (value.version !== 1) throw new TypeError('Unknown display snapshot');
  boolean(value.available); text(value.error); text(value.status); text(value.message);
  token(value.pendingToken, true); number(value.remainingMs, 0, 15000, false); number(value.outcome, 0, 3);
  validateDisplayDraft({ serial: value.serial, heads: value.heads }, true);
  return value;
}
export function parseAudio(source) {
  const value = payload(source);
  fields(value, ['version', 'available', 'ready', 'revision', 'generation', 'error', 'status', 'busy',
    'defaultSink', 'defaultSource', 'preferredSink', 'preferredSource', 'nodes']);
  if (value.version !== 1) throw new TypeError('Unknown audio snapshot');
  for (const key of ['available', 'ready', 'busy']) boolean(value[key]);
  token(value.revision, true); token(value.generation, true); text(value.error); text(value.status);
  text(value.preferredSink, 256); text(value.preferredSource, 256);
  for (const key of ['defaultSink', 'defaultSource']) if (value[key] !== null) token(value[key], true);
  if (!Array.isArray(value.nodes) || value.nodes.length > 1024) throw new TypeError('Invalid audio nodes');
  const seen = new Set();
  for (const node of value.nodes) {
    fields(node, ['id', 'revision', 'instance', 'name', 'description', 'class', 'state', 'volume', 'muted']);
    token(node.id, true); token(node.revision); text(node.instance, 256); text(node.name, 256);
    text(node.description, 1024); text(node.class, 256); text(node.state, 256);
    if (seen.has(node.id)) throw new TypeError('Duplicate audio node');
    seen.add(node.id);
    if (node.volume !== null) number(node.volume, 0, 100, false);
    if (node.muted !== null) boolean(node.muted);
  }
  return value;
}
export function parseAudioAction(source) {
  const value = payload(source);
  fields(value, ['generation', 'id', 'revision', 'instance', 'operation', 'value']);
  token(value.generation); token(value.id, true); token(value.revision); text(value.instance, 256);
  if (value.operation === 'volume') number(value.value, 0, 1, false);
  else if (value.operation === 'mute') boolean(value.value);
  else if (value.operation !== 'default' || value.value !== null) throw new TypeError('Unknown audio action');
  return value;
}
export function parseKeyboard(source) {
  const value = payload(source);
  fields(value, ['version', 'available', 'revision', 'error', 'bindings', 'recording']);
  if (value.version !== 1) throw new TypeError('Unknown keyboard snapshot');
  boolean(value.available); token(value.revision); text(value.error);
  if (value.available) {
    if (!Array.isArray(value.bindings)) throw new TypeError('Invalid shortcut catalog');
    validateShortcuts(value.bindings.map(binding => {
      fields(binding, ['action', 'label', 'key', 'modifiers']); text(binding.label, 256);
      return { action: binding.action, key: binding.key, modifiers: binding.modifiers };
    }));
  } else if (!Array.isArray(value.bindings) || value.bindings.length) throw new TypeError('Unavailable shortcut catalog');
  if (value.recording !== null) {
    fields(value.recording, ['token', 'action', 'status']);
    token(value.recording.token);
    if (!value.bindings.some(binding => binding.action === value.recording.action) ||
        !['waiting-focus', 'recording'].includes(value.recording.status))
      throw new TypeError('Invalid shortcut recording');
  }
  return value;
}
export function parseKeyboardAction(source) {
  const value = payload(source);
  fields(value, ['revision', 'operation', 'action']); token(value.revision); text(value.action, 64);
  if (!['disable', 'reset', 'record'].includes(value.operation) ||
      (value.operation === 'reset' && value.action !== '')) throw new TypeError('Unknown shortcut action');
  return value;
}
