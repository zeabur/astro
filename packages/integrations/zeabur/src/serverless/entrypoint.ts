import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SSRManifest } from 'astro';
import { App } from 'astro/app';
import { applyPolyfills } from 'astro/app/node';

import { ASTRO_LOCALS_HEADER } from './adapter.js';
import { getRequest, setResponse } from './request-transform.js';

// Won't throw if the virtual module is not available because it's not supported in
// the users's astro version or if astro:env is not enabled in the project
await import('astro/env/setup')
	.then((mod) => mod.setGetEnv((key) => process.env[key]))
	.catch(() => {});

applyPolyfills();

export const createExports = (manifest: SSRManifest) => {
	const app = new App(manifest);

	const handler = async (req: IncomingMessage, res: ServerResponse) => {
		let request: Request;

		try {
			request = await getRequest(`https://${req.headers.host}`, req);
		} catch (err: any) {
			res.statusCode = err.status || 400;
			return res.end(err.reason || 'Invalid request body');
		}

		let routeData = app.match(request);
		let locals = {};
		if (request.headers.has(ASTRO_LOCALS_HEADER)) {
			let localsAsString = request.headers.get(ASTRO_LOCALS_HEADER);
			if (localsAsString) {
				locals = JSON.parse(localsAsString);
			}
		}
		await setResponse(app, res, await app.render(request, { routeData, locals }));
	};

	return { default: handler };
};
