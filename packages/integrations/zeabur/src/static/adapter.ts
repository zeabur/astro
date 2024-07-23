import type { AstroAdapter, AstroConfig, AstroIntegration } from 'astro';

import { emptyDir, getOutput, writeJson } from '../lib/fs.js';
import { isServerLikeOutput } from '../lib/prerender.js';

const PACKAGE_NAME = '@zeabur/astro-adapter/static';

function getAdapter(): AstroAdapter {
	return {
		name: PACKAGE_NAME,
		supportedAstroFeatures: {
			assets: {
				supportKind: 'stable',
				isSquooshCompatible: true,
				isSharpCompatible: true,
			},
			staticOutput: 'stable',
			serverOutput: 'unsupported',
			hybridOutput: 'unsupported',
		},
		adapterFeatures: {
			edgeMiddleware: false,
			functionPerRoute: false,
		},
	};
}

export default function vercelStatic(): AstroIntegration {
	let _config: AstroConfig;

	return {
		name: '@zeabur/astro-adapter',
		hooks: {
			'astro:config:setup': async ({ config, updateConfig }) => {
				const outDir = new URL('./static/', getOutput(config.root));
				updateConfig({
					outDir,
					build: {
						format: 'directory',
						redirects: false,
					},
					vite: {},
				});
			},
			'astro:config:done': ({ setAdapter, config }) => {
				setAdapter(getAdapter());
				_config = config;

				if (isServerLikeOutput(config)) {
					throw new Error(`${PACKAGE_NAME} should be used with output: 'static'`);
				}
			},
			'astro:build:start': async () => {
				await emptyDir(getOutput(_config.root));
			},
			'astro:build:done': async () => {
				await writeJson(new URL(`./config.json`, getOutput(_config.root)), {
					routes: [{ src: '.*', dest: '/__astro' }],
					containerized: false,
				});
			},
		},
	};
}
