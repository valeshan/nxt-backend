/**
 * Utility functions for merging time series and aggregated data
 */

export interface TimeSeriesPoint {
  monthLabel: string;
  total: number;
}

/**
 * Merges two time series arrays by summing values for matching month labels.
 * If a month exists in only one series, it's included in the result.
 * 
 * @param seriesA First time series array
 * @param seriesB Second time series array
 * @returns Merged time series with summed totals per month
 */
export function mergeTimeSeries(
  seriesA: TimeSeriesPoint[],
  seriesB: TimeSeriesPoint[]
): TimeSeriesPoint[] {
  // Create a map to aggregate by monthLabel
  const mergedMap = new Map<string, number>();

  // Add all points from seriesA
  for (const point of seriesA) {
    const existing = mergedMap.get(point.monthLabel) || 0;
    mergedMap.set(point.monthLabel, existing + point.total);
  }

  // Add all points from seriesB
  for (const point of seriesB) {
    const existing = mergedMap.get(point.monthLabel) || 0;
    mergedMap.set(point.monthLabel, existing + point.total);
  }

  // Convert back to array and sort by monthLabel (chronological order)
  const result: TimeSeriesPoint[] = Array.from(mergedMap.entries())
    .map(([monthLabel, total]) => ({ monthLabel, total }))
    .sort((a, b) => {
      // Parse month labels (e.g., "Jan 2024") for proper chronological sorting
      // If parsing fails, fall back to string comparison
      try {
        const dateA = new Date(a.monthLabel);
        const dateB = new Date(b.monthLabel);
        if (!isNaN(dateA.getTime()) && !isNaN(dateB.getTime())) {
          return dateA.getTime() - dateB.getTime();
        }
      } catch {
        // Fall through to string comparison
      }
      return a.monthLabel.localeCompare(b.monthLabel);
    });

  return result;
}







