// ---------------------------------------------------------------
// The webhook sends money as a decimal number, like 19.99.
//
// JavaScript cannot store 19.99 exactly. If I do 19.99 * 100 I can
// get back 1998.9999999999998. If I then chop the decimals off I get
// 1998 -- one cent short. Do that across 250 orders and the
// reconciliation check fails by amounts too small to notice by eye.
//
// Math.round fixes it. I never use parseInt, Math.floor or | 0 here,
// because all three chop instead of rounding.
// ---------------------------------------------------------------

export function toCents(value: unknown): number {
  // The broken test events send the STRING "NaN", not a number,
  // so this first check is what catches them.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('not a valid money amount');
  }
  const cents = Math.round(value * 100);
  if (cents < 0 || !Number.isSafeInteger(cents)) {
    throw new Error('money out of range');
  }
  return cents;
}

/**
 * This is only for showing money on screen.
 * I never do arithmetic on the result of this function.
 */
export function money(cents: number | string, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency })
    .format(Number(cents) / 100);
}