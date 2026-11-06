/* Graphs — engine-worker.js
 *
 * The query engine of the Graphs plugin, off the page's thread. The engine is the one
 * index.js defines (loaded here on its own: index.js stops before its plugin part when
 * there is no PluginRegistry), so a query gives the same numbers here and in the
 * page's fallback.
 *
 * Messages, page → worker (answer {id, ok, result} or {id, ok:false, code}):
 *   {id, op:'load',    key, table}     a table (data only; lazy axes as descriptors)
 *   {id, op:'column',  key, col, data} a column the page computed (a lazy function)
 *   {id, op:'compute', key, spec}      one query
 *   {op:'drop', key}                   forget a table (no answer)
 * The page keeps one query in flight per caller, so queries never queue up here.
 */
importScripts('index.js');

const tables = new Map();

function answer(msg) {
  const id = msg && msg.id;
  try {
    switch (msg && msg.op) {
      case 'load':
        tables.set(msg.key, msg.table);
        return { id, ok: true, result: null };
      case 'column': {
        const tb = tables.get(msg.key);
        if (!tb) return { id, ok: false, code: 'NO_TABLE' };
        tb.cols[msg.col] = msg.data;
        return { id, ok: true, result: null };
      }
      case 'compute': {
        const tb = tables.get(msg.key);
        if (!tb) return { id, ok: false, code: 'NO_TABLE' };
        return { id, ok: true, result: self.GraphsEngine.compute(tb, msg.spec || {}) };
      }
      case 'drop':
        tables.delete(msg.key);
        return null;
      default:
        return { id, ok: false, code: 'BAD_REQUEST' };
    }
  } catch (err) {
    if (!(err && err.code)) console.error('[graphs] engine worker query failed:', err);
    return { id, ok: false, code: (err && err.code) || 'GRAPH_FAILED' };
  }
}

self.onmessage = (e) => {
  const reply = answer(e.data);
  if (reply) self.postMessage(reply);
};
