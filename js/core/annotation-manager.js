/* ============================================================
   IRIBHM Microscopy Platform — Annotation Manager
   ============================================================ */

const AnnotationManager = (() => {
  let _items = [];
  let _onChange = null;

  function init(options = {}) {
    _items = options.items || [];
    _onChange = options.onChange || null;
  }

  function add(type, payload = {}) {
    const item = {
      id: Utils.uid(),
      type,
      createdAt: new Date().toISOString(),
      ...payload
    };
    _items.push(item);
    _onChange?.(_items);
    return item;
  }

  function remove(id) {
    _items = _items.filter(item => item.id !== id);
    _onChange?.(_items);
  }

  function clear() {
    _items = [];
    _onChange?.(_items);
  }

  function all() {
    return [..._items];
  }

  function importItems(items) {
    _items = Array.isArray(items) ? items : [];
    _onChange?.(_items);
  }

  function toJson() {
    return JSON.stringify({ version: 1, annotations: _items }, null, 2);
  }

  return { init, add, remove, clear, all, importItems, toJson };
})();
