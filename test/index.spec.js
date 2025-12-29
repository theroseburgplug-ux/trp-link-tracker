import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src';

describe('TRP Link Tracker', () => {
	let testOwnerKey;
	let testSlug;

	beforeEach(async () => {
		// Clear test data
		const list = await env.LINKS.list();
		for (const entry of list.keys) {
			await env.LINKS.delete(entry.name);
		}
	});

	it('responds with homepage', async () => {
		const response = await SELF.fetch('http://example.com');
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain('TRP Link Tracker Running');
	});

	describe('Link Creation', () => {
		it('creates a link with valid URL', async () => {
			const response = await SELF.fetch('http://example.com/api/links', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					destination: 'https://example.com/test',
					title: 'Test Link',
				}),
			});

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.success).toBe(true);
			expect(data.slug).toBeDefined();
			expect(data.owner_key).toBeDefined();
			expect(data.short_url).toContain(data.slug);

			testOwnerKey = data.owner_key;
			testSlug = data.slug;
		});

		it('rejects invalid URL', async () => {
			const response = await SELF.fetch('http://example.com/api/links', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					destination: 'not-a-valid-url',
					title: 'Test Link',
				}),
			});

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data.error).toContain('Invalid destination URL');
		});

		it('rejects missing destination', async () => {
			const response = await SELF.fetch('http://example.com/api/links', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					title: 'Test Link',
				}),
			});

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data.error).toContain('Destination URL is required');
		});
	});

	describe('Owner Index & Fast List', () => {
		it('lists links by owner key using index', async () => {
			// Create first link
			const response1 = await SELF.fetch('http://example.com/api/links', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					destination: 'https://example.com/test1',
					title: 'Test Link 1',
				}),
			});
			const data1 = await response1.json();
			const ownerKey = data1.owner_key;

			// Create second link with same owner (simulate by manually adding to index)
			const response2 = await SELF.fetch('http://example.com/api/links', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					destination: 'https://example.com/test2',
					title: 'Test Link 2',
				}),
			});
			const data2 = await response2.json();

			// List links for first owner
			const listResponse = await SELF.fetch(`http://example.com/api/links?key=${ownerKey}`);
			expect(listResponse.status).toBe(200);
			const listData = await listResponse.json();
			expect(listData.links).toBeDefined();
			expect(listData.links.length).toBe(1);
			expect(listData.links[0].slug).toBe(data1.slug);
		});

		it('returns empty list for unknown owner key', async () => {
			const response = await SELF.fetch('http://example.com/api/links?key=unknown123');
			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.links).toEqual([]);
		});
	});

	describe('URL Validation in Update', () => {
		it('validates URL when updating link', async () => {
			// Create a link first
			const createResponse = await SELF.fetch('http://example.com/api/links', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					destination: 'https://example.com/original',
					title: 'Test Link',
				}),
			});
			const createData = await createResponse.json();

			// Try to update with invalid URL
			const updateResponse = await SELF.fetch(
				`http://example.com/api/update/${createData.slug}?key=${createData.owner_key}`,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						destination: 'ftp://invalid-protocol.com',
					}),
				}
			);

			expect(updateResponse.status).toBe(400);
			const updateData = await updateResponse.json();
			expect(updateData.error).toContain('Invalid destination URL');
		});
	});

	describe('Recent Clicks Endpoint', () => {
		it('returns recent clicks for authorized user', async () => {
			// Create a link
			const createResponse = await SELF.fetch('http://example.com/api/links', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					destination: 'https://example.com/test',
					title: 'Test Link',
				}),
			});
			const createData = await createResponse.json();

			// Try to get recent clicks (should return empty array initially)
			const recentResponse = await SELF.fetch(
				`http://example.com/api/recent-clicks/${createData.slug}?key=${createData.owner_key}`
			);

			expect(recentResponse.status).toBe(200);
			const recentData = await recentResponse.json();
			expect(recentData.slug).toBe(createData.slug);
			expect(recentData.clicks).toBeDefined();
			expect(Array.isArray(recentData.clicks)).toBe(true);
			expect(recentData.total).toBe(0);
		});

		it('rejects unauthorized access to recent clicks', async () => {
			// Create a link
			const createResponse = await SELF.fetch('http://example.com/api/links', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					destination: 'https://example.com/test',
					title: 'Test Link',
				}),
			});
			const createData = await createResponse.json();

			// Try to get recent clicks with wrong key
			const recentResponse = await SELF.fetch(
				`http://example.com/api/recent-clicks/${createData.slug}?key=wrongkey123`
			);

			expect(recentResponse.status).toBe(403);
			const recentData = await recentResponse.json();
			expect(recentData.error).toContain('Unauthorized');
		});
	});

	describe('Delete with Owner Index', () => {
		it('removes link from owner index on delete', async () => {
			// Create a link
			const createResponse = await SELF.fetch('http://example.com/api/links', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					destination: 'https://example.com/test',
					title: 'Test Link',
				}),
			});
			const createData = await createResponse.json();

			// Verify it's in the list
			const listResponse1 = await SELF.fetch(
				`http://example.com/api/links?key=${createData.owner_key}`
			);
			const listData1 = await listResponse1.json();
			expect(listData1.links.length).toBe(1);

			// Delete the link
			const deleteResponse = await SELF.fetch(
				`http://example.com/api/delete/${createData.slug}?key=${createData.owner_key}`,
				{ method: 'DELETE' }
			);
			expect(deleteResponse.status).toBe(200);

			// Verify it's removed from the list
			const listResponse2 = await SELF.fetch(
				`http://example.com/api/links?key=${createData.owner_key}`
			);
			const listData2 = await listResponse2.json();
			expect(listData2.links.length).toBe(0);
		});
	});
});
