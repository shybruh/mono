/**
 * Subsequence fuzzy score. Higher is better, -1 = no match.
 * Rewards consecutive runs, word starts and early matches.
 */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct + (direct === 0 || /[\s\-_/\\.(]/.test(t[direct - 1]) ? 200 : 0);
  let score = 0;
  let ti = 0;
  let run = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === " ") continue;
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === c) {
        found = ti;
        break;
      }
      ti++;
    }
    if (found < 0) return -1;
    const boundary = found === 0 || /[\s\-_/\\.(]/.test(t[found - 1]);
    run = found > 0 && t[found - 1] === q[qi - 1] ? run + 1 : 0;
    score += 10 + run * 8 + (boundary ? 15 : 0) - Math.min(found, 30) * 0.2;
    ti = found + 1;
  }
  return score;
}

/** All space-separated terms must match somewhere across the fields. */
export function multiScore(query: string, fields: (string | null | undefined)[]): number {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return 0;
  let total = 0;
  for (const term of terms) {
    let best = -1;
    fields.forEach((f, i) => {
      if (!f) return;
      const s = fuzzyScore(term, f);
      if (s >= 0) best = Math.max(best, s - i * 5);
    });
    if (best < 0) return -1;
    total += best;
  }
  return total;
}
