/* ============================================================
   Lumen3D — Compare: shared quality budget
   ============================================================
   The panels of the Compare page are separate documents but share one
   renderer process and one GPU, while each of them believes it owns the whole
   texture budget. The number of panels is a poor proxy for what they hold:
   "1024" ranges from a few hundred MB to over a GB depending on the dataset.
   A volume panel therefore reports what each quality level would cost
   (`qualityBytes`, bytes of atlas), and this planner picks one level per panel
   so that the sum stays inside ONE budget:

     1. start every panel at the level it is on now;
     2. while the total exceeds the budget, lower the panel holding the most;
     3. while some panel can go one level up without exceeding the budget,
        raise the one that is lowest (the cheapest step breaks a tie), never
        above `ceiling`.

   Pure and DOM-free: the page feeds it plain objects, the tests too.
   ============================================================ */

const CompareQuality = (() => {
  const LADDER = ['256x256', '512x512', '1024x1024', '2048x2048', '4096x4096', 'native'];

  const rankOf = (q) => LADDER.indexOf(q);

  /** The quality ids the page accepts, from a URL, a file or a select. */
  function isQuality(q) { return rankOf(q) >= 0; }

  /** The levels a panel can actually be asked for, cheapest first. */
  function levelsOf(bytes) {
    return LADDER.filter(q => Number.isFinite(bytes?.[q]) && bytes[q] > 0);
  }

  /**
   * @param {{key:*, quality:string, bytes:Object<string,number>}[]} panels
   * @param {number} budget      bytes available to all of them together
   * @param {number} [reserve]   bytes already spoken for (panels that have not reported yet)
   * @param {string} [ceiling]   highest level an automatic raise may reach
   * @returns {Map<*, string>}   target quality per panel key
   */
  function plan(panels, budget, reserve = 0, ceiling = 'native') {
    const state = panels.map(p => {
      const levels = levelsOf(p.bytes);
      let at = levels.indexOf(p.quality);
      if (at < 0) {
        // A level without a price (or none reported): the nearest cheaper one, else the cheapest.
        const below = levels.filter(q => rankOf(q) <= rankOf(p.quality));
        at = below.length ? levels.indexOf(below[below.length - 1]) : 0;
      }
      return { key: p.key, levels, bytes: p.bytes, at };
    }).filter(s => s.levels.length);

    const cost = (s, i = s.at) => s.bytes[s.levels[i]];
    let total = reserve + state.reduce((sum, s) => sum + cost(s), 0);
    const cap = rankOf(ceiling) >= 0 ? rankOf(ceiling) : LADDER.length - 1;

    while (total > budget) {
      let pick = null;
      for (const s of state) {
        if (s.at === 0) continue;
        if (!pick || cost(s) > cost(pick)) pick = s;
      }
      if (!pick) break;                       // everything is on its cheapest level already
      total -= cost(pick) - cost(pick, pick.at - 1);
      pick.at--;
    }

    for (;;) {
      let pick = null;
      for (const s of state) {
        if (s.at + 1 >= s.levels.length || rankOf(s.levels[s.at + 1]) > cap) continue;
        const step = cost(s, s.at + 1) - cost(s);
        if (total + step > budget) continue;
        if (!pick || rankOf(s.levels[s.at]) < rankOf(pick.levels[pick.at])
            || (rankOf(s.levels[s.at]) === rankOf(pick.levels[pick.at]) && step < cost(pick, pick.at + 1) - cost(pick))) pick = s;
      }
      if (!pick) break;
      total += cost(pick, pick.at + 1) - cost(pick);
      pick.at++;
    }

    return new Map(state.map(s => [s.key, s.levels[s.at]]));
  }

  return { LADDER, isQuality, plan, rankOf };
})();

/* ============================================================
   Compare: time sync without echo
   ============================================================
   A timelapse page does not report a frame a SYNC_TIME made it load
   (viewer.js, origin 'sync'), but an older page reports one after EVERY load. Relayed on, that report drags the sender to the frame its
   sibling rounded to (100 frames vs 10: 50 -> 5 -> 55) or, with equal lengths, to
   a frame the sender has already left. The host therefore remembers which frame
   it asked each panel to show; a report of exactly that frame is the panel's
   answer to the order, not a new action.
   ============================================================ */

const CompareTimeSync = (() => {
  const WINDOW_MS = 6000;
  const MAX_PENDING = 16;

  /** The frame `target` lands on when sent `data` (the same rule as viewer.js); null while its length is unknown. */
  function frameFor(target, data) {
    const mine = Number(target.timeTotal) || 0;
    const theirs = Number(data.total) || 0;
    if (!mine) return null;
    if (mine > 1 && theirs > 1 && mine !== theirs && Number.isFinite(Number(data.fraction))) {
      return Math.round(Number(data.fraction) * (mine - 1));
    }
    return Number(data.value);
  }

  /** True when `data`, reported by `panel`, answers an order the host gave it; consumes that order. */
  function isEcho(panel, data, now) {
    panel.timeExpect = (panel.timeExpect || []).filter(e => now - e.at < WINDOW_MS);
    // An order whose frame was unknown (the panel's length had not been reported yet)
    // matches nothing: the page does not report a frame a sibling asked for, so its
    // next report is the operator's own action and must reach the siblings.
    const at = panel.timeExpect.findIndex(e => e.frame !== null && e.frame === Number(data.value));
    if (at < 0) return false;
    panel.timeExpect.splice(0, at + 1);   // this report, and any older order, is accounted for
    return true;
  }

  /** Record that `panel` has been ordered to show what `data` says. */
  function expect(panel, data, now) {
    panel.timeExpect = panel.timeExpect || [];
    panel.timeExpect.push({ frame: frameFor(panel, data), at: now });
    if (panel.timeExpect.length > MAX_PENDING) panel.timeExpect.shift();
  }

  /** Record the orders a relay of `data` gives the other panels and return who is to receive it. */
  function relay(panels, source, data, now) {
    const targets = panels.filter(p => p !== source);
    targets.forEach(p => expect(p, data, now));
    return targets;
  }

  return { frameFor, isEcho, expect, relay };
})();
