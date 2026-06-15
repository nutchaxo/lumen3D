/* ============================================================
   IRIBHM Microscopy Platform — Download Manifest Helpers
   ============================================================ */

const DownloadManifest = (() => {
  const GLOBAL_DOWNLOADS = [
    {
      category: 'web',
      kind: 'file',
      label: 'Full catalog',
      path: 'DATA_WEB/catalog.json',
      format: 'JSON',
      primary: true,
      description: 'Complete static catalog used by the platform.'
    }
  ];

  function forDataset(dataset) {
    if (!dataset) return GLOBAL_DOWNLOADS;
    const items = [...GLOBAL_DOWNLOADS];
    const seen = new Set(items.map(item => item.path));

    (dataset.downloads || []).forEach(item => {
      if (!item?.path || seen.has(item.path)) return;
      seen.add(item.path);
      items.push(_normalize(item));
    });

    _fallbackItems(dataset).forEach(item => {
      if (!item?.path || seen.has(item.path)) return;
      seen.add(item.path);
      items.push(_normalize(item));
    });

    return items;
  }

  function byCategory(dataset) {
    return forDataset(dataset).reduce((groups, item) => {
      const key = item.category || 'web';
      groups[key] ||= [];
      groups[key].push(item);
      return groups;
    }, {});
  }

  function _fallbackItems(dataset) {
    const items = [];
    if (dataset.thumbnail) {
      items.push({ category: 'web', kind: 'file', label: 'Thumbnail', path: dataset.thumbnail, format: 'WEBP' });
    }
    if (dataset.path) {
      items.push({ category: 'web', kind: 'file', label: 'Dataset metadata', path: `DATA_WEB/${dataset.path}/metadata.json`, format: 'JSON' });
    }
    if (dataset.tracksPath) {
      items.push({ category: 'web', kind: 'file', label: 'Tracking table', path: dataset.tracksPath, format: 'JSON' });
    }
    if (dataset.tracksGzipPath) {
      items.push({ category: 'web', kind: 'file', label: 'Compressed tracking table', path: dataset.tracksGzipPath, format: 'JSON.GZ' });
    }
    if (dataset.modelPath) {
      items.push({ category: 'web', kind: 'file', label: 'Embryo model', path: dataset.modelPath, format: 'GLB' });
    }
    if (dataset.modelGzipPath) {
      items.push({ category: 'web', kind: 'file', label: 'Compressed embryo model', path: dataset.modelGzipPath, format: 'GLB.GZ' });
    }
    (dataset.mips || []).forEach((path, idx) => {
      items.push({ category: 'web', kind: 'file', label: `Maximum projection C${idx + 1}`, path, format: 'WEBP' });
    });
    return items;
  }

  function _normalize(item) {
    return {
      category: item.category || 'web',
      kind: item.kind || (item.directory ? 'directory' : 'file'),
      label: item.label || item.path,
      path: item.path,
      format: item.format || _formatFromPath(item.path),
      sizeBytes: item.sizeBytes || item.size_bytes || null,
      large: Boolean(item.large),
      directory: Boolean(item.directory),
      count: item.count || null,
      description: item.description || '',
      primary: Boolean(item.primary)
    };
  }

  function _formatFromPath(path) {
    const match = String(path || '').match(/\.([a-z0-9.]+)$/i);
    return match ? match[1].toUpperCase() : 'FILE';
  }

  return { forDataset, byCategory };
})();
