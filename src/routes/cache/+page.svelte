<script lang="ts">
	/**
	 * /cache — cache inspector (#234, child of #195).
	 *
	 * Renders the runtime cache snapshot grouped by `CacheBucket`,
	 * compared against `DEFAULT_BROWSER_CACHE_POLICY`. Each row carries
	 * a "Clear" button that drains the bucket via the existing
	 * `OfflineCacheService.evict` Effect — same code path the policy
	 * enforcer uses, so behavior cannot drift between automated and
	 * user-driven evictions.
	 *
	 * `app-shell` rows are read-only: that cache is owned by the SW
	 * upgrade lifecycle and clearing it from the UI would break offline
	 * navigation on next reload.
	 */

	import { onMount } from 'svelte';
	import { Effect } from 'effect';
	import { buildInspectorRows, buildInspectorTotals, formatBytes, type InspectorRow } from '$lib/cache/inspector';
	import { makeOfflineCacheServiceLive, OfflineCacheService } from '$lib/effect/services/OfflineCacheService';
	import { makeBrowserAdapter } from '$lib/effect/services/OfflineCacheServiceBrowser';

	type LoadState =
		| { kind: 'idle' }
		| { kind: 'loading' }
		| { kind: 'unsupported' }
		| { kind: 'ready'; rows: readonly InspectorRow[]; lastUpdated?: string }
		| { kind: 'error'; detail: string };

	let view = $state<LoadState>({ kind: 'idle' });
	let clearing = $state<Set<string>>(new Set());

	const supported = (): boolean =>
		typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof caches !== 'undefined';

	const adapter = $derived(supported() ? makeBrowserAdapter() : null);
	const layer = $derived(adapter ? makeOfflineCacheServiceLive(adapter) : null);

	const refresh = async (): Promise<void> => {
		if (!adapter || !layer) {
			view = { kind: 'unsupported' };
			return;
		}
		view = { kind: 'loading' };
		try {
			const snap = await adapter.snapshot();
			const rows = buildInspectorRows(snap);
			view = { kind: 'ready', rows, lastUpdated: snap.lastUpdated };
		} catch (e) {
			view = { kind: 'error', detail: (e as Error).message ?? String(e) };
		}
	};

	const clearBucket = async (bucket: InspectorRow['bucket']): Promise<void> => {
		if (!layer) return;
		clearing = new Set([...clearing, bucket]);
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* OfflineCacheService;
					return yield* svc.evict({ bucket, targetBytes: 0 });
				}).pipe(Effect.provide(layer)),
			);
			await refresh();
		} catch (e) {
			view = { kind: 'error', detail: (e as Error).message ?? String(e) };
		} finally {
			clearing = new Set([...clearing].filter((b) => b !== bucket));
		}
	};

	const totals = $derived(view.kind === 'ready' ? buildInspectorTotals(view.rows) : null);
	const totalFraction = $derived(
		totals && totals.totalTargetBytes > 0 ? Math.min(2, totals.totalBytesUsed / totals.totalTargetBytes) : null,
	);

	onMount(() => {
		void refresh();
	});
</script>

<svelte:head>
	<title>darkmap — cache inspector</title>
	<meta name="description" content="darkmap browser cache buckets, bytes used vs target, and per-bucket clear." />
</svelte:head>

