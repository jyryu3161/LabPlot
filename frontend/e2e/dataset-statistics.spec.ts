import { expect, test } from '@playwright/test';
import { automaticStatisticsDesign, formatPValue } from '../src/lib/statistics';

test.describe('automatic dataset statistics presentation', () => {
  test('tiny p-values are shown as a threshold instead of zero', () => {
    expect(formatPValue(0)).toBe('p < 0.0001');
    expect(formatPValue(0.000099)).toBe('p < 0.0001');
    expect(formatPValue(0.0001)).toBe('p = 0.0001');
    expect(formatPValue(0.0312)).toBe('p = 0.0312');
    expect(formatPValue(undefined)).toBe('p = –');
  });

  test('group plus time is flagged and ID or replicate marks repeated units', () => {
    expect(automaticStatisticsDesign([
      { name: 'Genotype', role: 'group' },
      { name: 'Time_h', role: 'time' },
      { name: 'Replicate', role: 'replicate' },
      { name: 'Expression', role: 'numeric' },
    ])).toEqual({ hasGroupAndTime: true, hasRepeatedUnit: true });

    // Name fallbacks keep older stored profiles safe before their roles are re-saved.
    expect(automaticStatisticsDesign([
      { name: 'Genotype', role: 'group' },
      { name: 'Time_h', role: 'numeric' },
      { name: 'Subject_ID', role: 'numeric' },
    ])).toEqual({ hasGroupAndTime: true, hasRepeatedUnit: true });

    expect(automaticStatisticsDesign([
      { name: 'Treatment', role: 'group' },
      { name: 'Study_Days', role: 'numeric' },
      { name: 'recovery_time', role: 'numeric' },
    ])).toEqual({ hasGroupAndTime: true, hasRepeatedUnit: false });

    expect(automaticStatisticsDesign([
      { name: 'Genotype', role: 'group' },
      { name: 'Time_h', role: 'numeric', role_source: 'user' },
      { name: 'Subject_ID', role: 'numeric', role_source: 'user' },
    ])).toEqual({ hasGroupAndTime: false, hasRepeatedUnit: false });
  });
});
