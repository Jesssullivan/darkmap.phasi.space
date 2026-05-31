import { describe, expect, it, vi } from 'vitest';
import { portal } from './portal';

/** Fake element with the appendChild/removeChild surface the action touches. */
const fakeEl = () => {
	const el = {
		appendChild: vi.fn(),
		removeChild: vi.fn(),
		parentNode: null as unknown as { removeChild: (n: unknown) => void } | null,
	};
	return el as unknown as HTMLElement;
};

describe('portal action', () => {
	it('appends the node to an explicit target on mount', () => {
		const node = fakeEl();
		const target = fakeEl();
		portal(node, target);
		expect((target as unknown as { appendChild: ReturnType<typeof vi.fn> }).appendChild).toHaveBeenCalledWith(node);
	});

	it('removes the node from its parent on destroy', () => {
		const node = fakeEl();
		const parentRemove = vi.fn();
		(node as unknown as { parentNode: unknown }).parentNode = { removeChild: parentRemove };
		const target = fakeEl();
		const handle = portal(node, target);
		handle.destroy();
		expect(parentRemove).toHaveBeenCalledWith(node);
	});

	it('re-appends to a new target on update', () => {
		const node = fakeEl();
		const first = fakeEl();
		const second = fakeEl();
		const handle = portal(node, first);
		handle.update?.(second);
		expect((second as unknown as { appendChild: ReturnType<typeof vi.fn> }).appendChild).toHaveBeenCalledWith(node);
	});

	it('does not re-append when the target is unchanged', () => {
		const node = fakeEl();
		const target = fakeEl();
		const appendSpy = (target as unknown as { appendChild: ReturnType<typeof vi.fn> }).appendChild;
		const handle = portal(node, target);
		expect(appendSpy).toHaveBeenCalledTimes(1);
		handle.update?.(target);
		expect(appendSpy).toHaveBeenCalledTimes(1); // same target → no second append
	});

	it('destroy is safe when the node has no parent', () => {
		const node = fakeEl();
		const target = fakeEl();
		const handle = portal(node, target);
		expect(() => handle.destroy()).not.toThrow();
	});
});
