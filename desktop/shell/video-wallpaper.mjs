import { videoWallpaperPreferences } from './desktop/shared/ui/video-wallpaper.mjs';

export function createVideoWallpaper({ native, preferences, active, changed, report }) {
  let source = '', attempted = '', error = '', windows = [], previous = null, callback = null, running = false;
  function status() {
    return typeof native?.videoWallpaperState === 'function' ? native.videoWallpaperState() :
      { available: false, ready: false, paused: false, ended: false, frames: 0, width: 0, height: 0,
        loop: 0, key: '', error: '' };
  }
  function failed(failure) {
    const message = 'Video wallpaper stopped; static theme restored. ' + String(failure);
    if (error === message) return;
    error = message;
    try { if (source) native.stopVideoWallpaper(); }
    catch (cleanup) { error += ' Cleanup: ' + String(cleanup); }
    source = '';
    report('[shell] ' + error);
    changed();
  }
  function syncPause() {
    if (!source || error) return;
    const policy = preferences(), state = status();
    if (state.ended) return;
    native.pauseVideoWallpaper(policy.reducedMotion || policy.video.paused || !windows.length || !active());
  }
  return Object.freeze({
    start() {
      if (running) return;
      running = true;
      if (typeof native?.videoWallpaperState !== 'function') return;
      previous = native.onVideoWallpaperChanged;
      callback = () => {
        if (!running) return;
        try {
          const state = status();
          if (source && state.error) { failed(state.error); return; }
          syncPause();
          changed();
        } catch (failure) { failed(failure); }
        if (typeof previous === 'function') previous();
      };
      native.onVideoWallpaperChanged = callback;
    },
    setTargets(values) {
      const next = values.filter(window => !window.closed);
      if (windows.length === next.length && windows.every((window, index) => window === next[index])) return;
      try {
        if (source) native.setVideoWallpaperTargets(next);
        windows = next;
        syncPause();
      } catch (failure) { failed(failure); }
    },
    retire(window) {
      if (!windows.includes(window)) return;
      const next = windows.filter(target => target !== window && !target.closed);
      try {
        if (source) native.setVideoWallpaperTargets(next);
        windows = next;
        syncPause();
      } catch (failure) { failed(failure); }
    },
    sync() {
      if (!running) return;
      const policy = preferences();
      if (policy.mode !== 'video') {
        try { if (source) native.stopVideoWallpaper(); }
        catch (failure) { failed(failure); return; }
        source = attempted = error = '';
        return;
      }
      const video = videoWallpaperPreferences(policy.video), key = JSON.stringify([video.path, video.loop]);
      if (error || !windows.length) return;
      try {
        if (!status().available) throw new Error('This runtime excludes the optional native local-video decoder');
        if (source !== key && attempted !== key) {
          attempted = key;
          native.startVideoWallpaper(video.path, video.loop, windows,
            policy.reducedMotion || video.paused || !active());
          source = key;
        }
        syncPause();
      } catch (failure) { failed(failure); }
    },
    activity() {
      try { syncPause(); } catch (failure) { failed(failure); }
    },
    reset() {
      if (source) native.stopVideoWallpaper();
      source = attempted = error = '';
    },
    stop() {
      running = false;
      if (callback && native.onVideoWallpaperChanged === callback) native.onVideoWallpaperChanged = previous;
      callback = null;
      if (source) {
        try { native.stopVideoWallpaper(); }
        catch (failure) { report('[shell] Cannot stop video wallpaper: ' + String(failure)); }
      }
      windows = []; source = attempted = '';
    },
    snapshot() {
      const state = status();
      return { videoAvailable: state.available, videoReason: state.available ? '' :
        'This runtime excludes the optional local MP4/WebM decoder.',
      playback: { ready: !!source && state.ready && !error, paused: state.paused, ended: state.ended,
        width: state.width, height: state.height, frames: state.frames, loop: state.loop, muted: true },
      error };
    },
    view() {
      const state = status();
      return source && !error && state.ready ? { key: state.key, width: state.width, height: state.height } : null;
    },
  });
}
