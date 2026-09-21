const HOUR_MS = 3_600_000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function localHourKey(d: Date): string {
  return `${localDateKey(d)}T${pad2(d.getHours())}:00`;
}

export function makeTimeBuckets(days: number, now = Date.now()): Array<{ key: string; timestamp: number }> {
  if (days <= 1) {
    const hourStart = new Date(now);
    hourStart.setMinutes(0, 0, 0);
    const hourly: Array<{ key: string; timestamp: number }> = [];
    for (let i = 23; i >= 0; i -= 1) {
      const ts = hourStart.getTime() - i * HOUR_MS;
      hourly.push({ key: localHourKey(new Date(ts)), timestamp: ts });
    }
    return hourly;
  }
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const daily: Array<{ key: string; timestamp: number }> = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(dayStart);
    day.setDate(day.getDate() - i);
    daily.push({ key: localDateKey(day), timestamp: day.getTime() });
  }
  return daily;
}

export function timeBucketKey(ts: number, hourly: boolean): string {
  const d = new Date(ts);
  if (hourly) {
    d.setMinutes(0, 0, 0);
    return localHourKey(d);
  }
  d.setHours(0, 0, 0, 0);
  return localDateKey(d);
}
