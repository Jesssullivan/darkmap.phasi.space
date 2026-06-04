/**
 * Basemap definitions. All sources are anonymous, no API key.
 *
 * "osm" is the familiar reference AND the default — the out-of-box display is
 * OSM + a faint (25%) VIIRS + Falchi radiance wash so streets stay legible under
 * the light-pollution layers. "dark" keeps the basemap quiet for a stronger
 * radiance read. "satellite" is for ground-truthing dark sky claims.
 */

export interface BasemapDef {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly tiles: ReadonlyArray<string>;
	readonly attribution: string;
	readonly maxZoom: number;
}

export const BASEMAPS: ReadonlyArray<BasemapDef> = [
	{
		id: 'dark',
		label: 'Dark',
		description: 'Carto Dark Matter — quiet vector basemap, ideal for radiance overlays.',
		tiles: [
			'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
			'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
			'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
			'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
		],
		attribution: '© OpenStreetMap, © CARTO',
		maxZoom: 19,
	},
	{
		id: 'osm',
		label: 'OSM',
		description: 'OpenStreetMap standard — familiar streets + labels.',
		tiles: [
			'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
			'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
			'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
		],
		attribution: '© OpenStreetMap',
		maxZoom: 19,
	},
	{
		id: 'satellite',
		label: 'Satellite',
		description: 'ESRI World Imagery — for ground-truthing dark sky / light dome claims.',
		// Note: ESRI puts {y} before {x} in the path.
		tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
		attribution: '© ESRI',
		maxZoom: 19,
	},
];

export const DEFAULT_BASEMAP_ID = 'osm';

export const basemapById = (id: string): BasemapDef => BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0];
