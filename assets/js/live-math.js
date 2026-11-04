/* Election-night arithmetic shared by the home page and Election Trends.
 * Pure functions: give them rows from live_chamber / live_races and the
 * current holders from data.json; they never fetch anything.
 *
 *   House:     total = won + leading. Need 218 (majority) and 290 (two-thirds).
 *   Senate:    total = not_up + won + leading. D needs 51, R needs 50 (the Vice
 *              President breaks ties for Republicans). Also 60 (filibuster) and 67.
 *   Governors: total held = not_up + won + leading.
 *   Flips:     a called race whose winner differs from the party holding it now.
 */
(function (root) {
  'use strict';

  var PARTIES = ['D', 'R', 'I'];

  function num(v) { v = Number(v); return isFinite(v) && v > 0 ? v : 0; }
  function need(threshold, total) { return Math.max(0, threshold - total); }

  // rows: [{chamber, party, won, leading, not_up}] → {D:{won,leading,not_up,total}, R:…, I:…}
  function tally(rows, chamber, withNotUp) {
    var out = {};
    PARTIES.forEach(function (p) { out[p] = { won: 0, leading: 0, not_up: 0, total: 0 }; });
    (rows || []).forEach(function (r) {
      if (r.chamber !== chamber || !out[r.party]) return;
      var t = out[r.party];
      t.won += num(r.won); t.leading += num(r.leading); t.not_up += num(r.not_up);
    });
    PARTIES.forEach(function (p) {
      var t = out[p];
      t.total = (withNotUp ? t.not_up : 0) + t.won + t.leading;
    });
    return out;
  }

  function house(rows) {
    var t = tally(rows, 'house', false);
    ['D', 'R'].forEach(function (p) {
      t[p].need = { majority: need(218, t[p].total), two_thirds: need(290, t[p].total) };
    });
    t.seats = 435; t.majority = 218;
    t.called = t.D.won + t.R.won + t.I.won;
    t.uncalled = Math.max(0, 435 - t.called);
    return t;
  }

  function senate(rows) {
    var t = tally(rows, 'senate', true);
    t.D.need = { majority: need(51, t.D.total), filibuster: need(60, t.D.total), two_thirds: need(67, t.D.total) };
    t.R.need = { majority: need(50, t.R.total), filibuster: need(60, t.R.total), two_thirds: need(67, t.R.total) };
    t.seats = 100; t.majority = { D: 51, R: 50 };
    return t;
  }

  function gov(rows) {
    var t = tally(rows, 'gov', true);
    t.seats = 50; t.majority = 26;
    ['D', 'R'].forEach(function (p) { t[p].need = { majority: need(26, t[p].total) }; });
    return t;
  }

  // races: live_races rows. holders: {race_id: 'D'|'R'|'I'} from data.json.
  // A called race needs a winner; when the desk left winner blank we take the
  // leader, and failing that the higher share.
  function winnerOf(r) {
    if (!r || !r.called_by) return null;
    if (r.winner) return r.winner;
    if (r.leader) return r.leader;
    var d = Number(r.pct_d), rr = Number(r.pct_r);
    if (isFinite(d) && isFinite(rr) && d !== rr) return d > rr ? 'D' : 'R';
    return null;
  }

  function flips(races, holders) {
    var list = [];
    (races || []).forEach(function (r) {
      var w = winnerOf(r), was = holders && holders[r.race_id];
      if (!w || !was) return;
      // Independents who caucus with Democrats are held as D for flip purposes.
      var norm = function (p) { return p === 'I' ? 'D' : p; };
      if (norm(w) !== norm(was)) list.push({ race_id: r.race_id, from: was, to: w, called_by: r.called_by });
    });
    var net = { D: 0, R: 0 };
    list.forEach(function (f) { var to = f.to === 'I' ? 'D' : f.to; net[to] += 1; net[to === 'D' ? 'R' : 'D'] -= 1; });
    return { list: list, gained: { D: list.filter(function (f) { return f.to !== 'R'; }).length, R: list.filter(function (f) { return f.to === 'R'; }).length }, net: net };
  }

  // Leader from shares, for rows the desk has not marked.
  function leaderOf(r) {
    if (r.leader) return r.leader;
    var d = Number(r.pct_d), rr = Number(r.pct_r);
    if (!isFinite(d) || !isFinite(rr) || (d === 0 && rr === 0) || d === rr) return null;
    return d > rr ? 'D' : 'R';
  }

  // 'pre' until the first polls close (or the desk starts counting early), then
  // 'counting' automatically; 'final' only when the desk says so.
  var FIRST_CLOSE = '2026-11-03T23:00:00Z';
  function phase(meta, now) {
    var st = meta && meta.status, close = new Date((meta && meta.polls_first_close) || FIRST_CLOSE).getTime();
    now = now == null ? Date.now() : now;
    if (st === 'final') return 'final';
    if (st === 'counting') return 'counting';
    return now < close ? 'pre' : 'counting';
  }

  // Races called so far, per chamber (won by any party), out of 435 + 35 + 36.
  var RACES_UP = { house: 435, senate: 35, gov: 36 };
  function called(rows) {
    var out = { house: 0, senate: 0, gov: 0 };
    (rows || []).forEach(function (r) { if (out[r.chamber] != null) out[r.chamber] += num(r.won); });
    Object.keys(out).forEach(function (k) { out[k] = Math.min(out[k], RACES_UP[k]); });
    out.total = out.house + out.senate + out.gov;
    out.up = RACES_UP.house + RACES_UP.senate + RACES_UP.gov;
    out.counting = out.up - out.total;
    return out;
  }

  function chamberOf(id) { return /^Senate-/.test(id) ? 'senate' : /^Gov-/.test(id) ? 'gov' : 'house'; }

  // Gains and losses for one chamber. holders: {race_id: party before the election}
  // (live-baseline.json: notional_party in redrawn states, else the 119th holder).
  //   gained  called races a party won from another party
  //   lost    called races a party held and another party won
  //   net     gained - lost
  //   leadGain / leadLoss  uncalled races where the leader differs from the holder
  // Per-race calls win; with none in this chamber, the desk's quick-entry
  // gained/lost on live_chamber is used instead (basis 'desk').
  function gains(chamber, races, holders, chamberRows) {
    var z = function () { return { gained: 0, lost: 0, net: 0, leadGain: 0, leadLoss: 0 }; };
    var out = { D: z(), R: z(), I: z(), basis: null, calledRaces: 0 };
    (races || []).forEach(function (r) {
      if (chamberOf(r.race_id) !== chamber) return;
      var was = holders && holders[r.race_id];
      if (!was || !out[was]) return;
      var w = winnerOf(r);
      if (w) {
        out.calledRaces++;
        if (w !== was && out[w]) { out[w].gained++; out[was].lost++; }
        return;
      }
      var l = leaderOf(r);
      if (l && l !== was && out[l]) { out[l].leadGain++; out[was].leadLoss++; }
    });
    if (out.calledRaces) out.basis = 'races';
    else {
      (chamberRows || []).forEach(function (c) {
        if (c.chamber !== chamber || !out[c.party]) return;
        if (c.gained == null && c.lost == null) return;
        out.basis = 'desk';
        out[c.party].gained = num(c.gained); out[c.party].lost = num(c.lost);
      });
    }
    ['D', 'R', 'I'].forEach(function (p) { out[p].net = out[p].gained - out[p].lost; });
    return out;
  }

  // Votes cast so far: per state the largest count among its races (a statewide race, or the House
  // districts added up), so each ballot counts once; plus the House vote by party (all candidates).
  function turnout(st) {
    var by = {}, party = { D: 0, R: 0, other: 0 };
    ((st && st.races) || []).forEach(function (r) {
      var s = String(r.race_id).replace(/^(Senate|Gov)-/, '').slice(0, 2), x = by[s] || (by[s] = { house: 0, houseIn: 0, houseN: 0, wide: 0, wideIn: 0 });
      var v = num(r.total_votes), p = Number(r.pct_counted) || 0;
      if (chamberOf(r.race_id) === 'house') {
        x.house += v; x.houseIn += p; x.houseN++;
        (r.candidates || []).forEach(function (c) { var k = c.party === 'D' || c.party === 'R' ? c.party : 'other'; party[k] += num(c.votes); });
      } else if (v > x.wide) { x.wide = v; x.wideIn = p; }
    });
    var total = 0;
    Object.keys(by).forEach(function (s) {
      var x = by[s]; x.votes = Math.max(x.house, x.wide); x.counted = x.wide >= x.house ? x.wideIn : (x.houseN ? x.houseIn / x.houseN : 0); total += x.votes;
    });
    return { total: total, states: by, house: party };
  }

  root.LiveMath = { turnout: turnout, house: house, senate: senate, gov: gov, flips: flips, winnerOf: winnerOf, leaderOf: leaderOf, need: need,
                    phase: phase, called: called, gains: gains, chamberOf: chamberOf, RACES_UP: RACES_UP, FIRST_CLOSE: FIRST_CLOSE };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.LiveMath;
})(typeof window !== 'undefined' ? window : this);
