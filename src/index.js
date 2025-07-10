const hasValidHeader = (request, env) => {
	return request.headers.get('X-Custom-Auth-Key') === env.AUTH_KEY_SECRET;
};

function authorizeRequest(request, env, key) {
	switch (request.method) {
		case 'PUT':
		case 'DELETE':
			return hasValidHeader(request, env);
		case 'GET':
		default:
			return false;
	}
}

export default {
	async scheduled(event, env, ctx) {
		if (true) {
			const { results } = await env.DB.prepare(`SELECT file_name FROM images WHERE expire_date < strftime('%s', current_timestamp)`).all();
			const successfullyDeleted = [];

			for (const row of results) {
				try {
					await env.MY_BUCKET.delete(row.file_name);
					successfullyDeleted.push(row.file_name);
					console.log(`Successfull to delete file: ${row.file_name}`);
				} catch (e) {
					console.error(`Failed to delete file: ${row.file_name}`, e);
				}
			}

			if (successfullyDeleted.length > 0) {
				const chunked = chunkArray(successfullyDeleted, 20)
				for (const chunk of chunked) {
					const placeholders = chunk.map(() => '?').join(',')
					await env.DB
						.prepare(`
						DELETE FROM images
						WHERE file_name IN (${placeholders})
					`)
						.bind(...chunk).run()
				}
			}
		}
	},
	async fetch(request, env) {
		const url = new URL(request.url);
		const key = url.pathname.slice(1);

		if (request.method === 'GET') {

			if (/^\/robots.txt$/.test(url.pathname)) {
				return new Response(`User-agent: Twitterbot
Disallow:

User-agent: Discordbot
Disallow: 

User-agent: *
Disallow: /
`, {
					headers: {
						'Content-Type': 'text/plain'
					}
				});
			}
			if (/^\/assets\/|^\/favicon.ico$/.test(url.pathname)) {
				const assetsPath = /^\/favicon.ico$/.test(url.pathname) ?
					`assets${url.pathname}` :
					url.pathname.slice(1);
				const object = await env.MY_BUCKET.get(assetsPath);
				if (object === null) {
					return new Response('Object Not Found');
				}
				if (url.pathname.endsWith('.mjs')) {
					return new Response(object.body, { headers: { 'Content-Type': 'application/javascript' } });
				}
				const headers = new Headers();
				object.writeHttpMetadata(headers);
				headers.set('etag', object.httpEtag);
				return new Response(object.body, {
					headers,
				});

			}

			if (/^\/$|^\/[a-z0-9]{8,10}($|\/)/.test(url.pathname)) {
				const object = await env.MY_BUCKET.get('assets/index.html');
				if (object === null) {
					return new Response('Object Not Found');
				}
				return new Response(object.body, {
					headers: {
						'Content-Type': 'text/html; charset=UTF-8', // HTMLを返す
						'Cache-Control': 'no-store'
					}
				});
			}
			if (/^\/api\/[a-z0-9]{8,10}$/.test(url.pathname)) {
				const groupName = url.pathname.split('/').slice(-1)[0];
				const results = await env.DB.prepare(`SELECT *, strftime('%Y年%m月%d日', expire_date, 'unixepoch') as parse_expire_date FROM images WHERE group_name = ? AND expire_date > strftime('%s', current_timestamp)`)
					.bind(groupName)
					.all();

				return Response.json(results.results);
			}

			if (/^\/image\/[0-9]{13}($|\/)/.test(url.pathname)) {
				const imageNumber = url.pathname.match(/^\/image\/([0-9]{13})($|\/)/)[1];
				const object = await env.MY_BUCKET.get(imageNumber);
				if (object === null) {
					return new Response('Object Not Found: ' + imageNumber, { status: 404 });
				}

				const headers = new Headers();
				object.writeHttpMetadata(headers);
				headers.set('etag', object.httpEtag);

				return new Response(object.body, {
					headers,
				});
			}
			if (/^\/thumb\/[0-9]{13}($|\/)/.test(url.pathname)) {
				const imageResponse = await fetch(url.origin + url.pathname.replace('/thumb/', '/image/'), {
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
					return new Response('画像の取得に失敗しました。', { status: 500 });
				}

				// 画像をレスポンスとして返す
				return new Response(imageResponse.body, {
					headers: { 'Content-Type': imageResponse.headers.get('Content-Type') }
				});
			}
		}

		if (!authorizeRequest(request, env, key) || !/^\/upload$/.test(url.pathname)) {
			return new Response('Forbidden', { status: 403 });
		}

		switch (request.method) {
			case 'PUT':
				const origName = request.headers.get('X-Custom-Orig-Name') ?? 'null';
				const requestGroupName = request.headers.get('X-Custom-Group-Name');
				const groupName = requestGroupName && requestGroupName !== '' ? requestGroupName : ((new Date()).getTime() * 2 ** 10).toString(36);
				const fileName = String((new Date()).getTime());
				const isExist = await env.DB.prepare(`SELECT count(*) AS count FROM images WHERE orig_name = ? AND group_name = ?`)
					.bind(origName, groupName)
					.all();
				if (isExist.results[0].count > 0) {
					return Response.json({ status: 'NG', reason: 'Exist', message: `Exist "${origName}" by "${groupName}".`, name: origName, groupName: groupName });
				}

				await env.MY_BUCKET.put(fileName, request.body);
				const object = await env.MY_BUCKET.head(fileName);
				const length = object.size; // ファイルサイズ (バイト単位)

				await env.DB.prepare(`INSERT INTO images (file_name, orig_name, group_name, expire_date, length)
					VALUES (?, ?, ?, strftime('%s', date('now', '+14 days'), '23:59:59'), ?)`)
					.bind(fileName, origName, groupName, length)
					.all();

				return Response.json({ status: 'OK', message: `Put ${key} successfully!`, name: origName, groupName: groupName, length: length });
			case 'DELETE':
				await env.MY_BUCKET.delete(key);
				await env.DB.prepare(`DELETE FROM images WHERE file_name = ?`)
					.bind(key)
					.all();
				return new Response('Deleted!');

			default:
				return new Response('Method Not Allowed', {
					status: 405,
					headers: {
						Allow: 'PUT, GET, DELETE',
					},
				});
		}
	},
};
