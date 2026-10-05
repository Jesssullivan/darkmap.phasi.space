<script lang="ts">
	import { onMount, tick } from 'svelte';
	import type { Snippet } from 'svelte';
	import { FloatingPanel, Portal } from '@skeletonlabs/skeleton-svelte';

	/** One inspector body, docked on SSR and medium layouts, detachable only wide. */
	interface Props {
		children: Snippet;
	}

	let { children: panelBody }: Props = $props();
	let hydrated = $state(false);
	let roomy = $state(false);
	let detached = $state(false);
	let defaultX = $state(48);
	let defaultY = $state(88);
	let maxHeight = $state(800);
	let detachButton = $state<HTMLButtonElement | undefined>();
	let dockHeading = $state<HTMLHeadingElement | undefined>();
	let floatHeading = $state<HTMLHeadingElement | undefined>();

	function detach(): void {
		if (!roomy) return;
		defaultX = Math.max(16, window.innerWidth - 464);
		defaultY = Math.min(88, Math.max(16, window.innerHeight - 456));
		maxHeight = Math.min(800, window.innerHeight - 32);
		detached = true;
		void tick().then(() => floatHeading?.focus());
	}

	function redock(): void {
		detached = false;
		// Resize can destroy this component before its replacement dock/disclosure
		// mounts. Wait for the parent flush AND the next frame before choosing focus.
		void tick().then(() => requestAnimationFrame(() => {
			const candidates = [
				document.querySelector<HTMLButtonElement>('[data-responsive-dock] .dock-tab'),
				document.querySelector<HTMLElement>('[data-short-air] summary'),
				roomy ? detachButton : dockHeading,
				document.querySelector<HTMLButtonElement>('.inspector-tab'),
				document.querySelector<HTMLButtonElement>('.toolbar button'),
			];
			candidates.find((candidate) => candidate?.getClientRects().length)?.focus();
		}));
	}

	onMount(() => {
		hydrated = true;
		const query = window.matchMedia('(min-width: 1280px) and (min-height: 501px)');
		const sync = () => {
			roomy = query.matches;
			if (!roomy && detached) redock();
		};
		query.addEventListener('change', sync);
		const onResize = () => {
			if (detached) redock();
		};
		window.addEventListener('resize', onResize);
		sync();
		return () => {
			query.removeEventListener('change', sync);
			window.removeEventListener('resize', onResize);
			// The short-screen fallback replaces this component. Its disclosure
			// must receive focus even if the parent unmounts before our resize event.
			if (detached) redock();
		};
	});
</script>

