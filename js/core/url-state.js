const UrlState = (() => {
  let _syncInterval = null;
  let _lastHash = '';

  async function encodeState(state) {
    try {
      const json = JSON.stringify(state);
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const blob = await new Response(stream).blob();
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      
      let binaryStr = '';
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binaryStr += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      
      const base64 = btoa(binaryStr);
      return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch (err) {
      console.warn('[UrlState] Failed to encode state:', err);
      return null;
    }
  }

  async function decodeState(hashStr) {
    if (!hashStr || !hashStr.startsWith('#state=')) return null;
    try {
      const base64url = hashStr.replace('#state=', '');
      const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((base64url.length + 3) % 4);
      const binaryStr = atob(base64);
      
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const json = await new Response(stream).text();
      return JSON.parse(json);
    } catch (err) {
      console.warn('[UrlState] Failed to decode state from URL:', err);
      return null;
    }
  }

  function startSync(getStateFn, intervalMs = 1000) {
    if (_syncInterval) clearInterval(_syncInterval);
    
    _lastHash = window.location.hash;

    _syncInterval = setInterval(async () => {
      const state = getStateFn();
      if (!state) return;
      
      const encoded = await encodeState(state);
      if (encoded) {
        const newHash = `#state=${encoded}`;
        // Only update if it actually changed to prevent history spam and layout thrashing
        if (newHash !== window.location.hash && newHash !== _lastHash) {
          _lastHash = newHash;
          window.history.replaceState(null, '', window.location.pathname + window.location.search + newHash);
        }
      }
    }, intervalMs);
  }

  function stopSync() {
    if (_syncInterval) {
      clearInterval(_syncInterval);
      _syncInterval = null;
    }
  }

  return { encodeState, decodeState, startSync, stopSync };
})();
