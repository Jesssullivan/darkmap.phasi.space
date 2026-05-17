/**
 * Strip ad / analytics / session-tracking headers from upstream responses
 * before they reach the browser. Phase 1 proxies binary rasters only, so
 * the surface is small. Phase 2+ HTML proxying will need a body rewriter;
 * that lands as a separate Effect Sink.
 */

const FORBIDDEN_HEADERS = new Set(['set-cookie', 'cookie', 'server-timing', 'x-powered-by']);

const FORBIDDEN_PREFIXES = ['x-prebid', 'x-googletag', 'x-ad-', 'x-gpt-'];

export function sanitizeHeaders(input: Headers): Headers {
	const out = new Headers();
	for (const [name, value] of input) {
		const lower = name.toLowerCase();
		if (FORBIDDEN_HEADERS.has(lower)) continue;
		if (FORBIDDEN_PREFIXES.some((p) => lower.startsWith(p))) continue;
		out.set(name, value);
	}
	return out;
}
