/**
 * Canonical criteria-pollutant list (V6 quality pass). The set of EPA criteria
 * pollutants this app surfaces, as a runtime array, in the same order as the
 * `AqiPollutant` type. Several modules re-derived this list inline; this is the
 * single source for "all criteria pollutants" iteration.
 *
 * NB: the OpenAQ wire-shape modules (openaq-shape, openaq-history-shape) and the
 * Effect service layer keep their own `POLLUTANT_NAMES`/`HISTORY_POLLUTANT_NAMES`
 * — those carry their own derived string-literal types tied to the v3 contract,
 * so unifying them would churn types across packages for little gain.
 */

import type { AqiPollutant } from './aqi';

export const CRITERIA_POLLUTANTS: readonly AqiPollutant[] = ['pm25', 'pm10', 'o3', 'no2', 'so2', 'co'];
