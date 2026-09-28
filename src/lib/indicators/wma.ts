/**
 * Weighted Moving Average: linearly weights recent values highest.
 * wma[i] = sum_{j=0..length-1} v[i-j] * (length-j)  /  sum_{k=1..length} k
 */
export function wma(values: number[], length: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const denom = (length * (length + 1)) / 2;
  for (let i = length - 1; i < values.length; i++) {
    let num = 0;
    for (let j = 0; j < length; j++) {
      num += values[i - j] * (length - j);
    }
    out[i] = num / denom;
  }
  return out;
}
