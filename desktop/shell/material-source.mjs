import { MATERIAL_SOURCE_LIMIT } from './desktop/client/settings-contract.mjs';

// Only the Shell's committed asset handle enters this projection, never a client path or scene.
export function createMaterialSource({ document, bitmap }) {
  let signature = '', cached = null, failure = null;
  return Object.freeze({
    read({ themeId, revision, asset }) {
      if (!asset) throw new Error('The current wallpaper has no bitmap material source');
      const key = JSON.stringify([themeId, asset]);
      if (key !== signature) {
        signature = key; cached = null; failure = null;
        let canvas = null;
        try {
          const source = bitmap(asset);
          if (!source || source.closed || !Number.isInteger(source.width) || source.width < 1 ||
              !Number.isInteger(source.height) || source.height < 1)
            throw new Error('The committed wallpaper bitmap is no longer available');
          const scale = Math.min(1, 128 / Math.max(source.width, source.height));
          const width = Math.max(1, Math.round(source.width * scale));
          const height = Math.max(1, Math.round(source.height * scale));
          canvas = document().createElement('canvas');
          canvas.height = 0; canvas.width = width; canvas.height = height;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Material projection requires Canvas 2D');
          context.drawImage(source, 0, 0, width, height);
          const dataURL = canvas.toDataURL('image/png');
          if (!dataURL.startsWith('data:image/png;base64,') || dataURL.length > MATERIAL_SOURCE_LIMIT)
            throw new Error('Wallpaper material PNG exceeds its projection limit');
          cached = Object.freeze({ width, height, dataURL });
        } catch (error) { failure = error; throw error; }
        finally { if (canvas) canvas.width = canvas.height = 0; }
      }
      if (failure) throw failure;
      return { version: 1, revision, themeId, ...cached };
    },
    close() { signature = ''; cached = null; failure = null; },
  });
}
