<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { browser } from '$app/environment';
	import LayerRail from '$lib/components/LayerRail.svelte';
	import { FALLBACK_CENTER, FALLBACK_ZOOM, LAYERS, rasterUrlTemplate, type RasterLayerDef } from '$lib/layers';

	let mapEl: HTMLDivElement | undefined = $state();
	let mapInstance: import('maplibre-gl').Map | undefined;
	const enabled: Record<string, boolean> = $state(Object.fromEntries(LAYERS.map((l) => [l.id, l.defaultEnabled])));

	const sourceIdFor = (l: RasterLayerDef) => `darkmap-${l.id}-src`;
	const layerIdFor = (l: RasterLayerDef) => `darkmap-${l.id}-lyr`;

	function addLayerToMap(map: import('maplibre-gl').Map, l: RasterLayerDef): void {
		if (map.getSource(sourceIdFor(l))) return;
		map.addSource(sourceIdFor(l), {
			type: 'raster',
			tiles: [rasterUrlTemplate(l.id)],
			tileSize: 256,
		});
		map.addLayer({
			id: layerIdFor(l),
			type: 'raster',
			source: sourceIdFor(l),
			paint: { 'raster-opacity': l.opacity },
		});
	}

	function removeLayerFromMap(map: import('maplibre-gl').Map, l: RasterLayerDef): void {
		if (map.getLayer(layerIdFor(l))) map.removeLayer(layerIdFor(l));
		if (map.getSource(sourceIdFor(l))) map.removeSource(sourceIdFor(l));
	}

	function onToggle(id: string, on: boolean): void {
		enabled[id] = on;
		const layer = LAYERS.find((l) => l.id === id);
		if (!layer || !mapInstance) return;
		if (on) addLayerToMap(mapInstance, layer);
		else removeLayerFromMap(mapInstance, layer);
	}

	function getInitialCenter(): Promise<[number, number]> {
		if (!browser || !('geolocation' in navigator)) {
			return Promise.resolve([...FALLBACK_CENTER] as [number, number]);
		}
		return new Promise((resolve) => {
			navigator.geolocation.getCurrentPosition(
				(pos) => resolve([pos.coords.longitude, pos.coords.latitude]),
				() => resolve([...FALLBACK_CENTER] as [number, number]),
				{ timeout: 4000, maximumAge: 60_000 },
			);
		});
	}

	onMount(async () => {
		if (!mapEl) return;
		const maplibre = await import('maplibre-gl');
		const center = await getInitialCenter();
		mapInstance = new maplibre.Map({
			container: mapEl,
			style: {
				version: 8,
				sources: {
					osm: {
						type: 'raster',
						tiles: [
							'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
							'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
							'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
						],
						tileSize: 256,
						attribution: '© OpenStreetMap',
					},
				},
				layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
			},
			center,
			zoom: FALLBACK_ZOOM,
			attributionControl: false,
		});
		mapInstance.addControl(new maplibre.AttributionControl({ compact: true }), 'bottom-right');

		mapInstance.on('load', () => {
			if (!mapInstance) return;
			for (const layer of LAYERS) {
				if (enabled[layer.id]) addLayerToMap(mapInstance, layer);
			}
		});
	});

	onDestroy(() => {
		mapInstance?.remove();
		mapInstance = undefined;
	});
</script>

<svelte:head>
	<title>darkmap.tinyland.dev</title>
	<meta
		name="description"
		content="Ad-free reimplementation of lightpollutionmap.info — VIIRS, Falchi 2016 World Atlas, SQM."
	/>
	<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css" />
</svelte:head>

<div bind:this={mapEl} class="map" aria-label="Light pollution map"></div>
<LayerRail layers={LAYERS} {enabled} ontoggle={onToggle} />

<footer class="attribution">
	Data © Jurij Stare,
	<a href="https://www.lightpollutionmap.info">lightpollutionmap.info</a>
	— NASA VIIRS DNB · Falchi et al. 2016
</footer>

<style>
	:global(html),
	:global(body) {
		margin: 0;
		padding: 0;
		height: 100%;
		background: #06080d;
		color: #e9ecf3;
		font-family: var(--font-sans, system-ui, sans-serif);
	}
	.map {
		position: fixed;
		inset: 0;
	}
	.attribution {
		position: absolute;
		bottom: 0.5rem;
		left: 1rem;
		font-size: 0.7rem;
		color: rgba(233, 236, 243, 0.65);
		background: rgba(8, 10, 16, 0.75);
		padding: 0.35rem 0.65rem;
		border-radius: 4px;
		z-index: 5;
	}
	.attribution a {
		color: #ffd166;
	}
</style>
