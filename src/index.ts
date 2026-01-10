export interface Env {
	DB: D1Database;
}

const GITHUB_REDIRECT = "https://github.com/yi-ge/p.est.im";
const EXPIRATION_TTL = 24 * 60 * 60; // 24 hours in seconds
const MAX_SIZE = 1 * 1024 * 1024; // 1MB size limit

function generateId(length: number = 6): string {
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	let result = "";
	for (let i = 0; i < length; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const cache = caches.default;

		// 1. Root redirect
		if (url.pathname === "/" && request.method === "GET") {
			return Response.redirect(GITHUB_REDIRECT, 302);
		}

		const id = url.pathname.slice(1);

		// 2. GET retrieval
		if (request.method === "GET" && id) {
			// Try cache first
			const cachedResponse = await cache.match(request);
			if (cachedResponse) {
				return cachedResponse;
			}

			const paste = await env.DB.prepare(
				"SELECT content, system_info, counters, expires_at FROM pastes WHERE id = ?"
			).bind(id).first<any>();

			if (!paste) {
				return new Response("Paste not found", { status: 404 });
			}

			const now = Math.floor(Date.now() / 1000);
			if (paste.expires_at < now) {
				// Optionally queue deletion
				ctx.waitUntil(env.DB.prepare("DELETE FROM pastes WHERE id = ?").bind(id).run());
				return new Response("Paste has expired", { status: 410 });
			}

			const systemInfo = JSON.parse(paste.system_info);
			const counters = JSON.parse(paste.counters);

			// Background task: update view count
			ctx.waitUntil((async () => {
				const newCounters = { ...counters, views: (counters.views || 0) + 1 };
				await env.DB.prepare("UPDATE pastes SET counters = ? WHERE id = ?")
					.bind(JSON.stringify(newCounters), id)
					.run();
			})());

			const response = new Response(new Uint8Array(paste.content), {
				headers: {
					"Content-Type": systemInfo.mime || "application/octet-stream",
					"Cache-Control": `public, max-age=${Math.max(0, paste.expires_at - now)}`,
					"X-Paste-Views": (counters.views + 1).toString(),
					"X-Paste-Expires-At": new Date(paste.expires_at * 1000).toISOString(),
				},
			});

			// Cache the response
			ctx.waitUntil(cache.put(request, response.clone()));

			return response;
		}

		// 3. PUT upload
		if (request.method === "PUT") {
			// Check size
			const contentLength = parseInt(request.headers.get("Content-Length") || "0");
			if (contentLength > MAX_SIZE) {
				return new Response("Content too large (max 1MB)", { status: 413 });
			}

			const pasteId = id || generateId();
			const content = await request.arrayBuffer();

			if (content.byteLength > MAX_SIZE) {
				return new Response("Content too large (max 1MB)", { status: 413 });
			}

			const mime = request.headers.get("Content-Type") || "text/plain";
			const deleteToken = crypto.randomUUID();
			const expiresAt = Math.floor(Date.now() / 1000) + EXPIRATION_TTL;

			const uploaderInfo = JSON.stringify({
				ip: request.headers.get("CF-Connecting-IP"),
				ua: request.headers.get("User-Agent"),
			});
			const initialCounters = JSON.stringify({ views: 0 });
			const systemInfo = JSON.stringify({ mime, deleteToken });

			try {
				await env.DB.prepare(
					"INSERT INTO pastes (id, content, uploader_info, counters, system_info, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
				).bind(
					pasteId,
					content,
					uploaderInfo,
					initialCounters,
					systemInfo,
					expiresAt
				).run();
			} catch (e: any) {
				if (e.message.includes("UNIQUE constraint failed")) {
					return new Response("Paste ID already exists, try another path", { status: 409 });
				}
				throw e;
			}

			const baseUrl = new URL(request.url).origin;
			return new Response(`${baseUrl}/${pasteId}\n`, {
				headers: {
					"X-Delete-Token": deleteToken,
					"Content-Type": "text/plain",
				},
			});
		}

		// 4. DELETE (Optional but useful)
		if (request.method === "DELETE" && id) {
			const deleteToken = request.headers.get("X-Delete-Token");
			if (!deleteToken) {
				return new Response("Missing X-Delete-Token header", { status: 401 });
			}

			const paste = await env.DB.prepare("SELECT system_info FROM pastes WHERE id = ?")
				.bind(id)
				.first<any>();

			if (!paste) {
				return new Response("Paste not found", { status: 404 });
			}

			const systemInfo = JSON.parse(paste.system_info);
			if (systemInfo.deleteToken !== deleteToken) {
				return new Response("Invalid delete token", { status: 403 });
			}

			await env.DB.prepare("DELETE FROM pastes WHERE id = ?").bind(id).run();

			// Purge cache if possible (Cache API doesn't support easy purge by key without full URL, but we can try)
			ctx.waitUntil(cache.delete(new Request(url.origin + "/" + id)));

			return new Response("Paste deleted\n");
		}

		return new Response("Method not allowed", { status: 405 });
	},
};
