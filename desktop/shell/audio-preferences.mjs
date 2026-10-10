const endpoint = node => node.class === 'Audio/Sink' || node.class === 'Audio/Source' || node.class.startsWith('Audio/Source/');
const key = node => JSON.stringify([node.class, node.name]);
const identity = (state, node) => JSON.stringify([state.generation, node.id, node.instance]);
const equal = (field, a, b) => field === 'volume' ? typeof a === 'number' && Math.abs(a - b) < 0.0001 : a === b;
const empty = () => ({ version: 1, preferredSink: '', preferredSource: '', devices: [] });
function object(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...fields].sort().join(',');
}
function text(value, required = false) {
  return typeof value === 'string' && (!required || value.length > 0) && !value.includes('\0') &&
    value.length <= 256 && encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, 'x').length <= 256;
}
export function readAudioPreferences(value) {
  if (typeof value !== 'string' || value.length > 65536 ||
      encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, 'x').length > 65536)
    throw new RangeError('Audio preferences must fit in 64 KiB');
  return validateAudioPreferences(JSON.parse(value));
}
export function validateAudioPreferences(result) {
  if (encodeURIComponent(JSON.stringify(result)).replace(/%[0-9A-F]{2}/g, 'x').length > 65536)
    throw new RangeError('Audio preferences must fit in 64 KiB');
  if (!object(result, ['version', 'preferredSink', 'preferredSource', 'devices']) || result.version !== 1 ||
      !text(result.preferredSink) || !text(result.preferredSource) || !Array.isArray(result.devices) || result.devices.length > 256)
    throw new TypeError('Invalid audio preferences');
  const seen = new Set();
  for (const node of result.devices) {
    if (!object(node, ['name', 'class', 'volume', 'muted']) || !text(node.name, true) || !text(node.class, true) ||
        !endpoint(node) || seen.has(key(node)) ||
        (node.volume !== null && (typeof node.volume !== 'number' || !Number.isFinite(node.volume) || node.volume < 0 || node.volume > 1)) ||
        (node.muted !== null && typeof node.muted !== 'boolean'))
      throw new TypeError('Invalid or duplicate saved audio endpoint');
    seen.add(key(node));
  }
  return result;
}

