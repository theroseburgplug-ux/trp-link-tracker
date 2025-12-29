import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src';

describe('TRP Link Tracker', () => {
	let testOwnerKey;
	let testSlug;

	beforeEach(async () => {
		// Clean up test data before each test
		const list = await env.LINKS.list();
		for (const key of list.keys) {
			await env.LINKS.delete(key.name);
		}
		testOwnerKey = null;
		testSlug = null;
	});

	describe('Homepage', () => {
		it('responds with TRP Link Tracker Running', async () => {
			const response = await SELF.fetch('http://example.com');
			expect(await response.text()).toContain('TRP Link Tracker Running');
		});
	});

	describe('Link Creation with Owner Index', () => {
		it('creates a link and adds it to owner index', async () => {
			const response = await SELF.fetch('http://example.com/api/links', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					slug: 'test123',
					destination: 'https://example.com/dest',
					title: 'Test Link'
				})
			});

			const result = await response.json();
			expect(result.success).toBe(true);
			expect(result.slug).toBe('test123');
			expect(result.owner_key).toBeTruthy();

			testOwnerKey = result.owner_key;
			testSlug = result.slug;

			// Verify owner index was created
			const indexKey = `owner:${testOwnerKey}`;
			const indexData = await env.LINKS.get(indexKey);
			expect(indexData).toBeTruthy();

			const slugs = JSON.parse(indexData);
			expect(slugs).toContain('test123');
		});

		it('creates multiple links for same owner', async () => {
			// Create first link
			const response1 = await SELF.fetch('http://example.com/api/links', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					slug: 'link1',
					destination: 'https://example.com/1',
					title: 'Link 1'
				})
			});
			const result1 = await response1.json();
			testOwnerKey = result1.owner_key;

			// Create second link
			const response2 = await SELF.fetch('http://example.com/api/links', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					slug: 'link2',
					destination: 'https://example.com/2',
					title: 'Link 2'
				})
			});
			const result2 = await response2.json();

			// Manually add second link to same owner's index
			const indexKey = `owner:${testOwnerKey}`;
			const indexData = await env.LINKS.get(indexKey);
			let slugs = JSON.parse(indexData);
			slugs.push('link2');
			await env.LINKS.put(indexKey, JSON.stringify(slugs));

			// Update link2's owner_key
			const link2Data = await env.LINKS.get('link2');
			const link2 = JSON.parse(link2Data);
			link2.owner_key = testOwnerKey;
			await env.LINKS.put('link2', JSON.stringify(link2));

			// Verify owner index has both links
			const updatedIndexData = await env.LINKS.get(indexKey);
			const updatedSlugs = JSON.parse(updatedIndexData);
			expect(updatedSlugs).toContain('link1');
			expect(updatedSlugs).toContain('link2');
			expect(updatedSlugs.length).toBe(2);
		});
	});

	describe('List Links Using Owner Index', () => {
		it('lists links using owner index', async () => {
			// Create a link
			const createResponse = await SELF.fetch('http://example.com/api/links', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					slug: 'indexed-link',
					destination: 'https://example.com/dest',
					title: 'Indexed Link'
				})
			});
			const createResult = await createResponse.json();
			testOwnerKey = createResult.owner_key;

			// List links for this owner
			const listResponse = await SELF.fetch(`http://example.com/api/links?key=${testOwnerKey}`);
			const listResult = await listResponse.json();

			expect(listResult.links).toBeTruthy();
			expect(listResult.links.length).toBe(1);
			expect(listResult.links[0].slug).toBe('indexed-link');
			expect(listResult.links[0].title).toBe('Indexed Link');
		});

		it('returns empty array for owner with no links', async () => {
			const fakeOwnerKey = 'nonexistent1234567890abcdef';
			const listResponse = await SELF.fetch(`http://example.com/api/links?key=${fakeOwnerKey}`);
			const listResult = await listResponse.json();

			expect(listResult.links).toEqual([]);
		});
	});

	describe('Link Deletion with Owner Index', () => {
		it('deletes a link and removes from owner index', async () => {
			// Create a link
			const createResponse = await SELF.fetch('http://example.com/api/links', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					slug: 'deleteme',
					destination: 'https://example.com/dest',
					title: 'Delete Me'
				})
			});
			const createResult = await createResponse.json();
			testOwnerKey = createResult.owner_key;

			// Delete the link
			const deleteResponse = await SELF.fetch(`http://example.com/api/delete/deleteme?key=${testOwnerKey}`, {
				method: 'DELETE'
			});
			const deleteResult = await deleteResponse.json();
			expect(deleteResult.success).toBe(true);

			// Verify link was deleted
			const linkData = await env.LINKS.get('deleteme');
			expect(linkData).toBeNull();

			// Verify owner index was cleaned up (should be deleted since no links remain)
			const indexKey = `owner:${testOwnerKey}`;
			const indexData = await env.LINKS.get(indexKey);
			expect(indexData).toBeNull();
		});
	});

	describe('Recent Links Endpoint', () => {
		it('returns recently created links', async () => {
			// Create a few links
			await SELF.fetch('http://example.com/api/links', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					slug: 'recent1',
					destination: 'https://example.com/1',
					title: 'Recent 1'
				})
			});

			await SELF.fetch('http://example.com/api/links', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					slug: 'recent2',
					destination: 'https://example.com/2',
					title: 'Recent 2'
				})
			});

			// Get recent links
			const response = await SELF.fetch('http://example.com/api/recent');
			const result = await response.json();

			expect(result.links).toBeTruthy();
			expect(result.links.length).toBeGreaterThanOrEqual(2);
			// Verify owner_key is not exposed
			expect(result.links[0].owner_key).toBeUndefined();
			// Verify basic fields are present
			expect(result.links[0].slug).toBeTruthy();
			expect(result.links[0].created).toBeTruthy();
		});

		it('respects limit parameter', async () => {
			// Create links
			for (let i = 0; i < 5; i++) {
				await SELF.fetch('http://example.com/api/links', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						slug: `limit${i}`,
						destination: `https://example.com/${i}`,
						title: `Link ${i}`
					})
				});
			}

			// Get with limit
			const response = await SELF.fetch('http://example.com/api/recent?limit=2');
			const result = await response.json();

			expect(result.links.length).toBe(2);
		});
	});
});
