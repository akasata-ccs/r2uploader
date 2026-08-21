const hasValidHeader = (request, env) => {
	return request.headers.get('X-Custom-Auth-Key') === env.AUTH_KEY_SECRET;
};

function authorizeRequest(request, env) {
	switch (request.method) {
		case 'PUT':
		case 'PATCH':
		case 'DELETE':
			return hasValidHeader(request, env);
		default:
			return false;
	}
}

export default {
	async scheduled(event, env, ctx) {
		if (true) {
			const res = await env.DB.prepare(`
				SELECT i.file_name
				FROM title t
				LEFT JOIN images i
				ON t.group_name = i.group_name
				WHERE t.expire_date < strftime('%s', current_timestamp)
				ORDER BY i.file_name ASC
				LIMIT 100
				`).all();
			const results = res?.results;
			if (!results || results.length === 0) return;

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
				const placeholders = successfullyDeleted.map(() => '?').join(',')
				await env.DB
					.prepare(`
				        DELETE
						FROM
						    images
						WHERE
							file_name IN (${placeholders})
						;
					`)
					.bind(...successfullyDeleted).run();

				await env.DB
					.prepare(`
				        DELETE FROM title
						WHERE NOT EXISTS (
							SELECT 1
							FROM images
							WHERE images.group_name = title.group_name
						);
					`)
					.run();
			}
		}
	},
	async fetch(request, env) {
		const url = new URL(request.url);

		if (request.method === 'GET') {

			if (/^\/api\/[a-z0-9]{8,20}$/.test(url.pathname)) {
				const groupName = url.pathname.split('/').slice(-1)[0];

				const response = await env.DB.prepare(`
					SELECT
						t.group_title,
						t.group_name,
						strftime(
							'%Y年%m月%d日',
							t.expire_date,
							'unixepoch'
						) AS parse_expire_date,
						json_group_array(
							json_object(
								'file_name', i.file_name,
								'orig_name', i.orig_name,
								'length', i.length
							)
						) AS images
					FROM title AS t
					LEFT JOIN images AS i
						ON i.group_name = t.group_name
					WHERE t.group_name = ?
					GROUP BY
						t.group_title,
						t.group_name,
						t.expire_date;
					`)
					.bind(groupName)
					.first();

				const raw = response;
				if(raw) raw.images = JSON.parse(raw?.images);
				return Response.json(raw);
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

			return env.ASSETS.fetch(request);
		}


		if (!authorizeRequest(request, env) || !/^\/upload$/.test(url.pathname)) {
			return new Response('403 Forbidden', { status: 403 });
		}

		switch (request.method) {
			case 'PUT': {
				const now = Date.now();
				const origName = request.headers.get('X-Custom-Orig-Name') ?? 'null';
				const requestGroupName = request.headers.get('X-Custom-Group-Name');
				let groupName = requestGroupName;
				const fileName = String(now);
				if (groupName !== null) {
					const isExist = await env.DB.prepare(`
						SELECT
							count(*) AS count
						FROM
							images
						WHERE
							orig_name = ?
						AND
							group_name = ?
					`)
						.bind(origName, groupName)
						.first();
					if (isExist.count > 0) {
						return Response.json({ status: 'NG', reason: 'Exist', message: `Exist "${origName}" by "${groupName}".`, name: origName, groupName });
					}
				}

				if (groupName === null || groupName === '') {

					groupName = (await env.DB.prepare(`
						INSERT INTO title DEFAULT VALUES RETURNING group_name
						`).first()).group_name;
				}

				await env.MY_BUCKET.put(fileName, request.body);
				const object = await env.MY_BUCKET.head(fileName);
				const length = object.size; // ファイルサイズ (バイト単位)

				const result = await env.DB.prepare(`
						INSERT INTO images (
							file_name,
							orig_name,
							group_name,
							length
						)
						VALUES (
							?,
							?,
							?,
							?
						)
						RETURNING
							file_name,
							orig_name,
							group_name,
							length
					`)
					.bind(fileName, origName, groupName, length)
					.first();

				return Response.json({ status: 'OK', message: `Put successfully!`, origName: result.orig_name, groupName: result.group_name, length: result.length });
			}
			case 'PATCH': {
				const groupTitle = request.headers.get('X-Custom-Group-Title');
				const groupName = request.headers.get('X-Custom-Group-Name');
				if (!groupTitle || !groupName) return Response.json({ status: 'NG', message: `Either or both of 'title' and 'name' are invalid.` });

				const result = await env.DB.prepare(`
					UPDATE title SET
						group_title = ?
					WHERE group_name = ?;
					`)
					.bind(groupTitle, groupName)
					.run();

				return Response.json({ status: 'OK', message: `Patch successfully!` });
			}
			case 'DELETE': {
				const origName = request.headers.get('X-Custom-Orig-Name') || null;
				const groupName = request.headers.get('X-Custom-Group-Name');
				if (groupName) {
					return new Response('Required header is missing.', {
						status: 405,
					});
				}
				const results = await env.DB.prepare(`
					DELETE
					FROM
						images
					WHERE
						group_name = ?
					AND
						(? IS NULL OR orig_name = ?)
					RETURNING
						file_name,
						orig_name,
						group_name
					`)
					.bind(
						groupName,
						origName,
						origName
					)
					.all();

				results.forEach(async (entries) => {
					await env.MY_BUCKET.delete(entries.file_name);
				});

				return Response.json({
					status: 'OK',
					message: `Delete successfully!`,
					entries: results.map(row => {
						return { origName: row.orig_name, groupName: row.group_name }
					})
				});
				return new Response('Deleted!');
			}
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
