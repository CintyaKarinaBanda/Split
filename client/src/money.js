const MAX_EXPENSE_CENTS = 100_000_000_000;
const formatter = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

export const money = cents => formatter.format(cents / 100);

export function parseExpenseCents(input) {
  const match = /^([0-9]+)(?:[.,]([0-9]{1,2}))?$/.exec(input.trim());
  if (!match) return null;

  const [, pesos, fraction = ''] = match;
  const cents = Number(pesos + fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_EXPENSE_CENTS
    ? cents
    : null;
}
