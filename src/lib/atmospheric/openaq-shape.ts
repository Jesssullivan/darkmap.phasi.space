/**
 * OpenAQ v3 response shaping (TIN-1757). Pure + dependency-free so the proxy
 * stays thin and the join/staleness logic is unit-tested against the real v3
 * shape (the earlier e2e mocked the proxy, which hid that v3 `/locations`
 * carries no values).
 *
 * Reality of OpenAQ v3:
 *  - `/locations?bbox=…` returns `sensors[]` ({id, parameter:{name,units}}) +
 *    `datetimeLast` — but NO measurement values.
 *  - values come from `/v3/locations/{id}/latest` → `[{value, sensorsId, datetime}]`.
 *  - `/v3/parameters/{id}/latest?bbox=` ignores bbox (returns global), so there
 *    is no cheap bbox-wide latest — the proxy fans out per-location /latest over
 *    a capped, freshness-pre-filtered set.
 *
 * Honesty: many stations are years stale (observed 2016/2022 `datetimeLast`), so
 * both the location pre-filter and the per-reading join drop anything older than
 * the freshness window — a dead station is never painted as current.
 */

export const POLLUTANT_NAMES = ['pm25', 'pm10', 'no2', 'o3', 'so2', 'co'] as const;
export type PollutantName = (typeof POLLUTANT_NAMES)[number];
const POLLUTANT_SET = new Set<string>(POLLUTANT_NAMES);

export interface V3Sensor {
	readonly id?: number;
	readonly parameter?: { readonly name?: string; readonly units?: string };
}
export interface V3DateTime {
	readonly utc?: string;
}
export interface V3Location {
	readonly id?: number;
	readonly name?: string;
	readonly coordinates?: { readonly latitude?: number; readonly longitude?: number };
	readonly datetimeLast?: V3DateTime | null;
	readonly sensors?: ReadonlyArray<V3Sensor>;
}
export interface V3Latest {
	readonly value?: number;
	readonly sensorsId?: number;
	readonly datetime?: V3DateTime | null;
}

export interface PollutantReading {
	readonly value: number;
	readonly units?: string;
}
export interface StationFeature {
	readonly type: 'Feature';
	readonly properties: {
		readonly locationId?: number;
		readonly locationName: string;
		readonly value: number | null;
		readonly pollutants: Partial<Record<PollutantName, PollutantReading>>;
	};
	readonly geometry: { readonly type: 'Point'; readonly coordinates: [number, number] };
}

/** Age (ms) of an ISO timestamp relative to `nowMs`, or null when unparseable. */
const ageMs = (iso: string | undefined, nowMs: number): number | null => {
	if (!iso) return null;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? nowMs - t : null;
};

const isFresh = (iso: string | undefined, nowMs: number, staleAfterMs: number): boolean => {
	const a = ageMs(iso, nowMs);
	return a !== null && a >= 0 && a <= staleAfterMs;
};

/**
 * Locations worth fetching `/latest` for: a parseable id, valid coordinates, at
 * least one criteria-pollutant sensor, and a `datetimeLast` within the freshness
 * window. Sorted most-recent-first and capped to `max` to bound the /latest
 * fan-out (there is no bbox-wide latest endpoint).
 */
export const selectFreshLocations = (
	locations: ReadonlyArray<V3Location>,
	nowMs: number,
	staleAfterMs: number,
	max: number,
): V3Location[] => {
	const fresh = locations.filter((l) => {
		if (typeof l.id !== 'number') return false;
		const lat = l.coordinates?.latitude;
		const lon = l.coordinates?.longitude;
		if (typeof lat !== 'number' || typeof lon !== 'number') return false;
		const hasCriteria = (l.sensors ?? []).some((s) => s.parameter?.name && POLLUTANT_SET.has(s.parameter.name));
		if (!hasCriteria) return false;
		return isFresh(l.datetimeLast?.utc, nowMs, staleAfterMs);
	});
	// Parse each timestamp once (decorate-sort-undecorate) instead of twice per
	// comparison, then take the most-recent `max`.
	return fresh
		.map((loc) => ({ loc, ts: Date.parse(loc.datetimeLast?.utc ?? '') }))
		.sort((a, b) => b.ts - a.ts)
		.slice(0, Math.max(0, max))
		.map((d) => d.loc);
};

/**
 * Join a location's `sensors[]` with its `/latest` readings into a GeoJSON
 * feature. Only criteria pollutants with a FRESH reading are kept; `value`
 * mirrors PM2.5 for the existing heatmap paint. Returns null when no fresh
 * criteria pollutant resolves (so the station is dropped, not painted blank).
 */
export const buildStationFeature = (
	loc: V3Location,
	latest: ReadonlyArray<V3Latest>,
	nowMs: number,
	staleAfterMs: number,
): StationFeature | null => {
	const lat = loc.coordinates?.latitude;
	const lon = loc.coordinates?.longitude;
	if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
		return null;
	}
	// sensorId → criteria pollutant {name, units}
	const sensorMap = new Map<number, { name: PollutantName; units?: string }>();
	for (const s of loc.sensors ?? []) {
		const name = s.parameter?.name;
		if (typeof s.id === 'number' && name && POLLUTANT_SET.has(name)) {
			sensorMap.set(s.id, { name: name as PollutantName, units: s.parameter?.units });
		}
	}
	const pollutants: Partial<Record<PollutantName, PollutantReading>> = {};
	for (const r of latest) {
		if (typeof r.sensorsId !== 'number' || typeof r.value !== 'number' || !Number.isFinite(r.value)) continue;
		const meta = sensorMap.get(r.sensorsId);
		if (!meta) continue;
		if (!isFresh(r.datetime?.utc, nowMs, staleAfterMs)) continue; // stale reading → skip
		pollutants[meta.name] = meta.units ? { value: r.value, units: meta.units } : { value: r.value };
	}
	if (Object.keys(pollutants).length === 0) return null;
	return {
		type: 'Feature',
		properties: {
			locationId: typeof loc.id === 'number' ? loc.id : undefined,
			locationName: typeof loc.name === 'string' ? loc.name : 'Unknown',
			value: pollutants.pm25?.value ?? null,
			pollutants,
		},
		geometry: { type: 'Point', coordinates: [lon, lat] },
	};
};
