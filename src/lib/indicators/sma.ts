/**
 * Simple Moving Average: the mean of the last `length` values.
 * sma[i] = (v[i] + v[i-1] + ... + v[i-length+1]) / length
 * Undefined (NaN) until index length-1.
 */
export function sma(values: number[], length: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= length) sum -= values[i - length];
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}
