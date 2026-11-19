// Australian Business Number checks.
// https://abr.business.gov.au/Help/AbnFormat

const WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];

export function normaliseAbn(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, '');
  return digits.length ? digits : null;
}

export function isValidAbn(input: string | null | undefined): boolean {
  const digits = normaliseAbn(input);
  if (!digits || digits.length !== 11) return false;
  const nums = [...digits].map(Number);
  nums[0] -= 1;
  const sum = nums.reduce((acc, n, i) => acc + n * WEIGHTS[i], 0);
  return sum % 89 === 0;
}

export function formatAbn(input: string | null | undefined): string | null {
  const d = normaliseAbn(input);
  if (!d || d.length !== 11) return input ?? null;
  return `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
}