{#if detached}
	<Portal>
		<FloatingPanel
			defaultOpen
			allowOverflow={false}
			defaultPosition={{ x: defaultX, y: defaultY }}
			defaultSize={{ width: 420, height: 440 }}
			minSize={{ width: 290, height: 220 }}
			maxSize={{ width: 760, height: maxHeight }}
			closeOnEscape
			initialFocusEl={() => floatHeading ?? null}
			onStageChange={() => {
				// Stage controls can unmount during minimize/restore. Keep keyboard
				// focus inside the panel so Escape and subsequent controls stay usable.
				void tick().then(() => requestAnimationFrame(() => floatHeading?.focus()));
			}}
			onOpenChange={(details: { open: boolean }) => {
				if (!details.open) redock();
			}}
		>
			<FloatingPanel.Context>
				{#snippet children(panel)}
					<FloatingPanel.Positioner class="instrument-float-positioner">
						<FloatingPanel.Content class="instrument-float" aria-labelledby="instrument-panel-title" data-instrument-panel="floating">
							<FloatingPanel.Header class="instrument-float-header">
								<FloatingPanel.DragTrigger class="instrument-float-drag">
									<h2 id="instrument-panel-title" bind:this={floatHeading} tabindex="-1">Air · local dome</h2>
								</FloatingPanel.DragTrigger>
								<FloatingPanel.Control class="instrument-float-controls">
									<FloatingPanel.StageTrigger stage="minimized" aria-label="Minimize instruments" title="Minimize">−</FloatingPanel.StageTrigger>
									<FloatingPanel.StageTrigger stage="maximized" aria-label="Maximize instruments" title="Maximize">□</FloatingPanel.StageTrigger>
									<FloatingPanel.StageTrigger stage="default" aria-label="Restore instruments" title="Restore">↺</FloatingPanel.StageTrigger>
									<button type="button" aria-label="Redock instruments" title="Redock" onclick={redock}>↙</button>
								</FloatingPanel.Control>
							</FloatingPanel.Header>
							<FloatingPanel.Body class="instrument-float-body">{@render panelBody()}</FloatingPanel.Body>
							<FloatingPanel.ResizeTrigger axis="se" class="instrument-float-resize" aria-label="Resize instruments" />
						</FloatingPanel.Content>
					</FloatingPanel.Positioner>
				{/snippet}
			</FloatingPanel.Context>
		</FloatingPanel>
	</Portal>
{:else}
	<section class="instrument-panel" aria-labelledby="instrument-panel-title" data-instrument-panel="docked">
		<header class="instrument-panel-header">
			<h2 id="instrument-panel-title" bind:this={dockHeading} tabindex="-1">Air · local dome</h2>
			{#if hydrated && roomy}
				<button bind:this={detachButton} type="button" aria-label="Detach Air and local dome" onclick={detach}>Detach</button>
			{/if}
		</header>
		<div class="instrument-panel-body">{@render panelBody()}</div>
	</section>
{/if}

<style>
	.instrument-panel,
	:global(.instrument-float) {
		background: rgba(8, 10, 16, 0.94);
		color: #e9ecf3;
		border: 1px solid rgba(255, 255, 255, 0.14);
		border-radius: 8px;
		box-shadow: 0 10px 32px rgba(0, 0, 0, 0.35);
	}
	.instrument-panel {
		display: none;
		flex: 0 0 auto;
		min-width: 0;
		max-height: min(43vh, 18rem);
		overflow: auto;
	}
	@media (min-width: 640px) and (min-height: 501px) {
		.instrument-panel { display: block; }
	}
	.instrument-panel-header,
	:global(.instrument-float-header) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.35rem 0.55rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.1);
		font: 600 0.7rem var(--font-mono, ui-monospace, monospace);
	}
	.instrument-panel-header h2,
	:global(.instrument-float-header h2) { margin: 0; min-width: 0; flex: 1 1 auto; }
	:global(.instrument-float-drag) { flex: 1 1 auto; min-width: 0; cursor: move; touch-action: none; }
	.instrument-panel-header button,
	:global(.instrument-float-controls button) {
		background: rgba(255, 255, 255, 0.06);
		color: inherit;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 5px;
		min-width: 2rem;
		min-height: 2rem;
		cursor: pointer;
	}
	.instrument-panel-header button:focus-visible,
	:global(.instrument-float-controls button:focus-visible) { outline: 2px solid var(--accent-amber); outline-offset: 2px; }
	.instrument-panel-body,
	:global(.instrument-float-body) { padding: 0.45rem; min-height: 0; overflow: auto; }
	:global(.instrument-panel .tile),
	:global(.instrument-float .tile) { border: 0; }
	:global(.instrument-float-positioner) { position: fixed; z-index: 60; }
	:global(.instrument-float) { display: flex; position: relative; flex-direction: column; height: 100%; min-height: 0; }
	:global(.instrument-float-controls) { display: flex; gap: 0.25rem; }
	:global(.instrument-float-body) { flex: 1 1 auto; }
	:global(.instrument-float-resize) { position: absolute; right: 0; bottom: 0; width: 1.25rem; height: 1.25rem; cursor: se-resize; }
	@media (prefers-reduced-motion: reduce) {
		:global(.instrument-float-positioner),
		:global(.instrument-float) { animation: none; transition: none; }
	}
</style>
