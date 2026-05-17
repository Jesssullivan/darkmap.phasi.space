import { Context, Data, Effect, Layer } from 'effect';
import {
	Body,
	Equator,
	Horizon,
	Illumination,
	MoonPhase,
	Observer,
	SearchAltitude,
	SearchHourAngle,
	SearchRiseSet,
} from 'astronomy-engine';

export interface LatLon {
	readonly lat: number;
	readonly lon: number;
	readonly elevationMeters?: number;
}

export interface BodyPosition {
	readonly altitudeDeg: number;
	readonly azimuthDeg: number;
}

export type MoonPhaseName =
	| 'new'
	| 'waxing-crescent'
	| 'first-quarter'
	| 'waxing-gibbous'
	| 'full'
	| 'waning-gibbous'
	| 'last-quarter'
	| 'waning-crescent';

export interface EphemerisEvents {
	readonly astronomicalDawn: Date | null;
	readonly nauticalDawn: Date | null;
	readonly civilDawn: Date | null;
	readonly sunrise: Date | null;
	readonly solarNoon: Date | null;
	readonly sunset: Date | null;
	readonly civilDusk: Date | null;
	readonly nauticalDusk: Date | null;
	readonly astronomicalDusk: Date | null;
	readonly moonrise: Date | null;
	readonly moonset: Date | null;
}

export interface EphemerisReadout {
	readonly location: LatLon;
	readonly at: Date;
	readonly sun: BodyPosition;
	readonly moon: BodyPosition & {
		readonly phaseDeg: number;
		readonly illumination: number;
		readonly phaseName: MoonPhaseName;
	};
	readonly events: EphemerisEvents;
}

export class EphemerisError extends Data.TaggedError('EphemerisError')<{
	readonly reason: string;
	readonly cause?: unknown;
}> {}

export interface SkyPositions {
	readonly sun: BodyPosition;
	readonly moon: BodyPosition;
}

export class EphemerisClient extends Context.Tag('@darkmap/EphemerisClient')<
	EphemerisClient,
	{
		readonly at: (loc: LatLon, t: Date) => Effect.Effect<EphemerisReadout, EphemerisError>;
		/**
		 * Lightweight position-only query — used by the sky-compass trajectory
		 * sampler (~50 calls per render). Skips event-time searches.
		 */
		readonly positionAt: (loc: LatLon, t: Date) => Effect.Effect<SkyPositions, EphemerisError>;
	}
>() {}

const DAWN = +1 as const;
const DUSK = -1 as const;

const phaseName = (deg: number): MoonPhaseName => {
	const d = ((deg % 360) + 360) % 360;
	if (d < 22.5) return 'new';
	if (d < 67.5) return 'waxing-crescent';
	if (d < 112.5) return 'first-quarter';
	if (d < 157.5) return 'waxing-gibbous';
	if (d < 202.5) return 'full';
	if (d < 247.5) return 'waning-gibbous';
	if (d < 292.5) return 'last-quarter';
	if (d < 337.5) return 'waning-crescent';
	return 'new';
};

const searchAltitudeAt = (
	body: Body,
	observer: Observer,
	direction: typeof DAWN | typeof DUSK,
	from: Date,
	altitudeDeg: number,
): Date | null => {
	const t = SearchAltitude(body, observer, direction, from, 1, altitudeDeg);
	return t ? t.date : null;
};

const computePositions = (loc: LatLon, t: Date): SkyPositions => {
	const observer = new Observer(loc.lat, loc.lon, loc.elevationMeters ?? 0);
	const sunEq = Equator(Body.Sun, t, observer, true, true);
	const sunHor = Horizon(t, observer, sunEq.ra, sunEq.dec, 'normal');
	const moonEq = Equator(Body.Moon, t, observer, true, true);
	const moonHor = Horizon(t, observer, moonEq.ra, moonEq.dec, 'normal');
	return {
		sun: { altitudeDeg: sunHor.altitude, azimuthDeg: sunHor.azimuth },
		moon: { altitudeDeg: moonHor.altitude, azimuthDeg: moonHor.azimuth },
	};
};

export const EphemerisClientLive = Layer.succeed(
	EphemerisClient,
	EphemerisClient.of({
		positionAt: (loc, t) =>
			Effect.try({
				try: () => computePositions(loc, t),
				catch: (cause) => new EphemerisError({ reason: 'astronomy-engine threw during position query', cause }),
			}),
		at: (loc, t) =>
			Effect.try({
				try: () => {
					const observer = new Observer(loc.lat, loc.lon, loc.elevationMeters ?? 0);
					const dayStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 0, 0, 0, 0));

					const positions = computePositions(loc, t);
					const phaseDeg = MoonPhase(t);
					const illum = Illumination(Body.Moon, t);

					const sunriseT = SearchRiseSet(Body.Sun, observer, +1, dayStart, 1);
					const sunsetT = SearchRiseSet(Body.Sun, observer, -1, dayStart, 1);
					const moonriseT = SearchRiseSet(Body.Moon, observer, +1, dayStart, 1);
					const moonsetT = SearchRiseSet(Body.Moon, observer, -1, dayStart, 1);

					const noonEvent = SearchHourAngle(Body.Sun, observer, 0, dayStart, +1);

					return {
						location: loc,
						at: t,
						sun: positions.sun,
						moon: {
							...positions.moon,
							phaseDeg,
							illumination: illum.phase_fraction,
							phaseName: phaseName(phaseDeg),
						},
						events: {
							astronomicalDawn: searchAltitudeAt(Body.Sun, observer, DAWN, dayStart, -18),
							nauticalDawn: searchAltitudeAt(Body.Sun, observer, DAWN, dayStart, -12),
							civilDawn: searchAltitudeAt(Body.Sun, observer, DAWN, dayStart, -6),
							sunrise: sunriseT ? sunriseT.date : null,
							solarNoon: noonEvent ? noonEvent.time.date : null,
							sunset: sunsetT ? sunsetT.date : null,
							civilDusk: searchAltitudeAt(Body.Sun, observer, DUSK, dayStart, -6),
							nauticalDusk: searchAltitudeAt(Body.Sun, observer, DUSK, dayStart, -12),
							astronomicalDusk: searchAltitudeAt(Body.Sun, observer, DUSK, dayStart, -18),
							moonrise: moonriseT ? moonriseT.date : null,
							moonset: moonsetT ? moonsetT.date : null,
						},
					};
				},
				catch: (cause) => new EphemerisError({ reason: 'astronomy-engine threw during computation', cause }),
			}),
	}),
);

export const makeEphemerisClientStub = (impl: {
	at: (loc: LatLon, t: Date) => Effect.Effect<EphemerisReadout, EphemerisError>;
	positionAt: (loc: LatLon, t: Date) => Effect.Effect<SkyPositions, EphemerisError>;
}): Layer.Layer<EphemerisClient> => Layer.succeed(EphemerisClient, impl);
