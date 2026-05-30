import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Hermetic SvelteKit adapter-node build runner for the Bazel `//:app_build`
// target. Modeled on tinyland.dev/scripts/bazel/run-vite-node-build.mjs, the
// proved `sveltekit-app-build` reference. The build runs `svelte-kit sync`
// then `vite build` inside an isolated temp workspace seeded from the Bazel
// exec-root inputs, then copies the adapter-node `build/` tree back into the
// exec-root so rules_js can capture it as the declared `out_dirs` output.
//
// darkmap reads zero secrets at build time (the only $env import is
// `$env/dynamic/private`, resolved at runtime), so unlike tinyland this runner
// injects no build-only key.

function copyEntry(sourceRoot, tempRoot, relativePath) {
	const sourcePath = path.join(sourceRoot, relativePath);
	if (!existsSync(sourcePath)) return;

	const destinationPath = path.join(tempRoot, relativePath);
	mkdirSync(path.dirname(destinationPath), { recursive: true });

	const stat = lstatSync(sourcePath);
	if (stat.isDirectory()) {
		cpSync(sourcePath, destinationPath, { recursive: true });
		return;
	}

	copyFileSync(sourcePath, destinationPath);
}

function makeTreeWritable(targetPath) {
	if (!existsSync(targetPath)) return;

	const stat = lstatSync(targetPath);
	if (stat.isDirectory()) {
		chmodSync(targetPath, stat.mode | 0o700);
		for (const child of readdirSync(targetPath)) {
			makeTreeWritable(path.join(targetPath, child));
		}
		return;
	}

	chmodSync(targetPath, stat.mode | 0o600);
}

function symlinkTreeChildren(sourceDir, destinationDir) {
	if (!existsSync(sourceDir)) return;

	mkdirSync(destinationDir, { recursive: true });
	for (const entry of readdirSync(sourceDir)) {
		symlinkSync(path.join(sourceDir, entry), path.join(destinationDir, entry));
	}
}

function resolvePackageBin(requireFromWorkspace, packageName, binName = packageName) {
	const packageJson = requireFromWorkspace.resolve(`${packageName}/package.json`);
	const manifest = JSON.parse(readFileSync(packageJson, 'utf8'));
	const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[binName];

	if (!bin) {
		throw new Error(`Package ${packageName} does not expose bin ${binName}`);
	}

	return path.join(path.dirname(packageJson), bin);
}

function runNodeTool(node, tool, args, cwd, env) {
	const result = spawnSync(node, [tool, ...args], {
		cwd,
		stdio: 'inherit',
		env,
	});

	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

function hasAdapterNodeOutput(cwd) {
	return (
		existsSync(path.join(cwd, 'build', 'index.js')) &&
		existsSync(path.join(cwd, 'build', 'handler.js')) &&
		existsSync(path.join(cwd, 'build', 'client'))
	);
}

async function runViteBuild(node, viteBin, cwd, env) {
	const child = spawn(node, [viteBin, 'build'], {
		cwd,
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	let terminatedAfterOutput = false;
	let lastOutputAt = Date.now();
	child.stdout.on('data', (chunk) => {
		lastOutputAt = Date.now();
		process.stdout.write(chunk);
	});
	child.stderr.on('data', (chunk) => {
		lastOutputAt = Date.now();
		process.stderr.write(chunk);
	});

	// adapter-node's precompress + a11y plugins can leave the vite process alive
	// after the bundle is fully written. Once the declared output exists and the
	// process has been quiet for 15s, terminate it so the action can complete.
	const watchdog = setInterval(() => {
		if (!hasAdapterNodeOutput(cwd)) return;
		if (Date.now() - lastOutputAt < 15_000) return;

		terminatedAfterOutput = true;
		console.error('vite build produced adapter-node output but remained alive; terminating open-handle process');
		child.kill('SIGTERM');
	}, 1000);

	const status = await new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', (code, signal) => resolve({ code, signal }));
	});
	clearInterval(watchdog);

	if (!hasAdapterNodeOutput(cwd)) {
		throw new Error('vite build did not produce build/index.js, build/handler.js and build/client');
	}

	if (status.code !== 0 && !terminatedAfterOutput) {
		throw new Error(`vite build failed with code ${status.code ?? status.signal}`);
	}
}

const execRoot = process.cwd();
const tempWorkspace = mkdtempSync(path.join(tmpdir(), 'darkmap-app-node-build-'));
const outputBuildDir = path.join(execRoot, 'build');

// darkmap's actual build inputs. Unlike tinyland this spoke has no
// content/, server/, mdsvex.config.js or tailwind.config.ts; the Tailwind v4
// config lives inline in vite.config.ts via @tailwindcss/vite.
const requiredEntries = [
	'src',
	'static',
	'data',
	'package.json',
	'pnpm-lock.yaml',
	'pnpm-workspace.yaml',
	'tsconfig.json',
	'svelte.config.js',
	'vite.config.ts',
];

try {
	for (const entry of requiredEntries) {
		copyEntry(execRoot, tempWorkspace, entry);
	}
	makeTreeWritable(tempWorkspace);

	const sourceNodeModules = path.join(execRoot, 'node_modules');
	if (existsSync(sourceNodeModules)) {
		symlinkTreeChildren(sourceNodeModules, path.join(tempWorkspace, 'node_modules'));
	}

	const requireFromWorkspace = createRequire(path.join(tempWorkspace, 'package.json'));
	const svelteKitBin = resolvePackageBin(requireFromWorkspace, '@sveltejs/kit', 'svelte-kit');
	const viteBin = resolvePackageBin(requireFromWorkspace, 'vite', 'vite');
	const env = {
		...process.env,
		NODE_ENV: 'production',
	};

	runNodeTool(process.execPath, svelteKitBin, ['sync'], tempWorkspace, env);
	await runViteBuild(process.execPath, viteBin, tempWorkspace, env);

	rmSync(outputBuildDir, { recursive: true, force: true });
	cpSync(path.join(tempWorkspace, 'build'), outputBuildDir, { recursive: true });
} finally {
	rmSync(tempWorkspace, { recursive: true, force: true });
}
