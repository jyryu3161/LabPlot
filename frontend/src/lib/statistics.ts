type StatisticsColumn = {
  name: string;
  role: string;
  role_source?: string | null;
};

const GROUP_ROLES = new Set(['group', 'category', 'status']);
const TIME_NAME_RE = /^(?:time(?:point)?(?:[_\s-]*(?:h|hr|hour|hours|d|day|days))?|(?:study|visit|experiment)[_\s-]*(?:h|hr|hour|hours|d|day|days))$/i;
const REPEATED_UNIT_NAME_RE = /(^|[_\s-])(replicate|rep|repeat|sample[_\s-]*id|subject[_\s-]*id|patient[_\s-]*id|id)($|[_\s-])/i;

export type AutomaticStatisticsDesign = {
  hasGroupAndTime: boolean;
  hasRepeatedUnit: boolean;
};

/** Detect designs that the one-factor automatic summaries must not overstate. */
export function automaticStatisticsDesign(columns: StatisticsColumn[]): AutomaticStatisticsDesign {
  const hasGroup = columns.some((column) => GROUP_ROLES.has(column.role.toLowerCase()));
  const hasTime = columns.some((column) => (
    column.role.toLowerCase() === 'time'
      || (column.role_source !== 'user' && TIME_NAME_RE.test(column.name))
  ));
  const hasRepeatedUnit = columns.some((column) => (
    ['id', 'replicate'].includes(column.role.toLowerCase())
      || (column.role_source !== 'user' && REPEATED_UNIT_NAME_RE.test(column.name))
  ));
  return { hasGroupAndTime: hasGroup && hasTime, hasRepeatedUnit };
}

/** Format a complete p-value label without ever presenting tiny values as zero. */
export function formatPValue(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'p = –';
  if (value < 0.0001) return 'p < 0.0001';
  return `p = ${value}`;
}
