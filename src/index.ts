export interface Env {
	DB: D1Database;
	GITHUB_REDIRECT?: string;
	EXPIRATION_TTL?: string;
	MAX_SIZE?: string;
}

const DEFAULT_GITHUB_REDIRECT = "https://github.com/est/p.est.im";
const DEFAULT_EXPIRATION_TTL = 24 * 60 * 60; // 24 hours in seconds
const DEFAULT_MAX_SIZE = 1 * 1024 * 1024; // 1MB size limit

interface ContentInfo {
	mime: string;
	extension: string;
	width?: number;
	height?: number;
}

// @ts-ignore
if (typeof Uint8Array.prototype.toHex !== "function") {
	// @ts-ignore
	Uint8Array.prototype.toHex = function () {
		return Array.from(this).map(b => b.toString(16).padStart(2, "0")).join("");
	};
}

function analyzeContent(buffer: ArrayBuffer): ContentInfo {
	const bytes = new Uint8Array(buffer);
	const headerText = new TextDecoder().decode(bytes.slice(0, 16));
	// @ts-ignore
	const headerHex = bytes.slice(0, 16).toHex();

	// PNG: 89504e47
	if (headerHex.startsWith("89504e47")) {
		const view = new DataView(buffer);
		return {
			mime: "image/png",
			extension: ".png",
			width: view.getUint32(16, false),
			height: view.getUint32(20, false),
		};
	}

	// GIF: GIF8
	if (headerText.startsWith("GIF8")) {
		const view = new DataView(buffer);
		return {
			mime: "image/gif",
			extension: ".gif",
			width: view.getUint16(6, true),
			height: view.getUint16(8, true),
		};
	}

	// JPEG: ffd8ff
	if (headerHex.startsWith("ffd8ff")) {
		let offset = 2;
		const view = new DataView(buffer);
		while (offset < bytes.length) {
			const marker = view.getUint16(offset, false);
			offset += 2;
			// SOF0 - SOF15
			if ((marker >= 0xFFC0 && marker <= 0xFFCF) && marker !== 0xFFC4 && marker !== 0xFFC8 && marker !== 0xFFCC) {
				offset += 1;
				const height = view.getUint16(offset, false);
				const width = view.getUint16(offset + 2, false);
				return { mime: "image/jpeg", extension: ".jpg", width, height };
			}
			offset += view.getUint16(offset, false);
		}
		return { mime: "image/jpeg", extension: ".jpg" };
	}

	// WEBP: RIFF .... WEBP
	if (headerText.startsWith("RIFF") && headerText.slice(8, 12) === "WEBP") {
		const view = new DataView(buffer);
		const type = headerText.slice(12, 16);
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

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function SecureResponse(body: BodyInit | null, init?: ResponseInit & { isHtml?: boolean }): Response {
	const { isHtml, ...rest } = init || {};
	const res = new Response(body, rest);
	const headers = new Headers(res.headers);
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("X-Frame-Options", "DENY");
	headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

	if (isHtml) {
		headers.set("Content-Security-Policy", "default-src 'none'; script-src https://cdnjs.cloudflare.com; style-src 'unsafe-inline' https://cdnjs.cloudflare.com; img-src *; font-src https://cdnjs.cloudflare.com;");
	} else {
		headers.set("Content-Security-Policy", "default-src 'none'; script-src 'none'; style-src 'none'; img-src 'self';");
	}

	return new Response(res.body, { ...rest, status: res.status, statusText: res.statusText, headers });
}

const MD_HTML_TEMPLATE = (title: string, content: string) => `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.2.0/github-markdown.min.css">
    <style>
        .markdown-body { box-sizing: border-box; min-width: 200px; max-width: 980px; margin: 0 auto; padding: 45px; }
        @media (max-width: 767px) { .markdown-body { padding: 15px; } }
    </style>
</head>
<body class="markdown-body">
    <div id="content" style="display:none">${escapeHtml(content)}</div>
    <div id="view"></div>
    <div id="meta" style="margin-top: 2rem; border-top: 1px solid #eee; padding-top: 1rem; color: #666; font-size: 0.8rem;">
        Views: <span id="view-count">__VIEWS__</span>
    </div>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/4.3.0/marked.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.6/purify.min.js"></script>
    <script>
        const content = document.getElementById('content').textContent;
        const html = marked.parse(content);
        document.getElementById('view').innerHTML = DOMPurify.sanitize(html);
    </script>
</body>
</html>`;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const GITHUB_REDIRECT = env.GITHUB_REDIRECT || DEFAULT_GITHUB_REDIRECT;
		const EXPIRATION_TTL = parseInt(env.EXPIRATION_TTL || DEFAULT_EXPIRATION_TTL.toString());
		const MAX_SIZE = parseInt(env.MAX_SIZE || DEFAULT_MAX_SIZE.toString());

		const url = new URL(request.url);

		// Force HTTPS upgrade, especially for uploads
		if (url.protocol === "http:" && url.hostname !== "localhost") {
			url.protocol = "https:";
			return new Response(null, {
				status: 308,
				headers: { Location: url.toString() },
			});
		}

		const cache = caches.default;

		if (url.pathname === "/" && request.method === "GET") {
			console.log("Redirecting to", GITHUB_REDIRECT);
			return SecureResponse(null, { status: 302, headers: { Location: GITHUB_REDIRECT } });
		}

		const id = url.pathname.slice(1);

		if (url.pathname === "/favicon.ico") {
			const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🅿️</text></svg>`;
			return new Response(svg, {
				headers: { "Content-Type": "image/svg+xml" },
			});
		}

		if (request.method === "GET" && id) {
			// Hot-linking protection: allow direct access (no Sec-Fetch headers) or same-site.
			// Otherwise enforce Sec-Fetch-Dest: document.
			const fetchSite = request.headers.get("Sec-Fetch-Site");
			const fetchDest = request.headers.get("Sec-Fetch-Dest");
			if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site") {
				if (fetchDest && fetchDest !== "document") {
					// Forbidden: Hot-linking detected
					return SecureResponse("", { status: 403 });
				}
			}

			const cachedResponse = await cache.match(request);
			if (cachedResponse) {
				return cachedResponse;
			}

			const paste = await env.DB.prepare(
				"SELECT content, system_info, counters, etime FROM pastes WHERE id = ?"
			).bind(id).first<any>();

			if (!paste) {
				return new Response(null, { status: 404 });
			}

			const now = Math.floor(Date.now() / 1000);
			if (paste.etime < now) {
				ctx.waitUntil(env.DB.prepare("DELETE FROM pastes WHERE id = ?").bind(id).run());
				return new Response(null, { status: 410 });
			}

			const newExpiresAt = now + EXPIRATION_TTL;
			const systemInfo = JSON.parse(paste.system_info);
			const counters = JSON.parse(paste.counters);
			const newViews = (counters.views || 0) + 1;

			ctx.waitUntil((async () => {
				const newCounters = { ...counters, views: newViews };
				await env.DB.prepare("UPDATE pastes SET counters = ?, atime = ?, etime = ? WHERE id = ?")
					.bind(JSON.stringify(newCounters), now, newExpiresAt, id)
					.run();
			})());

			const accept = request.headers.get("Accept") || "";
			if (id.endsWith(".md") && accept.includes("text/html")) {
				const rawText = new TextDecoder().decode(new Uint8Array(paste.content));
				let html = MD_HTML_TEMPLATE(id, rawText);
				// Inject real view count into template
				html = html.replace("__VIEWS__", newViews.toString());
				return SecureResponse(html, {
					headers: { "Content-Type": "text/html;charset=UTF-8" },
					isHtml: true,
				});
			}

			const responseHeaders: any = {
				"Content-Type": systemInfo.mime || "text/plain",
				"Cache-Control": `public, max-age=${Math.max(0, newExpiresAt - now)}`,
				"X-Paste-Views": newViews.toString(),
				"X-Paste-Expires-At": new Date(newExpiresAt * 1000).toISOString(),
			};

			if (systemInfo.width && systemInfo.height) {
				responseHeaders["X-Image-Dimensions"] = `${systemInfo.width}x${systemInfo.height}`;
			}

			const response = SecureResponse(new Uint8Array(paste.content), {
				headers: responseHeaders,
			});

			ctx.waitUntil(cache.put(request, response.clone()));

			console.log("Returning response for", id);
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

			const now = Math.floor(Date.now() / 1000);
			// Proactive cleanup of expired pastes
			ctx.waitUntil(env.DB.prepare("DELETE FROM pastes WHERE etime < ?").bind(now).run());

			const info = analyzeContent(content);
			const originalPath = id; // The path provided by the user
			let extension = info.extension;
			if (!extension && originalPath.includes(".")) {
				const ext = "." + originalPath.split(".").pop();
				if ([".md", ".txt", ".json", ".html", ".js", ".css"].includes(ext.toLowerCase())) {
					extension = ext.toLowerCase();
				}
			}

			const mime = info.mime;
			const deleteToken = crypto.randomUUID();
			const expiresAt = now + EXPIRATION_TTL;

			const uploaderInfo = JSON.stringify({
				ip: request.headers.get("CF-Connecting-IP"),
				ua: request.headers.get("User-Agent"),
				rtt: request.cf?.clientTcpRtt,
				asOrg: request.cf?.asOrganization,
				asn: request.cf?.asn,
				country: request.cf?.country,
				region: request.cf?.region,
				regionCode: request.cf?.regionCode,
				city: request.cf?.city,
			});
			const initialCounters = JSON.stringify({ views: 0 });
			const systemInfo = JSON.stringify({
				mime,
				deleteToken,
				original_path: originalPath,
				width: info.width,
				height: info.height
			});

			let pasteId = generateId() + extension;
			try {
				await env.DB.prepare(
					"INSERT INTO pastes (id, content, uploader_info, counters, system_info, etime) VALUES (?, ?, ?, ?, ?, ?)"
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
					const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
					pasteId = `${timestamp}-${pasteId}`;
					try {
						await env.DB.prepare(
							"INSERT INTO pastes (id, content, uploader_info, counters, system_info, etime) VALUES (?, ?, ?, ?, ?, ?)"
						).bind(
							pasteId,
							content,
							uploaderInfo,
							initialCounters,
							systemInfo,
							expiresAt
						).run();
					} catch (e2: any) {
						return new Response("Conflict persists after timestamp prefixing", { status: 500 });
					}
				} else {
					throw e;
				}
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

			return SecureResponse("Deleted\n");
		}

		return SecureResponse("Method not allowed", { status: 405 });
	},
};
