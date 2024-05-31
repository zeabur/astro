import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { load as cheerioLoad } from 'cheerio';
import { loadFixture } from '../../astro/test/test-utils.js';
import { setupRemoteDbServer } from './test-utils.js';

describe('astro:db', () => {
	let fixture;
	before(async () => {
		fixture = await loadFixture({
			root: new URL('./fixtures/static-remote/', import.meta.url),
			output: 'static',
		});
	});

	describe('static build --remote', () => {
		let remoteDbServer;

		before(async () => {
			remoteDbServer = await setupRemoteDbServer(fixture.config);
			await fixture.build();
		});

		after(async () => {
			await remoteDbServer?.stop();
		});

		it('Can render page', async () => {
			const html = await fixture.readFile('/index.html');
			const $ = cheerioLoad(html);

			assert.equal($('li').length, 1);
		});

		it('Returns correct shape from db.run()', async () => {
			const html = await fixture.readFile('/run/index.html');
			const $ = cheerioLoad(html);

			assert.match($('#row').text(), /1/);
		});
	});
});
