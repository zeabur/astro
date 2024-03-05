import type {
	AstroAdapter,
	AstroConfig,
	AstroIntegration,
	AstroIntegrationLogger,
	RouteData,
} from 'astro';
import { AstroError } from 'astro/errors';
import glob from 'fast-glob';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getOutput, removeDir, writeJson } from '../lib/fs.js';
import { copyDependenciesToFunction } from '../lib/nft.js';
import { generateEdgeMiddleware } from './middleware.js';

const PACKAGE_NAME = '@zeabur/astro-adapter/serverless';
export const ASTRO_LOCALS_HEADER = 'x-astro-locals';
export const VERCEL_EDGE_MIDDLEWARE_FILE = 'vercel-edge-middleware';

// https://vercel.com/docs/concepts/functions/serverless-functions/runtimes/node-js#node.js-version
const SUPPORTED_NODE_VERSIONS: Record<
	string,
	{ status: 'current' } | { status: 'beta' } | { status: 'deprecated'; removal: Date }
> = {
	16: { status: 'deprecated', removal: new Date('February 6 2024') },
	18: { status: 'current' },
	20: { status: 'beta' },
};

function getAdapter({
	edgeMiddleware,
	functionPerRoute,
}: {
	edgeMiddleware: boolean;
	functionPerRoute: boolean;
}): AstroAdapter {
	return {
		name: PACKAGE_NAME,
		serverEntrypoint: `${PACKAGE_NAME}/entrypoint`,
		exports: ['default'],
		adapterFeatures: {
			edgeMiddleware,
			functionPerRoute,
		},
		supportedAstroFeatures: {
			hybridOutput: 'stable',
			staticOutput: 'stable',
			serverOutput: 'stable',
			assets: {
				supportKind: 'stable',
				isSharpCompatible: true,
				isSquooshCompatible: true,
			},
		},
	};
}

export interface VercelServerlessConfig {
	/** Force files to be bundled with your function. This is helpful when you notice missing files. */
	includeFiles?: string[];

	/** Exclude any files from the bundling process that would otherwise be included. */
	excludeFiles?: string[];

	/** Whether to create the Vercel Edge middleware from an Astro middleware in your code base. */
	edgeMiddleware?: boolean;

	/** Whether to split builds into a separate function for each route. */
	functionPerRoute?: boolean;

	/** The maximum duration (in seconds) that Serverless Functions can run before timing out. See the [Vercel documentation](https://vercel.com/docs/functions/serverless-functions/runtimes#maxduration) for the default and maximum limit for your account plan. */
	maxDuration?: number;
}

export default function vercelServerless({
	includeFiles,
	excludeFiles,
	functionPerRoute = false,
	edgeMiddleware = false,
	maxDuration,
}: VercelServerlessConfig = {}): AstroIntegration {
	if (maxDuration) {
		if (typeof maxDuration !== 'number') {
			throw new TypeError(`maxDuration must be a number`, { cause: maxDuration });
		}
		if (maxDuration <= 0) {
			throw new TypeError(`maxDuration must be a positive number`, { cause: maxDuration });
		}
	}

	let _config: AstroConfig;
	let buildTempFolder: URL;
	let serverEntry: string;
	let _entryPoints: Map<RouteData, URL>;
	// Extra files to be merged with `includeFiles` during build
	const extraFilesToInclude: URL[] = [];

	const NTF_CACHE = Object.create(null);

	return {
		name: PACKAGE_NAME,
		hooks: {
			'astro:config:setup': async ({ config, updateConfig, logger }) => {
				if (maxDuration && maxDuration > 900) {
					logger.warn(
						`maxDuration is set to ${maxDuration} seconds, which is longer than the maximum allowed duration of 900 seconds.`
					);
					logger.warn(
						`Please make sure that your plan allows for this duration. See https://vercel.com/docs/functions/serverless-functions/runtimes#maxduration for more information.`
					);
				}

				const outDir = getOutput(config.root);
				updateConfig({
					outDir,
					build: {
						serverEntry: 'index.mjs',
						client: new URL('./static/', outDir),
						server: new URL('./dist/', config.root),
						redirects: false,
					},
					vite: {
						ssr: {
							external: ['@vercel/nft'],
						},
					},
				});
			},
			'astro:config:done': ({ setAdapter, config, logger }) => {
				if (functionPerRoute === true) {
					logger.warn(
						`Vercel's hosting plans might have limits to the number of functions you can create.
Make sure to check your plan carefully to avoid incurring additional costs.
You can set functionPerRoute: false to prevent surpassing the limit.`
					);
				}
				setAdapter(getAdapter({ functionPerRoute, edgeMiddleware }));
				_config = config;
				buildTempFolder = config.build.server;
				serverEntry = config.build.serverEntry;

				if (config.output === 'static') {
					throw new AstroError(
						'`output: "server"` or `output: "hybrid"` is required to use the serverless adapter.'
					);
				}
			},

			'astro:build:ssr': async ({ entryPoints, middlewareEntryPoint }) => {
				_entryPoints = entryPoints;
				if (middlewareEntryPoint) {
					const outPath = fileURLToPath(buildTempFolder);
					const vercelEdgeMiddlewareHandlerPath = new URL(
						VERCEL_EDGE_MIDDLEWARE_FILE,
						_config.srcDir
					);
					const bundledMiddlewarePath = await generateEdgeMiddleware(
						middlewareEntryPoint,
						outPath,
						vercelEdgeMiddlewareHandlerPath
					);
					// let's tell the adapter that we need to save this file
					extraFilesToInclude.push(bundledMiddlewarePath);
				}
			},

			'astro:build:done': async ({ routes, logger }) => {
				// Merge any includes from `vite.assetsInclude
				if (_config.vite.assetsInclude) {
					const mergeGlobbedIncludes = (globPattern: unknown) => {
						if (typeof globPattern === 'string') {
							const entries = glob.sync(globPattern).map((p) => pathToFileURL(p));
							extraFilesToInclude.push(...entries);
						} else if (Array.isArray(globPattern)) {
							for (const pattern of globPattern) {
								mergeGlobbedIncludes(pattern);
							}
						}
					};

					mergeGlobbedIncludes(_config.vite.assetsInclude);
				}

				const routeDefinitions: { src: string; dest: string }[] = [];
				const filesToInclude = includeFiles?.map((file) => new URL(file, _config.root)) || [];
				filesToInclude.push(...extraFilesToInclude);

				validateRuntime();

				// Multiple entrypoint support
				if (_entryPoints.size) {
					const getRouteFuncName = (route: RouteData) => route.component.replace('src/pages/', '');

					const getFallbackFuncName = (entryFile: URL) =>
						basename(entryFile.toString())
							.replace('entry.', '')
							.replace(/\.mjs$/, '');

					for (const [route, entryFile] of _entryPoints) {
						const func = route.component.startsWith('src/pages/')
							? getRouteFuncName(route)
							: getFallbackFuncName(entryFile);

						await createFunctionFolder({
							functionName: func,
							entry: entryFile,
							config: _config,
							logger,
							NTF_CACHE,
							includeFiles: filesToInclude,
							excludeFiles,
							maxDuration,
						});
						routeDefinitions.push({
							src: route.pattern.source,
							dest: func,
						});
					}
				} else {
					await createFunctionFolder({
						functionName: '__astro',
						entry: new URL(serverEntry, buildTempFolder),
						config: _config,
						logger,
						NTF_CACHE,
						includeFiles: filesToInclude,
						excludeFiles,
						maxDuration,
					});
					routeDefinitions.push({ src: '/.*', dest: '__astro' });
				}

				await writeJson(new URL(`./config.json`, _config.outDir), {"routes":[{"src":".*","dest":"/__astro"}],"containerized":false});

				// Remove temporary folder
				await removeDir(buildTempFolder);
			},
		},
	};
}

