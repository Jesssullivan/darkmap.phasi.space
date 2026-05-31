import { createReadStream } from 'node:fs';
import http from 'node:http';
import { stat } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handler } from './build/handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serviceWorkerPath = join(__dirname, 'build/client/service-worker.js');

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? '3000');

const serviceWorkerHeaders = {
	'cache-control': 'no-store, no-cache, max-age=0, must-revalidate',
	'content-type': 'text/javascript; charset=utf-8',
	'service-worker-allowed': '/',
};

const server = http.createServer(async (req, res) => {
	if (isServiceWorkerRequest(req)) {
		await serveServiceWorker(req, res);
		return;
	}

	handler(req, res, (err) => {
		if (err) {
			console.error(err);
			res.statusCode = 500;
			res.end('Internal server error');
			return;
		}

		res.statusCode = 404;
		res.end('Not found');
	});
});

server.listen(port, host, () => {
	console.log(`Listening on http://${host}:${port}`);
});

process.on('SIGTERM', () => closeGracefully('SIGTERM'));
process.on('SIGINT', () => closeGracefully('SIGINT'));

function isServiceWorkerRequest(req) {
	if (req.method !== 'GET' && req.method !== 'HEAD') return false;

	try {
		return new URL(req.url ?? '/', 'http://localhost').pathname === '/service-worker.js';
	} catch {
		return false;
	}
}

async function serveServiceWorker(req, res) {
	try {
		const file = await stat(serviceWorkerPath);
		res.writeHead(200, {
			...serviceWorkerHeaders,
			'content-length': file.size,
			'last-modified': file.mtime.toUTCString(),
		});

		if (req.method === 'HEAD') {
			res.end();
			return;
		}

		createReadStream(serviceWorkerPath).pipe(res);
	} catch (error) {
		console.error(error);
		res.statusCode = 500;
		res.end('Unable to load service worker');
	}
}

function closeGracefully(signal) {
	server.close((error) => {
		if (error) {
			console.error(error);
			process.exit(1);
		}

		process.exit(signal === 'SIGTERM' ? 0 : 130);
	});
}
