/** Round to cents. Money is kept as numbers rounded to 2 dp at every boundary. */
export const cents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const sum = (xs: number[]) => cents(xs.reduce((a, b) => a + b, 0));

/** True when two amounts differ by more than the tolerance (default 2 cents). */
export const differs = (a: number, b: number, tolerance = 0.02) => Math.abs(cents(a) - cents(b)) > tolerance;
