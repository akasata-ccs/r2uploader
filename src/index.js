const hasValidHeader = (request, env) => {
	return request.headers.get('X-Custom-Auth-Key') === env.AUTH_KEY_SECRET;
};

const GROUP_PREFIX = (groupName) => `groups/${groupName}/`;
const GROUP_METADATA_KEY = (groupName) => `${GROUP_PREFIX(groupName)}~group.json`;
const MAX_GROUP_IMAGES = 1000;
const DEFAULT_EXPIRY_DAYS = 60;

function isExpired(object, now = Date.now()) {
	return now - object.uploaded.getTime() >= DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
}

async function listGroupObjects(bucket, groupName) {
	return bucket.list({ prefix: GROUP_PREFIX(groupName), limit: 1000, include: ['customMetadata'] });
}

async function readGroupMetadata(bucket, groupName) {
	const object = await bucket.get(GROUP_METADATA_KEY(groupName));
	if (!object) return null;
	try {
		return await object.json();
	} catch {
		return null;
	}
}

async function writeGroupMetadata(bucket, groupName, metadata) {
	await bucket.put(GROUP_METADATA_KEY(groupName), JSON.stringify(metadata), {
		httpMetadata: { contentType: 'application/json; charset=utf-8' },
	});
}

export default {
	async scheduled(event, env, ctx) {
		let cursor;
		do {
			const page = await env.MY_BUCKET.list({ limit: 1000, cursor });
			for (const object of page.objects) {
				if (!object.key.startsWith('groups/') || object.key.endsWith('/~group.json') || !isExpired(object)) continue;
				try {
					await env.MY_BUCKET.delete(object.key);
					console.log(`Deleted expired object: ${object.key}`);
				} catch (error) {
					console.error(`Failed to delete expired object: ${object.key}`, error);
				}
			}
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
	},
	async fetch(request, env) {
		const url = new URL(request.url);
		const uploadPath = url.pathname === '/upload';
		const apiPath = /^\/api\/[a-z0-9]{8,20}$/.test(url.pathname);
		const imagePath = /^\/(image|thumb)\/([a-z0-9]{8,20}\/([0-9a-f-]{36})|[0-9]{13})(\/|$)/.test(url.pathname);

		if (uploadPath && !['PUT', 'PATCH', 'DELETE'].includes(request.method)) {
			return new Response('405 Method Not Allowed', {
				status: 405,
				headers: { Allow: 'PUT, PATCH, DELETE' },
			});
		}
		if ((apiPath || imagePath) && request.method !== 'GET') {
			return new Response('405 Method Not Allowed', {
				status: 405,
				headers: { Allow: 'GET' },
			});
		}

		if (request.method === 'GET') {

			if (/^\/api\/[a-z0-9]{8,20}$/.test(url.pathname)) {
				const groupName = url.pathname.split('/').slice(-1)[0];
				const [page, group] = await Promise.all([
					listGroupObjects(env.MY_BUCKET, groupName),
					readGroupMetadata(env.MY_BUCKET, groupName),
				]);
				if (!group && page.objects.length === 0) return Response.json(null, { status: 404 });

				const now = Date.now();
				const images = [];
				const expiredKeys = [];
				for (const object of page.objects) {
					if (object.key === GROUP_METADATA_KEY(groupName)) continue;
					if (isExpired(object, now)) {
						expiredKeys.push(object.key);
						continue;
					}
					images.push({
						file_name: `${groupName}/${object.key.slice(GROUP_PREFIX(groupName).length)}`,
						orig_name: object.customMetadata?.origName ?? null,
						length: object.size,
						_uploadedAt: object.uploaded.getTime(),
						_key: object.key,
					});
				}
				if (expiredKeys.length) await env.MY_BUCKET.delete(expiredKeys);
				images.sort((a, b) => a._uploadedAt - b._uploadedAt || a._key.localeCompare(b._key));
				return Response.json({
					group_title: group?.groupTitle ?? 'archive',
					group_name: groupName,
					images: images.slice(0, MAX_GROUP_IMAGES).map(({ _uploadedAt, _key, ...image }) => image),
					truncated: page.truncated || images.length > MAX_GROUP_IMAGES,
				});
			}

			const prefixedImageMatch = url.pathname.match(/^\/(image|thumb)\/([a-z0-9]{8,20})\/([0-9a-f-]{36})$/);
			const legacyImageMatch = url.pathname.match(/^\/(image|thumb)\/([0-9]{13})($|\/)/);
			if (prefixedImageMatch?.[1] === 'image' || legacyImageMatch?.[1] === 'image') {
				const imageKey = prefixedImageMatch
					? `${GROUP_PREFIX(prefixedImageMatch[2])}${prefixedImageMatch[3]}`
					: legacyImageMatch[2];
				const object = await env.MY_BUCKET.get(imageKey);
				if (object === null) {
					return new Response('Object Not Found: ' + imageKey, { status: 404 });
				}

				const headers = new Headers();
				object.writeHttpMetadata(headers);
				headers.set('etag', object.httpEtag);

				return new Response(object.body, {
					headers,
				});
			}
			if (prefixedImageMatch?.[1] === 'thumb' || legacyImageMatch?.[1] === 'thumb') {
				const imagePath = prefixedImageMatch
					? `/image/${prefixedImageMatch[2]}/${prefixedImageMatch[3]}`
					: `/image/${legacyImageMatch[2]}`;
				const imageResponse = await fetch(url.origin + imagePath, {
					cf: {
						image: {
							fit: "scale-down",
							width: 600,
							height: 600,
							quality: 90,
							metadata: "none",
							format: "webp"
						}
					}
				})

				// 画像が存在しない場合、エラーレスポンスを返す
				if (!imageResponse.ok) {
					return new Response(imageResponse.body, {
						status: imageResponse.status,
						statusText: imageResponse.statusText,
						headers: imageResponse.headers,
					});
				}

				// 画像をレスポンスとして返す
				return new Response(imageResponse.body, {
					headers: { 'Content-Type': imageResponse.headers.get('Content-Type') }
				});
			}

			return env.ASSETS.fetch(request);
		}


		if (!uploadPath || !hasValidHeader(request, env)) {
			return new Response('403 Forbidden', { status: 403 });
		}

		switch (request.method) {
			case 'PUT': {
				const origName = request.headers.get('X-Custom-Orig-Name');
				if (!origName || !origName.trim()) {
					return Response.json({ status: 'NG', message: "Header 'X-Custom-Orig-Name' is required." }, { status: 400 });
				}
				const requestGroupName = request.headers.get('X-Custom-Group-Name');
				const groupName = requestGroupName || crypto.randomUUID().replaceAll('-', '').slice(0, 16);
				if (!/^[a-z0-9]{8,20}$/.test(groupName)) {
					return Response.json({ status: 'NG', message: 'Invalid group name.' }, { status: 400 });
				}
				const fileName = crypto.randomUUID();
				const key = `${GROUP_PREFIX(groupName)}${fileName}`;
				const existingGroup = await readGroupMetadata(env.MY_BUCKET, groupName);
				if (!existingGroup) await writeGroupMetadata(env.MY_BUCKET, groupName, { groupTitle: 'archive' });
				const object = await env.MY_BUCKET.put(key, request.body, {
					customMetadata: { origName },
				});
				return Response.json({ status: 'OK', message: 'Put successfully!', fileName: `${groupName}/${fileName}`, origName, groupName, length: object.size });
			}
			case 'PATCH': {
				let payload;
				try {
					payload = await request.json();
				} catch {
					return Response.json({ status: 'NG', message: 'Request body must be valid JSON.' }, { status: 400 });
				}
				const { groupTitle, groupName } = payload ?? {};
				if (typeof groupTitle !== 'string' || !groupTitle.trim() || typeof groupName !== 'string' || !/^[a-z0-9]{8,20}$/.test(groupName)) {
					return Response.json({ status: 'NG', message: 'A valid groupName and non-empty groupTitle are required.' }, { status: 400 });
				}

				const group = await readGroupMetadata(env.MY_BUCKET, groupName);
				if (!group) return Response.json({ status: 'NG', message: 'Group not found.' }, { status: 404 });
				await writeGroupMetadata(env.MY_BUCKET, groupName, { ...group, groupTitle });
				return Response.json({ status: 'OK', message: `Patch successfully!` });
			}
			case 'DELETE': {
				const origName = request.headers.get('X-Custom-Orig-Name') || null;
				const groupName = request.headers.get('X-Custom-Group-Name');
				if (!groupName) {
					return new Response('Required header is missing.', {
						status: 400,
					});
				}
				if (!/^[a-z0-9]{8,20}$/.test(groupName)) {
					return Response.json({ status: 'NG', message: 'Invalid group name.' }, { status: 400 });
				}
				const targets = [];
				let cursor;
				do {
					const page = await env.MY_BUCKET.list({
						prefix: GROUP_PREFIX(groupName),
						limit: 1000,
						include: ['customMetadata'],
						cursor,
					});
					const pageTargets = page.objects.filter(object => object.key !== GROUP_METADATA_KEY(groupName)
						&& (origName === null || object.customMetadata?.origName === origName));
					targets.push(...pageTargets);
					if (pageTargets.length) await env.MY_BUCKET.delete(pageTargets.map(object => object.key));
					cursor = page.truncated ? page.cursor : undefined;
				} while (cursor);
				if (origName === null) await env.MY_BUCKET.delete(GROUP_METADATA_KEY(groupName));

				return Response.json({
					status: 'OK',
					message: `Delete successfully!`,
					entries: targets.map(object => ({ origName: object.customMetadata?.origName ?? null, groupName })),
				});
			}
			default:
				return new Response('Method Not Allowed', {
					status: 405,
					headers: {
						Allow: 'PUT, PATCH, DELETE',
					},
				});
		}
	},
};
