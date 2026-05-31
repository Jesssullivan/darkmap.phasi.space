/**
 * Total-column ozone climatology — van Heuklon (1979).
 *
 * Estimating atmospheric ozone for solar radiation models, Solar Energy 22(1),
 * 63–68. A closed-form climatological estimate of the total ozone column (in
 * Dobson units) from latitude, longitude, and day-of-year — the standard cheap
 * column-O₃ model used by solar-radiation codes (SMARTS, Py6S).
 *
 * Replaces the flat 350 DU default fed to the transmission LUT with a real
 * (climatological, not measured) per-location/season value. Constants follow
 * Robin Wilson's reference implementation (github.com/robintw/vanHOzone).
 *
 * Pure, dependency-free.
 */

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Day of the year (1–366) in UTC. */
export const dayOfYearUTC = (date: Date): number => {
	const start = Date.UTC(date.getUTCFullYear(), 0, 0);
	return Math.floor((date.getTime() - start) / 86_400_000);
};

/**
 * Total-column ozone (Dobson units) at `latDeg`/`lonDeg` for `date`.
 *
 *   Ω = J + [A + C·sin(D·(doy + F)) + G·sin(H·(lon + I))] · sin²(B·lat)
 *
 * with the trig arguments evaluated in degrees. Hemisphere-dependent constants
 * per van Heuklon (1979). At the equator the latitude term vanishes and Ω = J
 * (235 DU baseline); ozone climbs toward the poles, peaking in spring.
 */
export const columnOzoneDu = (latDeg: number, lonDeg: number, date: Date): number => {
	const doy = dayOfYearUTC(date);
	const north = latDeg >= 0;

	const J = 235.0;
	const D = 0.9865;
	const G = 20.0;
	const A = north ? 150.0 : 100.0;
	const B = north ? 1.28 : 1.5;
	const C = north ? 40.0 : 30.0;
	const F = north ? -30.0 : 152.625;
	const H = north ? 3.0 : 2.0;
	const I = north ? (lonDeg > 0 ? 20.0 : 0.0) : -75.0;

	const bracket = A + C * Math.sin(toRad(D * (doy + F))) + G * Math.sin(toRad(H * (lonDeg + I)));
	const latTerm = Math.sin(toRad(B * latDeg)) ** 2;
	return J + bracket * latTerm;
};
