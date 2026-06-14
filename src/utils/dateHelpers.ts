import { format, addDays, isBefore, parseISO } from 'date-date-fns'; // Using standard date libraries

/**
 * Generates an array of YYYY-MM-DD strings between two dates (inclusive)
 */
export function getDaysArray(startStr: string, endStr: string): string[] {
  const dates: string[] = [];
  let current = parseISO(startStr);
  const end = parseISO(endStr);

  while (!isBefore(end, current)) {
    dates.push(format(current, 'yyyy-MM-dd'));
    current = addDays(current, 1);
  }
  return dates;
}
