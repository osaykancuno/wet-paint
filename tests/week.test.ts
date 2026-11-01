// THIS WEEK = Friday 15:00 Lisbon -> next Friday 15:00 Lisbon, across Lisbon's DST changes; week 1 = Thursday 22 Oct
// 2026 00:00 -> Friday 30 Oct 15:00 Lisbon.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lisbonWeek, weekEnds } from '../src/shell/week.js';

const at = (iso: string): number => Date.parse(iso);
const cases: [string, string, string][] = [
  // now (UTC)                    from (UTC)               to (UTC)
  ['2026-10-20T17:00:00Z', '2026-10-21T23:00:00.000Z', '2026-10-30T15:00:00.000Z'],   // before week 1 opens: week 1 (Thu 00:00, UTC+1)
  ['2026-10-23T14:00:00Z', '2026-10-21T23:00:00.000Z', '2026-10-30T15:00:00.000Z'],   // week 1 spans its first Friday 15:00
  ['2026-10-30T14:59:59Z', '2026-10-21T23:00:00.000Z', '2026-10-30T15:00:00.000Z'],   // last second of week 1 (DST ended Sun 25 Oct)
  ['2026-10-30T15:00:00Z', '2026-10-30T15:00:00.000Z', '2026-11-06T15:00:00.000Z'],   // then Friday 15:00 -> Friday 15:00
  ['2026-10-31T12:00:00Z', '2026-10-30T15:00:00.000Z', '2026-11-06T15:00:00.000Z'],   // winter (UTC+0)
  ['2027-03-26T15:00:00Z', '2027-03-26T15:00:00.000Z', '2027-04-02T14:00:00.000Z'],   // DST starts Sun 28 Mar 2027
  ['2027-01-01T00:00:00Z', '2026-12-25T15:00:00.000Z', '2027-01-01T15:00:00.000Z'],   // across the new year
];
for (const [now, from, to] of cases) {
  test(`week of ${now}`, () => {
    assert.deepEqual(lisbonWeek(at(now)), { from, to });
  });
}

test('the label says the real end of the week', () => {
  assert.equal(weekEnds(lisbonWeek(at('2026-10-20T17:00:00Z'))), 'ends Fri Oct 30 · 15:00 Lisbon');
  assert.equal(weekEnds(lisbonWeek(at('2026-11-01T12:00:00Z'))), 'ends Fri Nov 6 · 15:00 Lisbon');
  assert.equal(weekEnds(lisbonWeek(at('2027-03-30T12:00:00Z'))), 'ends Fri Apr 2 · 15:00 Lisbon');
});
