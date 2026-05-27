import { Effect, Exit } from 'effect';
import { RouteImportServiceLive } from '$lib/routes/RouteImportService';

/**
 * Base application service layer for pure, shareable Effect services.
 * Browser hardware services stay opt-in so SSR and tests remain deterministic.
 */
export const AppLayer = RouteImportServiceLive;

/**
 * Drain an Effect to its success value or throw the failure cause.
 * Use only for top-level call sites that already handle their own errors.
 */
export const runOrThrow = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
	Effect.runPromise(effect as Effect.Effect<A, E, never>);

/** Re-export the canonical Exit-returning runner for callers that need to inspect failures. */
export const runExit = Effect.runPromiseExit;

export type AppExit<A, E> = Exit.Exit<A, E>;
