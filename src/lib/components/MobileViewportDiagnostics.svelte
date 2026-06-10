<script lang="ts">
	import { onMount } from 'svelte';
	import { diagnostics } from '$lib/diagnostics.svelte';

	// Gate resolves in onMount (reads ?diag=1 / localStorage). Off → renders nothing,
	// attaches nothing. Pinned top-left, click-through except the controls, so it never
	// blocks the dock/gesture being profiled.
	onMount(() => diagnostics.init());

	let copied = $state(false);
	const doCopy = async (): Promise<void> => {
		copied = await diagnostics.exportJSON();
		setTimeout(() => (copied = false), 1500);
	};

	// The latest snapshot for the live readout (the tail event carrying viewport data).
	const latest = $derived(diagnostics.events.length ? diagnostics.events[diagnostics.events.length - 1] : null);
	const tail = $derived(diagnostics.events.slice(-10).reverse());
</script>

{#if diagnostics.enabled}
	<div class="diag" role="status" aria-label="Mobile viewport diagnostics">
		<div class="diag-head">
			<strong>diag</strong>
			<span class="perm">{diagnostics.permutation}</span>
			<span class="count">{diagnostics.events.length} evt</span>
			<button type="button" onclick={doCopy}>{copied ? '✓ copied' : 'copy'}</button>
			<button type="button" onclick={() => diagnostics.clear()}>clear</button>
			<button type="button" onclick={() => (diagnostics.enabled = false)}>×</button>
		</div>
		{#if latest}
			<div class="diag-now">
				vvH {latest.data.vvH} · off {latest.data.vvOffTop} · winH {latest.data.winH} · --vvb {latest.data.vvBottomVar} · rail
				{latest.data.railScrollTop}/{latest.data.railScrollH}
			</div>
		{/if}
		<ol class="diag-log">
			{#each tail as e (e.t + e.kind)}
				<li>
					<span class="t">{e.t}</span> <span class="k">{e.kind}</span> vvH={e.data.vvH} off={e.data.vvOffTop} rail={e
						.data.railScrollTop}
				</li>
			{/each}
		</ol>
	</div>
{/if}

<style>
	.diag {
		position: fixed;
		top: env(safe-area-inset-top, 0px);
		left: 0;
		z-index: 2147483646; /* above everything, including the dock */
		max-width: 100vw;
		font-family: ui-monospace, monospace;
		font-size: 9px;
		line-height: 1.35;
		color: #c8f6ff;
		background: rgba(4, 8, 14, 0.82);
		border-bottom: 1px solid rgba(94, 226, 208, 0.4);
		padding: 2px 4px;
		pointer-events: none; /* click-through over the map/dock being profiled */
	}
	.diag-head {
		display: flex;
		gap: 6px;
		align-items: center;
		pointer-events: auto; /* only the controls are interactive */
	}
	.diag-head strong {
		color: #5ee2d0;
	}
	.perm {
		color: #ffd166;
	}
	.count {
		opacity: 0.6;
	}
	.diag-head button {
		font: inherit;
		color: #c8f6ff;
		background: rgba(94, 226, 208, 0.12);
		border: 1px solid rgba(94, 226, 208, 0.35);
		border-radius: 3px;
		padding: 0 4px;
		cursor: pointer;
	}
	.diag-now {
		opacity: 0.9;
	}
	.diag-log {
		margin: 1px 0 0;
		padding: 0;
		list-style: none;
		max-height: 28vh;
		overflow: hidden;
	}
	.diag-log .t {
		color: #ffd166;
	}
	.diag-log .k {
		color: #6bb6ff;
	}
</style>
