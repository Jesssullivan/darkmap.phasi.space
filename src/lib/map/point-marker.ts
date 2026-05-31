/**
 * Queried-point locator marker (atmospheric UX pass, PR1).
 *
 * When a user clicks the map, the PointReadout shows numbers for that
 * location but nothing on the map said *where* — the reading floated free
 * of its place. This drops a quiet amber crosshair at the queried
 * lon/lat so the readout's numbers are anchored to a visible point, and
 * dims it once the readout is dismissed (the reading is now historical,
 * not current).
 *
 * The marker is imperative MapLibre DOM (it lives on the map, not in the
 * Svelte tree), so the controller takes its `maplibre` module + map as
 * injected deps and an overridable element factory — that keeps the
 * place / stale / remove logic unit-testable under the node test env
 * without a real DOM or MapLibre instance.
 */

export const POINT_MARKER_CLASS = 'darkmap-point-marker';
export const POINT_MARKER_STALE_CLASS = 'is-stale';

/**
 * Crosshair SVG markup (pure string). Uses `currentColor` so the amber
 * tint + dim-when-stale live in CSS (app.css `.darkmap-point-marker`).
 * A center gap keeps the exact pixel under the crosshair readable.
 */
export const pointMarkerSvg = (): string =>
	`<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">` +
	`<circle cx="12" cy="12" r="6" />` +
	`<line x1="12" y1="0" x2="12" y2="5" />` +
	`<line x1="12" y1="19" x2="12" y2="24" />` +
	`<line x1="0" y1="12" x2="5" y2="12" />` +
	`<line x1="19" y1="12" x2="24" y2="12" />` +
	`</svg>`;

/** Structural subset of the MapLibre Marker we depend on (so tests pass a fake). */
export interface MarkerLike {
	setLngLat(lngLat: [number, number]): MarkerLike;
	addTo(map: unknown): MarkerLike;
	remove(): void;
}

export interface PointMarkerDeps {
	/** The MapLibre module (or a `{ Marker }` subset). Real `maplibre.Marker` is assignable. */
	readonly maplibre: { Marker: new (opts: { element: HTMLElement }) => MarkerLike };
	readonly map: unknown;
	/** Override for tests; defaults to the global document. */
	readonly createElement?: () => HTMLElement;
}

const defaultElementFactory = (): HTMLElement => {
	const el = document.createElement('div');
	el.className = POINT_MARKER_CLASS;
	el.innerHTML = pointMarkerSvg();
	el.setAttribute('aria-hidden', 'true');
	return el;
};

/**
 * Owns a single MapLibre marker. `place` is idempotent — it moves the
 * existing marker rather than creating a second one — so rapid clicks
 * never stack markers. `setStale` dims it; `remove` tears it down.
 */
export class PointMarkerController {
	private marker: MarkerLike | undefined;
	private element: HTMLElement | undefined;
	private readonly deps: PointMarkerDeps;
	private readonly makeElement: () => HTMLElement;

	constructor(deps: PointMarkerDeps) {
		this.deps = deps;
		this.makeElement = deps.createElement ?? defaultElementFactory;
	}

	/** Place (or move) the marker at lon/lat and clear any stale dim. */
	place(lon: number, lat: number): void {
		if (!this.marker) {
			this.element = this.makeElement();
			this.marker = new this.deps.maplibre.Marker({ element: this.element }).setLngLat([lon, lat]).addTo(this.deps.map);
		} else {
			this.marker.setLngLat([lon, lat]);
		}
		this.setStale(false);
	}

	/** Dim the marker — the readout it anchored is closed / historical. */
	setStale(stale: boolean): void {
		this.element?.classList.toggle(POINT_MARKER_STALE_CLASS, stale);
	}

	/** Remove the marker entirely. */
	remove(): void {
		this.marker?.remove();
		this.marker = undefined;
		this.element = undefined;
	}

	/** Test/inspection helper. */
	get isPlaced(): boolean {
		return this.marker !== undefined;
	}
}
