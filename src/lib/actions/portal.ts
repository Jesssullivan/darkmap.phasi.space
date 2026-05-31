/**
 * Svelte action that teleports a node to a target (default `document.body`).
 *
 * Used by HelpTooltip's popover positioner: Skeleton 4.15.2's Popover renders
 * the positioner inline, so when the trigger lives inside a scroll container
 * (the LayerRail, with `overflow-y: auto`) the popover is clipped at the
 * container's edge — CSS coerces `overflow-x` to clip whenever `overflow-y`
 * scrolls, so the help text gets cut off. Portaling the positioner to the
 * body lets Zag's floating-ui keep positioning it against the trigger while
 * it renders in a non-clipping layer.
 */
export function portal(node: HTMLElement, target: HTMLElement | string = 'body') {
	const resolve = (t: HTMLElement | string): HTMLElement | null =>
		typeof t === 'string' ? document.querySelector<HTMLElement>(t) : t;

	let dest = resolve(target);
	if (dest) dest.appendChild(node);

	return {
		update(next: HTMLElement | string) {
			const nextDest = resolve(next);
			if (nextDest && nextDest !== dest) {
				dest = nextDest;
				dest.appendChild(node);
			}
		},
		destroy() {
			node.parentNode?.removeChild(node);
		},
	};
}
