const NAME_TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'prof', 'sri', 'smt', 'shri']);

export function reviewerNamesMatch(reviewerName?: string, recipientName?: string): boolean {
  const a = nameTokens(reviewerName);
  const b = nameTokens(recipientName);
  if (!a.length || !b.length) return false;

  const overlap = a.filter((t) => b.includes(t)).length;
  return overlap >= Math.min(2, a.length, b.length);
}

export function normalizePersonName(name?: string): string {
  return nameTokens(name).join(' ');
}

function nameTokens(name?: string): string[] {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !NAME_TITLES.has(t));
}
