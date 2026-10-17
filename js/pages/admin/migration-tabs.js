/**
 * Admin SPA — several "Data updates" tabs of one browser (SPEC §7.3)
 * =================================================================
 * Every tab of the admin panel has its own NetGovernor and its own worker pool. Two tabs that
 * each convert a dataset would together send twice the requests the host tolerates (the
 * firewall of a shared host bans the address, SPEC §7.2), and two tabs on the same dataset
 * would compute every unit twice. The tabs of one origin therefore talk over a
 * BroadcastChannel:
 *
 *   * presence: each tab says every HEARTBEAT_MS whether it is converting and which datasets
 *     it holds; a tab silent for PEER_TTL_MS (closed, crashed, frozen in the background) is
 *     forgotten, and a closing tab says goodbye at once;
 *   * one quota: the N tabs converting at the same time each take 1/N of the governor's
 *     limits (requests in flight, requests per second, burst), so their sum stays the page's
 *     limits; a tab that sees no answer, a 429 or a 503 tells the others, and every tab halves
 *     its rate and holds its requests for the same cooldown;
 *   * one tab per dataset: a tab converts a dataset only while it holds the Web Lock named
 *     after it (`navigator.locks`, exclusive across the tabs of the origin and released by the
 *     browser when the tab goes away). Without Web Locks the heartbeat's claims stand in: a
 *     dataset another live tab holds is left to it.
 *
 * The channel name carries the panel's directory, so two installs on one origin do not mix.
 */

'use strict';

export const HEARTBEAT_MS = 2000;
export const PEER_TTL_MS = 6500;

export class TabCoordinator {
  /**
   * @param {object} o
   *   governor   the page's NetGovernor (setShare / penalize / onThrottle)
   *   scope      a string naming this install (default: the page's directory)
   *   channel    a BroadcastChannel-like object (tests); default new BroadcastChannel(name)
   *   locks      a LockManager-like object (tests); default navigator.locks when present
   *   now, setInterval, clearInterval   clocks (tests)
   *   onChange   called when another tab's state changes
   */
  constructor(o = {}) {
    this.o = o;
    this.id = o.id || Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.scope = o.scope || defaultScope();
    this.now = o.now || (() => Date.now());
    this.peers = new Map();        // id → { at, active, datasets: Set }
    this.held = new Map();         // dataset → release()
    this.active = false;
    this.locks = o.locks !== undefined ? o.locks
      : (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function' ? navigator.locks : null);
    let ch = o.channel || null;
    if (!ch && typeof BroadcastChannel !== 'undefined') {
      try { ch = new BroadcastChannel('lumen3d-migrations:' + this.scope); } catch (_) { ch = null; }
    }
    this.channel = ch;
    if (ch) {
      const onMsg = (e) => this._onMessage(e && e.data);
      if (typeof ch.addEventListener === 'function') ch.addEventListener('message', onMsg); else ch.onmessage = onMsg;
    }
    const gov = o.governor || null;
    this.governor = gov;
    if (gov) gov.onThrottle = (cooldownMs) => this._post({ type: 'throttle', cooldownMs });
    const si = o.setInterval || ((fn, ms) => setInterval(fn, ms));
    this._clear = o.clearInterval || ((h) => clearInterval(h));
    this._timer = si(() => { this._expire(); this._beat(); }, HEARTBEAT_MS);
    this._post({ type: 'hello', id: this.id });
    this._beat();
  }

  /** This tab is converting (a lane runs) or not: it takes its share of the quota only then. */
  setActive(on) {
    on = !!on;
    if (on === this.active) return;
    this.active = on;
    this._applyShare();
    this._beat();
  }

  /** Tabs converting now, this one included when it is. */
  activeTabs() {
    let n = this.active ? 1 : 0;
    for (const p of this.peers.values()) if (p.active) n++;
    return n;
  }

  /** True when another live tab holds `dataset`. */
  heldElsewhere(dataset) {
    if (this.held.has(dataset)) return false;
    for (const p of this.peers.values()) if (p.datasets.has(dataset)) return true;
    return false;
  }

  /**
   * Takes `dataset` for this tab: resolves release() — call it when the tab is done with the
   * dataset — or null when another tab has it.
   */
  async claim(dataset) {
    const prev = this.held.get(dataset);
    if (prev) return prev;
    if (this.locks) {
      return new Promise((resolve) => {
        let settled = false;
        const p = this.locks.request(this._lockName(dataset), { ifAvailable: true }, (lock) => {
          if (!lock) { settled = true; resolve(null); return undefined; }
          return new Promise((unlock) => {
            const release = () => {
              if (this.held.get(dataset) !== release) return;
              this.held.delete(dataset);
              unlock();
              this._beat();
            };
            this.held.set(dataset, release);
            settled = true;
            resolve(release);
            this._beat();
          });
        });
        Promise.resolve(p).catch(() => { if (!settled) resolve(null); });
      });
    }
    if (this.heldElsewhere(dataset)) return null;
    const release = () => {
      if (this.held.get(dataset) !== release) return;
      this.held.delete(dataset);
      this._beat();
    };
    this.held.set(dataset, release);
    this._beat();
    return release;
  }

  /** Lets every dataset go and says goodbye (the page is closing). */
  close() {
    for (const release of [...this.held.values()]) release();
    this._post({ type: 'bye', id: this.id });
    if (this._timer != null) this._clear(this._timer);
    this._timer = null;
    try { this.channel && typeof this.channel.close === 'function' && this.channel.close(); } catch (_) { /* gone */ }
  }

  _lockName(dataset) { return `lumen3d-mig:${this.scope}:${dataset}`; }

  _post(msg) {
    if (!this.channel) return;
    try { this.channel.postMessage({ ...msg, id: this.id }); } catch (_) { /* closed */ }
  }

  _beat() {
    this._post({ type: 'state', active: this.active, datasets: [...this.held.keys()] });
  }

  _onMessage(m) {
    if (!m || typeof m !== 'object' || m.id === this.id || typeof m.id !== 'string') return;
    if (m.type === 'hello') { this._beat(); return; }
    if (m.type === 'bye') {
      if (this.peers.delete(m.id)) this._changed();
      return;
    }
    if (m.type === 'throttle') {
      if (this.governor && typeof this.governor.penalize === 'function') this.governor.penalize(Number(m.cooldownMs) || 0);
      return;
    }
    if (m.type === 'state') {
      const before = this.peers.get(m.id);
      const datasets = new Set(Array.isArray(m.datasets) ? m.datasets.filter((d) => typeof d === 'string') : []);
      const next = { at: this.now(), active: !!m.active, datasets };
      this.peers.set(m.id, next);
      if (!before || before.active !== next.active || !sameSet(before.datasets, datasets)) this._changed();
    }
  }

  _expire() {
    const t = this.now();
    let gone = false;
    for (const [id, p] of this.peers) if (t - p.at > PEER_TTL_MS) { this.peers.delete(id); gone = true; }
    if (gone) this._changed();
  }

  _changed() {
    this._applyShare();
    try { this.o.onChange?.(); } catch (err) { console.error(err); }
  }

  _applyShare() {
    if (this.governor && typeof this.governor.setShare === 'function') this.governor.setShare(Math.max(1, this.activeTabs()));
  }
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function defaultScope() {
  try { return new URL('.', location.href).pathname; } catch (_) { return '/'; }
}
