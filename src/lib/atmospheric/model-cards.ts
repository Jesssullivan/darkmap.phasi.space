/**
 * Model cards (atmospheric UX, PR3).
 *
 * Each map layer is backed by a real model or sensor product, but the
 * UI only showed a one-line `description`. A user couldn't tell what a
 * layer actually *measures*, in what units, from whom, or where to read
 * more. This is the single source of truth for that — surfaced as a `?`
 * Popover next to each layer in the rail, and reusable by the readout.
 *
 * Keyed by layer id, plus the `viirs_annual` group key (the rail shows
 * the VIIRS family as one toggle). Pure data + a lookup; no UI here.
 */

export interface ModelCard {
	/** Human title for the card heading. */
	readonly title: string;
	/** One sentence: what this layer physically measures or models. */
	readonly what: string;
	/** Physical units of the underlying quantity, when there is one. */
	readonly units?: string;
	/** Whether the value is directly measured or modeled/derived. */
	readonly kind: 'measured' | 'modeled' | 'imagery';
	/** Data source / provider, short. */
	readonly source: string;
	/** Authoritative link to read more about the source/model. */
	readonly href: string;
}

export const MODEL_CARDS: Readonly<Record<string, ModelCard>> = {
	viirs_annual: {
		title: 'VIIRS night lights',
		what: 'Annual composite of upward radiance at night from the Suomi-NPP Day/Night Band — a proxy for artificial sky glow.',
		units: 'nW·cm⁻²·sr⁻¹',
		kind: 'measured',
		source: 'NOAA / Earth Observation Group',
		href: 'https://eogdata.mines.edu/products/vnl/',
	},
	world_atlas_2015: {
		title: 'Falchi World Atlas (2015)',
		what: 'Modeled artificial night-sky brightness at the zenith, calibrated to VIIRS — the standard light-pollution reference.',
		units: 'mcd/m²',
		kind: 'modeled',
		source: 'Falchi et al. 2016, Sci. Adv.',
		href: 'https://doi.org/10.1126/sciadv.1600377',
	},
	'clouds-modis-terra': {
		title: 'MODIS Terra true-color',
		what: 'Daytime corrected-reflectance imagery (~10:30 local pass) — read clouds, snow, and smoke plumes over the area.',
		kind: 'imagery',
		source: 'NASA GIBS (MODIS Terra)',
		href: 'https://nasa-gibs.github.io/gibs-api-docs/',
	},
	'clouds-viirs-noaa20': {
		title: 'VIIRS NOAA-20 true-color',
		what: 'Afternoon corrected-reflectance imagery (~13:30 local pass) — a later cloud read to pair with the morning MODIS pass.',
		kind: 'imagery',
		source: 'NASA GIBS (VIIRS NOAA-20)',
		href: 'https://nasa-gibs.github.io/gibs-api-docs/',
	},
	'aerosol-modis-aod': {
		title: 'Aerosol optical depth',
		what: 'Column aerosol loading at 550 nm — how much haze, smoke, or dust is in the path. Higher means more scattering and attenuation.',
		units: 'AOD₅₅₀ (unitless)',
		kind: 'measured',
		source: 'NASA GIBS (MODIS Combined AOD)',
		href: 'https://nasa-gibs.github.io/gibs-api-docs/',
	},
	'water-vapor-airs': {
		title: 'Column water vapor',
		what: 'Total precipitable water through the atmospheric column — the main driver of infrared absorption bands in transmission.',
		units: 'cm (precipitable)',
		kind: 'measured',
		source: 'NASA GIBS (MODIS Terra water vapor)',
		href: 'https://nasa-gibs.github.io/gibs-api-docs/',
	},
	'smog-openaq-pm25': {
		title: 'PM2.5 (modeled field)',
		what: 'A kernel-diffusion estimate of surface fine-particulate concentration from sparse OpenAQ ground stations. Confidence drops where stations are sparse; unknown readings are excluded, never shown as clean air.',
		units: 'µg/m³',
		kind: 'modeled',
		source: 'OpenAQ ground stations (CC-BY)',
		href: 'https://openaq.org/',
	},
};

export const modelCardFor = (id: string): ModelCard | undefined => MODEL_CARDS[id];
