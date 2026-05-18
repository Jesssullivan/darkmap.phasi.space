/**
 * Coordinate string parser for the geocoder search box (TIN-1302 sub 2).
 *
 * Recognized formats:
 *   • Decimal     `42.4434, -76.5019`  or  `42.4434 -76.5019`
 *   • DMS         `42°26'36"N 76°30'07"W`  (degrees / minutes / seconds)
 *   • DMM         `42°26.6'N 76°30.115'W`  (degrees / decimal minutes)
 *
 * UTM and MGRS deferred. Both are valuable for field-survey users
 * but pull in significant parsing code; punted to a follow-up.
 *
 * Output is always lat/lon in WGS-84 decimal degrees. The parser is
 * lat-first: `42, -76` → (42, -76), `-76, 42` → (-76, 42) (caller's
 * problem if they swap). The DMS/DMM forms are unambiguous because
 * they carry N/S/E/W hemisphere markers.
 */

export interface ParsedCoord {
	readonly lat: number;
	readonly lon: number;
	readonly format: 'decimal' | 'dms' | 'dmm';
}

const isValidLat = (n: number): boolean => Number.isFinite(n) && n >= -90 && n <= 90;
const isValidLon = (n: number): boolean => Number.isFinite(n) && n >= -180 && n <= 180;

const DECIMAL_RE = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/;

const DMS_RE =
	/^\s*(\d+)\s*[°\s]\s*(\d+)\s*[′'\s]\s*(\d+(?:\.\d+)?)\s*[″"]?\s*([NSns])\s*[,\s]\s*(\d+)\s*[°\s]\s*(\d+)\s*[′'\s]\s*(\d+(?:\.\d+)?)\s*[″"]?\s*([EWew])\s*$/;

const DMM_RE =
	/^\s*(\d+)\s*[°\s]\s*(\d+(?:\.\d+)?)\s*[′']?\s*([NSns])\s*[,\s]\s*(\d+)\s*[°\s]\s*(\d+(?:\.\d+)?)\s*[′']?\s*([EWew])\s*$/;

const dmsToDecimal = (d: number, m: number, s: number, hemi: string): number => {
	const sign = hemi.toUpperCase() === 'S' || hemi.toUpperCase() === 'W' ? -1 : 1;
	return sign * (d + m / 60 + s / 3600);
};

const dmmToDecimal = (d: number, m: number, hemi: string): number => {
	const sign = hemi.toUpperCase() === 'S' || hemi.toUpperCase() === 'W' ? -1 : 1;
	return sign * (d + m / 60);
};

export const parseCoordinates = (input: string): ParsedCoord | null => {
	if (!input) return null;
	const trimmed = input.trim();

	// Try DMS first — most specific. (Decimal would also match a DMS
	// substring if we tried it first.)
	const dms = DMS_RE.exec(trimmed);
	if (dms) {
		const lat = dmsToDecimal(Number(dms[1]), Number(dms[2]), Number(dms[3]), dms[4]);
		const lon = dmsToDecimal(Number(dms[5]), Number(dms[6]), Number(dms[7]), dms[8]);
		if (isValidLat(lat) && isValidLon(lon)) return { lat, lon, format: 'dms' };
	}

	const dmm = DMM_RE.exec(trimmed);
	if (dmm) {
		const lat = dmmToDecimal(Number(dmm[1]), Number(dmm[2]), dmm[3]);
		const lon = dmmToDecimal(Number(dmm[4]), Number(dmm[5]), dmm[6]);
		if (isValidLat(lat) && isValidLon(lon)) return { lat, lon, format: 'dmm' };
	}

	const dec = DECIMAL_RE.exec(trimmed);
	if (dec) {
		const lat = Number(dec[1]);
		const lon = Number(dec[2]);
		if (isValidLat(lat) && isValidLon(lon)) return { lat, lon, format: 'decimal' };
	}

	return null;
};

/**
 * Client-side dispatch for the geocoder search box.
 *
 * Returns:
 *   • { kind: 'coord', coord } — input parsed as a coordinate; jump
 *     to that point without hitting /api/geocode.
 *   • { kind: 'query', q }     — input is free text; UI should hit
 *     the proxy and render candidate places.
 *   • { kind: 'empty' }        — whitespace-only.
 */
export type DispatchResult =
	| { readonly kind: 'coord'; readonly coord: ParsedCoord }
	| { readonly kind: 'query'; readonly q: string }
	| { readonly kind: 'empty' };

export const dispatchSearchInput = (input: string): DispatchResult => {
	const trimmed = input.trim();
	if (!trimmed) return { kind: 'empty' };
	const coord = parseCoordinates(trimmed);
	if (coord) return { kind: 'coord', coord };
	return { kind: 'query', q: trimmed };
};