interface CreateFunctionFolderArgs {
	functionName: string;
	entry: URL;
	config: AstroConfig;
	logger: AstroIntegrationLogger;
	NTF_CACHE: any;
	includeFiles: URL[];
	excludeFiles?: string[];
	maxDuration: number | undefined;
}

async function createFunctionFolder({
	functionName,
	entry,
	config,
	logger,
	NTF_CACHE,
	includeFiles,
	excludeFiles,
}: CreateFunctionFolderArgs) {
	const functionFolder = new URL(`./functions/${functionName}.func/`, config.outDir);

	// Copy necessary files (e.g. node_modules/)
	await copyDependenciesToFunction(
		{
			entry,
			outDir: functionFolder,
			includeFiles,
			excludeFiles: excludeFiles?.map((file) => new URL(file, config.root)) || [],
			logger,
		},
		NTF_CACHE
	);

	// Enable ESM
	// https://aws.amazon.com/blogs/compute/using-node-js-es-modules-and-top-level-await-in-aws-lambda/
	await writeJson(new URL(`./package.json`, functionFolder), {
		type: 'module',
	});
}

function validateRuntime() {
	const version = process.version.slice(1); // 'v16.5.0' --> '16.5.0'
	const major = version.split('.')[0]; // '16.5.0' --> '16'
	const support = SUPPORTED_NODE_VERSIONS[major];
	if (support.status === 'beta') {
		console.warn(
			`[${PACKAGE_NAME}] The local Node.js version (${major}) is currently in beta for Vercel Serverless Functions.`
		);
		console.warn(`[${PACKAGE_NAME}] Make sure to update your Vercel settings to use ${major}.`);
		return;
	}
	if (support === undefined) {
		console.warn(
			`[${PACKAGE_NAME}] The local Node.js version (${major}) is not supported by Vercel Serverless Functions.`
		);
		console.warn(`[${PACKAGE_NAME}] Your project will use Node.js 18 as the runtime instead.`);
		console.warn(`[${PACKAGE_NAME}] Consider switching your local version to 18.`);
		return;
	}
	if (support.status === 'deprecated') {
		console.warn(
			`[${PACKAGE_NAME}] Your project is being built for Node.js ${major} as the runtime.`
		);
		console.warn(
			`[${PACKAGE_NAME}] This version is deprecated by Vercel Serverless Functions, and scheduled to be disabled on ${new Intl.DateTimeFormat(
				undefined,
				{ dateStyle: 'long' }
			).format(support.removal)}.`
		);
		console.warn(`[${PACKAGE_NAME}] Consider upgrading your local version to 18.`);
	}
}
