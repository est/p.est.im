export interface Env {
	DB: D1Database;
	GITHUB_REDIRECT?: string;
	EXPIRATION_TTL?: string;
	MAX_SIZE?: string;
}

const DEFAULT_GITHUB_REDIRECT = "https://github.com/yi-ge/p.est.im";
const DEFAULT_EXPIRATION_TTL = 24 * 60 * 60; // 24 hours in seconds
const DEFAULT_MAX_SIZE = 1 * 1024 * 1024; // 1MB size limit

interface ContentInfo {
	mime: string;
	extension: string;
	width?: number;
	height?: number;
}

function analyzeContent(buffer: ArrayBuffer): ContentInfo {
	const bytes = new Uint8Array(buffer);

	// PNG: 89 50 4E 47 0D 0A 1A 0A
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
		const view = new DataView(buffer);
		return {
			mime: "image/png",
			extension: ".png",
			width: view.getUint32(16, false),
			height: view.getUint32(20, false),
		};
	}

	// GIF: GIF87a (47 49 46 38 37 61) or GIF89a (47 49 46 38 39 61)
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
		const view = new DataView(buffer);
		return {
			mime: "image/gif",
			extension: ".gif",
			width: view.getUint16(6, true),
			height: view.getUint16(8, true),
		};
	}

	// JPEG: FF D8 FF
	if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
		let offset = 2;
		const view = new DataView(buffer);
		while (offset < bytes.length) {
			const marker = view.getUint16(offset, false);
			offset += 2;
			// SOF0 - SOF15 (FF C0 - FF CF, except FF C4, FF C8, FF CC)
			if ((marker >= 0xFFC0 && marker <= 0xFFCF) && marker !== 0xFFC4 && marker !== 0xFFC8 && marker !== 0xFFCC) {
				offset += 1; // skip precision
				const height = view.getUint16(offset, false);
				const width = view.getUint16(offset + 2, false);
				return { mime: "image/jpeg", extension: ".jpg", width, height };
			}
			offset += view.getUint16(offset, false);
		}
		return { mime: "image/jpeg", extension: ".jpg" };
	}

	// WEBP: RIFF .... WEBP
	if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
		bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
		const view = new DataView(buffer);
		const type = String.fromCharCode(...bytes.slice(12, 16));
		if (type === "VP8 ") {
			const tmp = view.getUint32(26, true);
			return { mime: "image/webp", extension: ".webp", width: tmp & 0x3FFF, height: (tmp >> 16) & 0x3FFF };
		} else if (type === "VP8L") {
			const tmp = view.getUint32(21, true);
			return { mime: "image/webp", extension: ".webp", width: 1 + (tmp & 0x3FFF), height: 1 + ((tmp >> 14) & 0x3FFF) };
		} else if (type === "VP8X") {
			const width = 1 + (view.getUint16(24, true) | (view.getUint8(26) << 16));
			const height = 1 + (view.getUint16(27, true) | (view.getUint8(29) << 16));
			return { mime: "image/webp", extension: ".webp", width, height };
		}
		return { mime: "image/webp", extension: ".webp" };
	}

	return { mime: "text/plain", extension: "" };
}

