import { describe, expect, it, vi } from 'vitest';
import {
	POINT_MARKER_CLASS,
	POINT_MARKER_STALE_CLASS,
	PointMarkerController,
	pointMarkerSvg,
	type MarkerLike,
} from './point-marker';

const fakeElement = () => {
	const toggled: Array<{ token: string; force?: boolean }> = [];
	const el = {
		className: '',
		innerHTML: '',
		setAttribute: () => {},
		classList: { toggle: (token: string, force?: boolean) => toggled.push({ token, force }) },
	} as unknown as HTMLElement;
	return { el, toggled };
};

/** Records marker lifecycle so we can assert place/move/remove without MapLibre. */
const fakeMaplibre = () => {
	const calls: string[] = [];
	let lastLngLat: [number, number] | undefined;
	let instances = 0;
	const Marker = vi.fn(function (this: Record<string, unknown>, _opts: { element: HTMLElement }) {
		instances++;
		this.setLngLat = (c: [number, number]) => {
			lastLngLat = c;
			calls.push('setLngLat');
			return this;
		};
		this.addTo = () => {
			calls.push('addTo');
			return this;
		};
		this.remove = () => {
			calls.push('remove');
		};
	}) as unknown as { new (opts: { element: HTMLElement }): MarkerLike };
	return {
		maplibre: { Marker },
		calls,
		get instances() {
			return instances;
		},
		get lastLngLat() {
			return lastLngLat;
		},
	};
};

describe('pointMarkerSvg', () => {
	it('renders a crosshair using currentColor (CSS owns the tint)', () => {
		const svg = pointMarkerSvg();
		expect(svg).toContain('<svg');
		expect(svg).toContain('stroke="currentColor"');
		expect(svg).toContain('<circle');
		// Four crosshair arms.
		expect(svg.match(/<line /g)).toHaveLength(4);
	});
});

describe('PointMarkerController', () => {
	const setup = () => {
		const { el, toggled } = fakeElement();
		const mlb = fakeMaplibre();
		const ctrl = new PointMarkerController({ maplibre: mlb.maplibre, map: {}, createElement: () => el });
		return { ctrl, mlb, el, toggled };
	};

	it('creates one marker on first place and adds it to the map', () => {
		const { ctrl, mlb } = setup();
		expect(ctrl.isPlaced).toBe(false);
		ctrl.place(-74, 40.7);
		expect(ctrl.isPlaced).toBe(true);
		expect(mlb.instances).toBe(1);
		expect(mlb.calls).toContain('addTo');
		expect(mlb.lastLngLat).toEqual([-74, 40.7]);
	});

	it('moves the existing marker on subsequent place (never stacks a second)', () => {
		const { ctrl, mlb } = setup();
		ctrl.place(-74, 40.7);
		ctrl.place(-73.9, 40.8);
		expect(mlb.instances).toBe(1); // still one marker
		expect(mlb.lastLngLat).toEqual([-73.9, 40.8]);
	});

	it('place clears the stale dim; setStale(true) re-applies it', () => {
		const { ctrl, toggled } = setup();
		ctrl.place(-74, 40.7); // place → setStale(false)
		ctrl.setStale(true);
		expect(toggled.at(-1)).toEqual({ token: POINT_MARKER_STALE_CLASS, force: true });
		ctrl.place(-74, 40.7); // re-place → setStale(false) again
		expect(toggled.at(-1)).toEqual({ token: POINT_MARKER_STALE_CLASS, force: false });
	});

	it('remove tears down the marker and resets placed state', () => {
		const { ctrl, mlb } = setup();
		ctrl.place(-74, 40.7);
		ctrl.remove();
		expect(mlb.calls).toContain('remove');
		expect(ctrl.isPlaced).toBe(false);
	});

	it('exposes the stable marker class for CSS targeting', () => {
		expect(POINT_MARKER_CLASS).toBe('darkmap-point-marker');
	});
});
