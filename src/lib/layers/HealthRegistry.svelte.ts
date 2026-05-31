import { SvelteMap } from 'svelte/reactivity';
import { HEALTH_IDLE, reduceHealth, type HealthEvent, type LayerHealth } from './health-state';

/**
 * Reactive registry that anyone instrumenting a layer source can write to.
 * Wraps a `SvelteMap` so the LayerRail re-renders the moment a state
 * transition lands, without per-layer plumbing through Svelte props.
 *
 * Producers (call `dispatch`):
 *   - `+page.svelte` mount/unmount path
 *   - OpenAQ refresh sees `degraded:true`
 *   - MapLibre `error` event handler
 *   - Atmospheric fetch wrappers that read x-darkmap-atmospheric-outcome
 *
 * Consumer (`LayerRail`):
 *   - `getHealth(layerId)` returns the current state
 *
 * Cleared on full reload — health is in-memory only, never persisted.
 */
class HealthRegistry {
	private states = new SvelteMap<string, LayerHealth>();

	getHealth(layerId: string): LayerHealth {
		return this.states.get(layerId) ?? HEALTH_IDLE;
	}

	dispatch(layerId: string, event: HealthEvent): void {
		const current = this.getHealth(layerId);
		const next = reduceHealth(current, event);
		if (next === HEALTH_IDLE) {
			this.states.delete(layerId);
		} else {
			this.states.set(layerId, next);
		}
	}

	/** Test helper — drops all state. Not used at runtime. */
	__reset(): void {
		this.states.clear();
	}
}

export const layerHealth = new HealthRegistry();
