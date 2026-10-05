/**
 * Axis ticks on round numbers (1, 2, 5, 10, 20, 50...) that bracket the data,
 * so labels never repeat and the top/bottom gridlines sit on real values.
 * `integer` keeps the step at 1 or more, for counts.
 */
export function niceTicks(lo: number, hi: number, integer = false, target = 4): number[] {
  const span = hi - lo || 1;
  const rough = span / target;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  let step = ([1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? rough) || 1;
  if (integer) step = Math.max(1, Math.ceil(step));
  const start = Math.floor(lo / step + 1e-9) * step;
  const end = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks.length >= 2 ? ticks : [start, start + step];
}
