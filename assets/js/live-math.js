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

  root.LiveMath = { house: house, senate: senate, gov: gov, flips: flips, winnerOf: winnerOf, leaderOf: leaderOf, need: need };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.LiveMath;
})(typeof window !== 'undefined' ? window : this);
