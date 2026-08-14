'use strict';

const M = require('./machine');
const { nfaToDfa } = require('./convert');

/*
 * Do two machines accept the same language?
 *
 * A yes/no answer is nearly useless on its own when the answer is no, so this
 * searches breadth-first and returns the *shortest* string the two disagree
 * on. That string is the thing worth handing back: it is a concrete input the
 * user can trace through their own drawing to see where it goes wrong.
 */

function determinise(machine) {
  const m = M.normalize(machine);
  const index = M.transitionIndex(m);
  const nd = m.states.some(s => {
    const row = index.move.get(s.id) || new Map();
    return [...row.values()].some(v => v.length > 1);
  });
  if (!nd && !m.transitions.some(t => t.epsilon)) return m;
  return nfaToDfa(m).machine;
}

function tableOf(machine) {
  const m = determinise(machine);
  const index = M.transitionIndex(m);
  const start = M.startState(m);
  return {
    machine: m,
    start: start ? start.id : null,
    accepts: id => {
      const s = M.stateById(m, id);
      return !!(s && s.accepting);
    },
    step: (id, sym) => {
      if (id == null) return null;                 // already fallen off
      const targets = (index.move.get(id) || new Map()).get(sym) || [];
      return targets.length ? targets[0] : null;
    }
  };
}

function compare(machineA, machineB, options = {}) {
  const A = tableOf(machineA);
  const B = tableOf(machineB);

  const alphabet = [...new Set(
    M.alphabetOf(A.machine).concat(M.alphabetOf(B.machine))
  )].sort();

  if (A.start == null || B.start == null) {
    return {
      equivalent: false,
      reason: 'One of the machines has no start state.',
      alphabet
    };
  }

  // A missing transition is a real, distinct outcome, so null is a legitimate
  // half of a pair rather than a reason to stop exploring.
  const seen = new Set();
  const queue = [{ a: A.start, b: B.start, word: [] }];
  seen.add(`${A.start}|${B.start}`);
  const limit = options.limit || 20000;
  let visited = 0;

  while (queue.length) {
    const { a, b, word } = queue.shift();
    if (++visited > limit) {
      return {
        equivalent: null,
        reason: `Gave up after exploring ${limit} state pairs.`,
        alphabet
      };
    }

    const accA = a != null && A.accepts(a);
    const accB = b != null && B.accepts(b);
    if (accA !== accB) {
      const witness = word.join('');
      return {
        equivalent: false,
        distinguishingString: witness,
        acceptedByFirst: accA,
        acceptedBySecond: accB,
        reason: witness === ''
          ? `The empty string is accepted by ${accA ? 'the first' : 'the second'} machine only.`
          : `"${witness}" is accepted by ${accA ? 'the first' : 'the second'} machine only.`,
        alphabet
      };
    }

    for (const sym of alphabet) {
      const na = A.step(a, sym);
      const nb = B.step(b, sym);
      const key = `${na}|${nb}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ a: na, b: nb, word: word.concat(sym) });
    }
  }

  return {
    equivalent: true,
    reason: 'Every reachable pair of states agrees on acceptance, so the two machines accept exactly the same language.',
    alphabet,
    pairsChecked: visited
  };
}

/*
 * The strings a machine accepts, shortest first. Useful on its own ("what does
 * my machine actually do?") and as a sanity check next to a description.
 */
function sampleLanguage(machine, options = {}) {
  const m = M.normalize(machine);
  const index = M.transitionIndex(m);
  const start = M.startState(m);
  const alphabet = M.alphabetOf(m);
  const want = options.count || 10;
  const maxLength = options.maxLength != null ? options.maxLength : 12;

  if (!start) return { accepted: [], rejected: [], note: 'No start state.' };

  const accepted = [];
  const rejected = [];
  const startSet = M.epsilonClosure([start.id], index);
  const queue = [{ live: startSet, word: '' }];
  const seen = new Set([[...startSet].sort().join(' ') + '||']);

  while (queue.length && (accepted.length < want || rejected.length < want)) {
    const { live, word } = queue.shift();
    if (word.length > maxLength) continue;

    const isAccepting = [...live].some(id => {
      const s = M.stateById(m, id);
      return s && s.accepting;
    });
    if (isAccepting) { if (accepted.length < want) accepted.push(word); }
    else if (rejected.length < want) rejected.push(word);

    if (word.length >= maxLength) continue;
    for (const sym of alphabet) {
      const next = new Set();
      for (const id of live) {
        for (const to of (index.move.get(id) || new Map()).get(sym) || []) next.add(to);
      }
      const closed = M.epsilonClosure([...next], index);
      if (!closed.size) continue;
      const key = [...closed].sort().join(' ') + '||' + (word.length + 1);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ live: closed, word: word + sym });
    }
  }

  return { accepted, rejected, alphabet };
}

module.exports = { compare, sampleLanguage, determinise };
