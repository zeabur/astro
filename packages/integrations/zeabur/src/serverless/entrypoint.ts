import type { SSRManifest } from 'astro';
import { App } from 'astro/app';
import { applyPolyfills } from 'astro/app/node';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { ASTRO_LOCALS_HEADER } from './adapter.js';
import { getRequest, setResponse } from './request-transform.js';

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