export function createAudioPersistence({ native, configuration, failure, now = Date.now }) {
  let preferences = empty(), loaded = false, valid = false, dirty = false;
  const seen = new Set(), pending = new Map(), warnings = new Set();
  let generation = null, current = null;
  function warn(message) {
    if (!warnings.has(message)) { warnings.add(message); failure(new Error(message)); }
  }
  function write() {
    if (!dirty) return;
    try {
      configuration.update({ audio: preferences });
      dirty = false;
    } catch (error) {
      if (error.committed) dirty = false;
      warn(String(error));
    }
  }
  function updated(action) {
    const result = { ...preferences, devices: preferences.devices.map(node => ({ ...node })) };
    if (action.field === 'default') result[action.node.class === 'Audio/Sink' ? 'preferredSink' : 'preferredSource'] = action.value;
    else {
      let saved = result.devices.find(node => key(node) === key(action.node));
      if (!saved) {
        saved = { name: action.node.name, class: action.node.class, volume: null, muted: null };
        result.devices.push(saved);
      }
      saved[action.field] = action.value;
    }
    return validateAudioPreferences(result);
  }
  function save(action) {
    preferences = updated(action);
    dirty = true;
  }
  function value(state, node, field) {
    return field === 'default' ? state[node.class === 'Audio/Sink' ? 'preferredSink' : 'preferredSource'] : node[field];
  }
  function send(state, node, field, target, persist) {
    const id = identity(state, node) + ':' + field;
    const operation = field === 'volume' ? 'setAudioVolume' : field === 'muted' ? 'setAudioMute' : 'setDefaultAudio';
    native[operation](node.id, node.revision, ...(field === 'default' ? [] : [target]));
    seen.add(id);
    pending.set(id, { node, field, value: target, persist, deadline: now() + 5000, instance: identity(state, node) });
  }
  return {
    start() {
      if (loaded) return;
      loaded = true;
      try {
        preferences = configuration.snapshot.audio ?? empty();
        valid = true;
      } catch (error) { failure(error); }
    },
    refresh(state) {
      current = state;
      if (!valid) return;
      if (generation !== state.generation) {
        if (pending.size) warn('Audio service changed before pending settings were acknowledged.');
        pending.clear(); seen.clear(); generation = state.generation;
      }
      for (const [id, action] of pending) {
        const node = state.nodes.find(node => identity(state, node) === action.instance && key(node) === key(action.node));
        if (state.ready && node && equal(action.field, value(state, node, action.field), action.value)) {
          if (action.persist) {
            try { save(action); }
            catch (error) { warn('Audio changed, but preferences could not be saved: ' + String(error)); }
          }
          pending.delete(id);
        } else if (!state.ready || !node || now() >= action.deadline || state.error) {
          pending.delete(id);
          warn('Audio setting was not acknowledged: ' + action.node.name + ' ' + action.field);
        }
      }
      write();
      if (!state.ready || state.error) return;
      const live = new Set(state.nodes.filter(endpoint).map(node => identity(state, node)));
      for (const id of seen) {
        if (![...live].some(instance => id.startsWith(instance + ':'))) seen.delete(id);
      }
      for (const node of state.nodes.filter(endpoint)) {
        if (!node.name) continue;
        if (state.nodes.filter(peer => peer.name === node.name && endpoint(peer)).length !== 1) {
          warn('Ambiguous audio device name; saved settings not applied: ' + node.name);
          continue;
        }
        const saved = preferences.devices.find(saved => key(saved) === key(node));
        for (const field of ['volume', 'muted', 'default']) {
          const target = field === 'default' ? preferences[node.class === 'Audio/Sink' ? 'preferredSink' : 'preferredSource'] : saved?.[field];
          const id = identity(state, node) + ':' + field;
          if (seen.has(id) || target == null || (field === 'default' && target !== node.name)) continue;
          if (field !== 'default' && node[field] === null) continue;
          if (equal(field, value(state, node, field), target)) { seen.add(id); continue; }
          try { send(state, node, field, target, false); }
          catch (error) { seen.add(id); warn(String(error)); }
        }
      }
    },
    change(node, operation, target) {
      const field = operation === 'setAudioVolume' ? 'volume' : operation === 'setAudioMute' ? 'muted' : 'default';
      if (!current?.ready) throw new Error('Audio service is not ready');
      if (!valid) throw new Error('Saved audio settings are invalid; forget them before saving new settings');
      if (!endpoint(node)) {
        native[operation](node.id, node.revision, ...(target === undefined ? [] : [target]));
        return;
      }
      if (current.nodes.filter(peer => endpoint(peer) && peer.name === node.name).length !== 1)
        throw new Error('Cannot persist an ambiguous audio device name');
      updated({ node, field, value: field === 'default' ? node.name : target });
      send(current, node, field, field === 'default' ? node.name : target, true);
    },
    forget() {
      try { configuration.update({ audio: null }); }
      catch (error) { if (!error.committed) throw error; failure(error); }
      preferences = empty(); valid = true; dirty = false; pending.clear(); seen.clear(); warnings.clear();
    },
    stop() {
      if ([...pending.values()].some(action => action.persist))
        warn('Audio settings stopped before the last change was acknowledged and saved.');
      pending.clear(); seen.clear(); generation = null;
    },
    get busy() { return pending.size > 0 || dirty; },
    get status() {
      if (!valid) return 'Saved audio settings could not be read; automatic restoration is disabled.';
      const missing = [preferences.preferredSink, preferences.preferredSource].filter(name =>
        name && !current?.nodes.some(node => endpoint(node) && node.name === name));
      return missing.length ? 'Saved device unavailable; using the current fallback until it returns: ' + missing.join(', ') :
        'Device choices, endpoint volumes and microphone mute/unmute are saved after acknowledgment.';
    },
  };
}
