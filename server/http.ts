import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { Effect, Layer } from "effect";

const webRoot = join(import.meta.dirname, "../web/dist");

const contentTypes: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".map": "application/json",
};

const publicEndpoint = () =>
	(process.env.PUBLIC_RIVET_ENDPOINT ?? "http://localhost:6420").replace(/\/$/, "");
const publicNamespace = () => process.env.PUBLIC_RIVET_NAMESPACE ?? "default";

/**
 * The browser reads the client config at runtime, so one image works on any
 * cluster. It has no token. The browser gets one from `/token`.
 */
const clientConfig = () => ({
	endpoint: publicEndpoint(),
	namespace: publicNamespace(),
});

const TOKEN_DURATION_SECONDS = 900;
const TOKEN_RENEW_BEFORE_EXPIRY_MS = 60_000;
/** A forced refresh cannot make the server issue more often than this. */
const TOKEN_MIN_AGE_FOR_REFRESH_MS = 5_000;

type IssuedToken = {
	readonly token: string;
	readonly issuedAt: number;
	readonly expiresAt: number;
};

let cachedToken: IssuedToken | undefined;
let pendingToken: Promise<IssuedToken> | undefined;

/** Issues a scoped JWT for browsers with the admin token, which stays here. */
const issueToken = async (adminToken: string): Promise<IssuedToken> => {
	const response = await fetch(`${publicEndpoint()}/auth/tokens`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${adminToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			namespace: publicNamespace(),
			duration: TOKEN_DURATION_SECONDS,
			grants: [
				{
					resource: "actor",
					target: "any",
					operations: ["create", "read", "list"],
				},
				{
					resource: "actor_gateway",
					target: "any",
					operations: ["create", "read", "update", "delete", "list"],
				},
			],
		}),
	});
	if (!response.ok) {
		throw new Error(`control plane answered ${response.status}`);
	}
	const body = (await response.json()) as {
		token?: unknown;
		expires_ts?: unknown;
	};
	if (typeof body.token !== "string" || typeof body.expires_ts !== "number") {
		throw new Error("control plane answered without a token");
	}
	return { token: body.token, issuedAt: Date.now(), expiresAt: body.expires_ts };
};

/** Page loads share one token until it is near its expiry. */
const browserToken = (adminToken: string, forceRefresh: boolean) => {
	const now = Date.now();
	const isFresh =
		cachedToken !== undefined &&
		now < cachedToken.expiresAt - TOKEN_RENEW_BEFORE_EXPIRY_MS &&
		!(forceRefresh && now - cachedToken.issuedAt > TOKEN_MIN_AGE_FOR_REFRESH_MS);
	if (isFresh && cachedToken !== undefined) return Promise.resolve(cachedToken);
	pendingToken ??= issueToken(adminToken)
		.then((issued) => {
			cachedToken = issued;
			return issued;
		})
		.finally(() => {
			pendingToken = undefined;
		});
	return pendingToken;
};

const sendJson = (
	response: ServerResponse,
	status: number,
	body: unknown,
) =>
	response
		.writeHead(status, {
			"content-type": "application/json",
			"cache-control": "no-store",
		})
		.end(JSON.stringify(body));

const readStaticFile = async (urlPath: string) => {
	// `normalize` on an absolute path removes `..`, so the file stays in webRoot.
	const filePath = join(webRoot, normalize(urlPath));
	try {
		return { body: await readFile(filePath), type: extname(filePath) };
	} catch {
		return { body: await readFile(join(webRoot, "index.html")), type: ".html" };
	}
};

const server = () =>
	createServer(async (request, response) => {
		const { pathname, searchParams } = new URL(request.url ?? "/", "http://localhost");
		if (pathname === "/healthz") {
			response.writeHead(200, { "content-type": "text/plain" }).end("ok");
			return;
		}
		if (pathname === "/config.json") {
			sendJson(response, 200, clientConfig());
			return;
		}
		if (pathname === "/token") {
			const adminToken = process.env.RIVET_ADMIN_TOKEN;
			if (!adminToken) {
				sendJson(response, 200, { token: null });
				return;
			}
			try {
				const { token, expiresAt } = await browserToken(
					adminToken,
					searchParams.has("refresh"),
				);
				sendJson(response, 200, { token, expiresAt });
			} catch (error) {
				// The message has a status code only, never a token.
				console.error(`token issue failed: ${(error as Error).message}`);
				sendJson(response, 502, { error: "token issue failed" });
			}
			return;
		}
		try {
			const file = await readStaticFile(
				pathname === "/" ? "/index.html" : pathname,
			);
			response
				.writeHead(200, {
					"content-type":
						contentTypes[file.type] ?? "application/octet-stream",
				})
				.end(file.body);
		} catch {
			response.writeHead(404).end("web/dist is missing. Run `pnpm build`.");
		}
	});

/** Serves the built frontend, `/config.json`, `/token` and `/healthz`. */
export const HttpLive = Layer.effectDiscard(
	Effect.acquireRelease(
		Effect.callback<ReturnType<typeof server>>((resume) => {
			const port = Number(process.env.PORT ?? 8080);
			const httpServer = server().listen(port, () => {
				console.log(`http server listening on :${port}`);
				resume(Effect.succeed(httpServer));
			});
		}),
		(httpServer) =>
			Effect.sync(() => {
				httpServer.close();
				httpServer.closeAllConnections();
			}),
	),
);