function generateId(length: number = 6): string {
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	let result = "";
	for (let i = 0; i < length; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
}

const MD_HTML_TEMPLATE = (title: string, content: string) => `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.2.0/github-markdown.min.css">
    <style>
        .markdown-body { box-sizing: border-box; min-width: 200px; max-width: 980px; margin: 0 auto; padding: 45px; }
        @media (max-width: 767px) { .markdown-body { padding: 15px; } }
    </style>
</head>
<body class="markdown-body">
    <div id="content" style="display:none">${content}</div>
    <div id="view"></div>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/4.3.0/marked.min.js"></script>
    <script>
        document.getElementById('view').innerHTML = marked.parse(document.getElementById('content').textContent);
    </script>
</body>
</html>`;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const GITHUB_REDIRECT = env.GITHUB_REDIRECT || DEFAULT_GITHUB_REDIRECT;
		const EXPIRATION_TTL = parseInt(env.EXPIRATION_TTL || DEFAULT_EXPIRATION_TTL.toString());
		const MAX_SIZE = parseInt(env.MAX_SIZE || DEFAULT_MAX_SIZE.toString());

		const url = new URL(request.url);
		const cache = caches.default;

		if (url.pathname === "/" && request.method === "GET") {
			return Response.redirect(GITHUB_REDIRECT, 302);
		}

		const id = url.pathname.slice(1);

		if (request.method === "GET" && id) {
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
				ctx.waitUntil(env.DB.prepare("DELETE FROM pastes WHERE id = ?").bind(id).run());
				return new Response("Paste has expired", { status: 410 });
			}

			const systemInfo = JSON.parse(paste.system_info);
			const counters = JSON.parse(paste.counters);

			ctx.waitUntil((async () => {
				const newCounters = { ...counters, views: (counters.views || 0) + 1 };
				await env.DB.prepare("UPDATE pastes SET counters = ? WHERE id = ?")
					.bind(JSON.stringify(newCounters), id)
					.run();
			})());

			const accept = request.headers.get("Accept") || "";
			if (id.endsWith(".md") && accept.includes("text/html")) {
				const rawText = new TextDecoder().decode(new Uint8Array(paste.content));
				return new Response(MD_HTML_TEMPLATE(id, rawText), {
					headers: { "Content-Type": "text/html;charset=UTF-8" }
				});
			}

			const responseHeaders: any = {
				"Content-Type": systemInfo.mime || "text/plain",
				"Cache-Control": `public, max-age=${Math.max(0, paste.expires_at - now)}`,
				"X-Paste-Views": (counters.views + 1).toString(),
				"X-Paste-Expires-At": new Date(paste.expires_at * 1000).toISOString(),
			};

			if (systemInfo.dimensions) {
				responseHeaders["X-Image-Dimensions"] = `${systemInfo.dimensions.width}x${systemInfo.dimensions.height}`;
			}

			const response = new Response(new Uint8Array(paste.content), {
				headers: responseHeaders,
			});

			ctx.waitUntil(cache.put(request, response.clone()));

			return response;
		}

		if (request.method === "PUT") {
			const contentLength = parseInt(request.headers.get("Content-Length") || "0");
			if (contentLength > MAX_SIZE) {
				return new Response("Content too large", { status: 413 });
			}

			const content = await request.arrayBuffer();
			if (content.byteLength > MAX_SIZE) {
				return new Response("Content too large", { status: 413 });
			}

			const info = analyzeContent(content);
			const pasteId = id || (generateId() + info.extension);
			const mime = info.mime;
			const deleteToken = crypto.randomUUID();
			const expiresAt = Math.floor(Date.now() / 1000) + EXPIRATION_TTL;

			const uploaderInfo = JSON.stringify({
				ip: request.headers.get("CF-Connecting-IP"),
				ua: request.headers.get("User-Agent"),
			});
			const initialCounters = JSON.stringify({ views: 0 });
			const systemInfo = JSON.stringify({
				mime,
				deleteToken,
				dimensions: info.width ? { width: info.width, height: info.height } : undefined
			});

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
					return new Response("Paste ID already exists", { status: 409 });
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

		if (request.method === "DELETE" && id) {
			const deleteToken = request.headers.get("X-Delete-Token");
			if (!deleteToken) return new Response("Missing token", { status: 401 });

			const paste = await env.DB.prepare("SELECT system_info FROM pastes WHERE id = ?")
				.bind(id).first<any>();

			if (!paste) return new Response("Not found", { status: 404 });

			const systemInfo = JSON.parse(paste.system_info);
			if (systemInfo.deleteToken !== deleteToken) return new Response("Forbidden", { status: 403 });

			await env.DB.prepare("DELETE FROM pastes WHERE id = ?").bind(id).run();
			ctx.waitUntil(cache.delete(new Request(url.origin + "/" + id)));

			return new Response("Deleted\n");
		}

		return new Response("Method not allowed", { status: 405 });
	},
};