<article class="container mx-auto max-w-3xl px-6 py-12 text-sm leading-relaxed">
	<header class="mb-8">
		<h1 class="font-mono text-2xl font-bold tracking-tight">cache inspector</h1>
		<p class="text-surface-700-300 mt-2">
			Per-bucket browser cache usage against the field-ready
			<a
				class="underline"
				href="https://github.com/Jesssullivan/darkmap.phasi.space/blob/main/src/lib/effect/services/CachePolicy.ts"
				>policy</a
			>. Clearing a bucket drops every entry in it; the next request refetches.
		</p>
	</header>

	{#if view.kind === 'loading' || view.kind === 'idle'}
		<p class="text-surface-700-300">Reading cache snapshot…</p>
	{:else if view.kind === 'unsupported'}
		<div class="border-warning-500 bg-warning-50-950 rounded border-l-4 p-4">
			<p class="font-mono text-sm">
				This browser does not expose <code>navigator.serviceWorker</code> or the <code>caches</code> API, so there is
				nothing to inspect here. Open <code>/cache</code> on a recent Chrome / Safari / Firefox build over HTTPS to see runtime
				cache state.
			</p>
		</div>
	{:else if view.kind === 'error'}
		<div class="border-error-500 bg-error-50-950 rounded border-l-4 p-4">
			<p class="font-mono text-sm">Failed to read cache snapshot: {view.detail}</p>
			<button class="btn btn-sm mt-3" onclick={refresh}>Retry</button>
		</div>
	{:else}
		{#if totals}
			<section class="mb-8 rounded border border-surface-300-700 p-4">
				<div class="flex items-baseline justify-between gap-4">
					<div>
						<div class="font-mono text-lg font-bold">{formatBytes(totals.totalBytesUsed)}</div>
						<div class="text-surface-700-300 text-xs">
							used across {totals.totalEntries} entries · target {formatBytes(totals.totalTargetBytes)}
						</div>
					</div>
					<button class="btn btn-sm" onclick={refresh}>Refresh</button>
				</div>
				{#if totalFraction !== null}
					<div class="mt-3 h-2 w-full overflow-hidden rounded bg-surface-200-800">
						<div
							class="h-full"
							class:bg-success-500={totalFraction < 0.7}
							class:bg-warning-500={totalFraction >= 0.7 && totalFraction < 1}
							class:bg-error-500={totalFraction >= 1}
							style="width: {Math.min(100, totalFraction * 100).toFixed(1)}%"
						></div>
					</div>
				{/if}
				{#if view.lastUpdated}
					<p class="text-surface-700-300 mt-2 text-xs">last write: {view.lastUpdated}</p>
				{/if}
			</section>
		{/if}

		<ul class="space-y-3">
			{#each view.rows as row (row.bucket)}
				<li class="rounded border border-surface-300-700 p-4">
					<div class="flex items-baseline justify-between gap-4">
						<div>
							<div class="font-mono text-sm font-bold">{row.label}</div>
							<div class="text-surface-700-300 text-xs">{row.description}</div>
						</div>
						<div class="text-right font-mono text-sm">
							{formatBytes(row.bytesUsed)}
							{#if row.targetBytes !== undefined}
								<span class="text-surface-700-300"> / {formatBytes(row.targetBytes)}</span>
							{:else}
								<span class="text-surface-700-300">(unmanaged)</span>
							{/if}
							<div class="text-surface-700-300 text-xs">{row.entryCount} entries</div>
						</div>
					</div>
					{#if row.fractionOfTarget !== undefined}
						<div class="mt-3 h-1.5 w-full overflow-hidden rounded bg-surface-200-800">
							<div
								class="h-full"
								class:bg-success-500={row.fractionOfTarget < 0.7}
								class:bg-warning-500={row.fractionOfTarget >= 0.7 && row.fractionOfTarget < 1}
								class:bg-error-500={row.fractionOfTarget >= 1}
								style="width: {Math.min(100, row.fractionOfTarget * 100).toFixed(1)}%"
							></div>
						</div>
					{/if}
					{#if row.canClear}
						<div class="mt-3 flex justify-end">
							<button
								class="btn btn-sm preset-tonal-error"
								disabled={clearing.has(row.bucket) || row.bytesUsed === 0}
								onclick={() => clearBucket(row.bucket)}
							>
								{clearing.has(row.bucket) ? 'Clearing…' : 'Clear'}
							</button>
						</div>
					{:else}
						<div class="text-surface-700-300 mt-2 text-xs italic">
							App shell is owned by the service-worker upgrade lifecycle and cannot be cleared from this view.
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</article>
