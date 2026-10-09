import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
//#region src/auth.ts
/**
* Reading the MiniMax Code desktop app's own sign-in.
*
* The desktop app persists its bearer token as plaintext JSON under its data
* directory. This module reads that file, decodes the JWT without verifying it
* (the signature exists to stop *tampering*, and nobody tampers with a token we
* only ever send back to the issuer), and reports expiry so the UI can warn
* before the models go dark.
*
* Nothing here performs a login, a refresh, or any write. The token's lifetime
* is owned by the desktop app: renewing it means signing in there again, which
* is a deliberate step the user takes in the app, never one this plugin makes
* on their behalf.
*
* @module dsh-connect-minimaxcode/auth
*/
/** File the desktop app writes its runtime auth context into. */
const MINIMAX_AUTH_FILENAME = "local-runtime.auth.json";
/** Directory holding it, relative to the user's home. */
const MINIMAX_DATA_DIR = ".minimax";
/** Region-specific gateways the desktop app ships with. */
const MINIMAX_GATEWAYS = {
	cn: "https://agent.minimax.cn",
	io: "https://agent.minimax.io",
	com: "https://agent.minimaxi.com"
};
/** Every region, for a fallback sweep when the configured one fails. */
const MINIMAX_REGIONS = [
	"cn",
	"io",
	"com"
];
/**
* Base URL for pi-ai's anthropic client on a region gateway.
*
* This must stop *before* the API version segment: the Anthropic SDK appends
* `/v1/messages` itself, so a base ending in `/v1` produced the doubled path
* `/mavis/api/v1/llm/v1/v1/messages`, which the gateway answers with
* `503 direct_route_not_configured`. The correct request URL is therefore
* `<this>/v1/messages`.
*/
function chatBaseUrl(region) {
	return `${MINIMAX_GATEWAYS[region]}/mavis/api/v1/llm`;
}
/** Base URL of the authoritative model catalog on a region gateway. */
function catalogUrl(region) {
	return `${MINIMAX_GATEWAYS[region]}/mavis/api/v1/models`;
}
/** Default data directory, honouring the app's own override variables. */
function dataDir(env = process.env) {
	return env.MINIMAX_DATA_DIR ?? env.MAVIS_DATA_DIR ?? join(homedir(), ".minimax");
}
/** Absolute path of the auth file this plugin reads. */
function authPath(env = process.env) {
	return join(dataDir(env), MINIMAX_AUTH_FILENAME);
}
/**
* Decode a JWT payload without verifying its signature.
*
* Only the expiry is trusted, and only to decide how loudly to warn: a token we
* cannot parse is reported as malformed rather than silently accepted, and a
* token that verifies as expired is reported as expired rather than sent. The
* issuer remains the sole authority on both questions.
*/
function decodeClaims(token) {
	const parts = token.split(".");
	if (parts.length !== 3) return void 0;
	try {
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		if (typeof payload.exp !== "number") return void 0;
		const user = payload.user;
		const claims = { exp: payload.exp };
		if (typeof user?.id === "string") claims.userId = user.id;
		if (typeof user?.name === "string") claims.name = user.name;
		return claims;
	} catch {
		return;
	}
}
/** Milliseconds until the token expires; negative once it has. */
function expiresInMs(claims, now = Date.now()) {
	return claims.exp * 1e3 - now;
}
/** Warn inside the last day, and treat anything past it as already gone. */
const EXPIRING_THRESHOLD_MS = 864e5;
/** Classify a token's remaining lifetime for display. */
function expiryLevel(claims, now = Date.now()) {
	const remaining = expiresInMs(claims, now);
	if (remaining <= 0) return "expired";
	if (remaining <= EXPIRING_THRESHOLD_MS) return "expiring";
	return "healthy";
}
/** Whole days left, rounded up so 1 hour reads as "1 day", not "0 days". */
function daysRemaining(claims, now = Date.now()) {
	const remaining = expiresInMs(claims, now);
	return remaining <= 0 ? 0 : Math.ceil(remaining / 864e5);
}
/**
* Parse the app's auth document into a state.
*
* Shared by the async and sync readers so the two can never disagree about what
* counts as signed in.
*
* @param text - Raw file contents.
* @param now - Clock, injected so expiry is testable.
* @returns The usable credential, or why there is none.
*/
function parseAuthDocument(text, now = Date.now()) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			state: "signed-out",
			reason: "unreadable"
		};
	}
	const token = parsed.auth?.accessToken;
	if (typeof token !== "string" || token.length === 0) return {
		state: "signed-out",
		reason: "not-signed-in"
	};
	const claims = decodeClaims(token);
	if (claims === void 0) return {
		state: "signed-out",
		reason: "malformed"
	};
	if (expiresInMs(claims, now) <= 0) return {
		state: "expired",
		expiresAtMs: claims.exp * 1e3
	};
	return {
		state: "signed-in",
		credential: {
			token,
			claims,
			updatedAtMs: typeof parsed.updatedAtMs === "number" ? parsed.updatedAtMs : void 0
		}
	};
}
/**
* Read the desktop app's credential.
*
* Every failure mode is a state rather than an exception: a user who has not
* installed or signed in yet is a normal condition the card renders, not an
* error the host logs on every start.
*
* @param env - Environment used to locate the data directory.
* @param now - Clock, injected so expiry is testable.
* @returns The usable credential, or why there is none.
*/
async function readCredential(env = process.env, now = Date.now()) {
	let text;
	try {
		text = await readFile(authPath(env), "utf8");
	} catch {
		return {
			state: "signed-out",
			reason: "app-missing"
		};
	}
	return parseAuthDocument(text, now);
}
/**
* The bearer token for the current request, or `undefined`.
*
* pi-ai's anthropic-messages client sends the resolved `apiKey` as `x-api-key`,
* but MiniMax's gateway answers `{"code":401,"message":"token is required"}`
* unless an `Authorization: Bearer` header is also present. That header has to
* ride on the model descriptor ({@link Model.headers}), which is built inside
* the provider's synchronous `getModels()` — hence the synchronous read here.
* pi-ai calls `getModels()` once per operation, so the token is re-read per
* request and a re-login takes effect without a restart.
*
* @param env - Environment used to locate the data directory.
* @param now - Clock, injected so expiry is testable.
* @returns The token, or `undefined` when there is no usable one.
*/
function bearerToken(env = process.env, now = Date.now()) {
	let text;
	try {
		text = readFileSync(authPath(env), "utf8");
	} catch {
		return;
	}
	const state = parseAuthDocument(text, now);
	return state.state === "signed-in" ? state.credential.token : void 0;
}
/**
* Inert pi-ai auth plane.
*
* The minimaxcode route authenticates only through `resolveApiKey`, which reads
* the desktop app's token per request, so pi-ai's own credential lifecycle and
* ambient discovery must never manufacture a credential for it — otherwise a
* stale or absent store would shadow the real token.
*
* `PiAiAdapterOptions.auth` is required and takes the pi-ai pair
* `{ credentials, authContext }`, not a request-shaped object; every ambient
* question here answers "nothing stored, nothing set", and a login is refused
* outright rather than silently accepted.
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-connect-minimaxcode: the minimaxcode route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** Provider id registered with DSH, distinct from the upstream one. */
const MINIMAXCODE_PROVIDER_ID = "minimaxcode";
/**
* Used when the catalog cannot be fetched, so the picker still offers the
* models the desktop app is known to ship.
*
* Deliberately small and conservative: a fallback entry overstates nothing we
* could not confirm.
*/
const FALLBACK_MODELS = [{
	id: "MiniMax-M2.7",
	name: "M2.7",
	contextWindow: 2e5,
	maxOutputTokens: 128e3,
	toolCall: true,
	reasoning: true,
	inputModalities: ["text"],
	attachment: false
}, {
	id: "MiniMax-M3",
	name: "M3",
	contextWindow: 512e3,
	maxOutputTokens: 128e3,
	toolCall: true,
	reasoning: true,
	inputModalities: [
		"text",
		"image",
		"video"
	],
	attachment: true
}];
/** Model with the same id, from a newer snapshot. */
function sameCatalog(a, b) {
	if (a.length !== b.length) return false;
	return a.every((model, index) => {
		const other = b[index];
		return model.id === other.id && model.contextWindow === other.contextWindow && model.toolCall === other.toolCall && model.reasoning === other.reasoning && model.attachment === other.attachment;
	});
}
/** Keep only models whose id the upstream keys them by. */
function usable(id, raw) {
	return id.length > 0 && id.startsWith("MiniMax-") && typeof raw === "object" && raw !== null;
}
/** Read the fields the upstream sends, tolerating their absence. */
function readModel(id, raw) {
	const limit = raw.limit ?? {};
	const modalities = raw.modalities ?? {};
	const input = Array.isArray(modalities.input) ? modalities.input.filter((m) => typeof m === "string") : ["text"];
	const contextWindow = typeof limit.context === "number" ? limit.context : 2e5;
	return {
		id,
		name: typeof raw.name === "string" ? raw.name : id,
		contextWindow,
		maxOutputTokens: typeof limit.output === "number" ? limit.output : void 0,
		toolCall: raw.tool_call === true,
		reasoning: raw.reasoning === true,
		inputModalities: input,
		attachment: raw.attachment === true || input.includes("image")
	};
}
/**
* Parse the upstream catalog document.
*
* Unknown providers are ignored rather than rejected: the endpoint serves every
* provider the desktop app is configured for, and only MiniMax models belong in
* this plugin's picker.
*
* @param document - Decoded response body.
* @returns Models in upstream order, or an empty list when none qualify.
*/
function parseCatalog(document) {
	if (typeof document !== "object" || document === null) return [];
	const providers = document.providers;
	if (!Array.isArray(providers)) return [];
	const models = [];
	for (const entry of providers) {
		if (typeof entry !== "object" || entry === null) continue;
		const provider = entry;
		if (provider.providerId !== "minimax") continue;
		const declared = (provider.config ?? {}).models;
		if (typeof declared !== "object" || declared === null) continue;
		for (const [id, raw] of Object.entries(declared)) {
			if (!usable(id, raw)) continue;
			models.push(readModel(id, raw));
		}
	}
	return models;
}
/**
* Holds the catalog and answers the picker's questions about it.
*
* Refreshes are explicit: the plugin refreshes at startup and on demand, and
* keeps serving the last good snapshot while a refresh is in flight, so a
* network blip never empties the model list.
*/
var MinimaxCatalog = class {
	#snapshot = {
		models: [...FALLBACK_MODELS],
		source: "fallback"
	};
	#inflight;
	#lastIdentity;
	/** The models to serve right now. */
	current() {
		return this.#snapshot.models;
	}
	/** Provenance of {@link current}. */
	get source() {
		return this.#snapshot.source;
	}
	/** When {@link current} was fetched, when it came from upstream. */
	get fetchedAtMs() {
		return this.#snapshot.fetchedAtMs;
	}
	/** Why the last refresh failed, if one did. */
	get error() {
		return this.#snapshot.error;
	}
	/**
	* Replace the served list, adopting upstream's own ordering.
	*
	* @returns Whether anything changed, so callers can skip a needless reload.
	*/
	set(models, source, fetchedAtMs) {
		if (source === this.#snapshot.source && sameCatalog(this.#snapshot.models, models)) {
			if (source === "live") this.#snapshot.fetchedAtMs = fetchedAtMs ?? this.#snapshot.fetchedAtMs;
			return false;
		}
		this.#snapshot = {
			models: [...models],
			source,
			fetchedAtMs,
			error: void 0
		};
		return true;
	}
	/** Drop back to the built-in list, e.g. when the account signs out. */
	invalidate() {
		this.#snapshot = {
			models: [...FALLBACK_MODELS],
			source: "fallback"
		};
	}
	/**
	* Fetch the live catalog for a credential.
	*
	* Serialised through a single in-flight promise: a second caller joins the
	* first run rather than starting a duplicate request.
	*
	* @returns Whether the served list changed.
	*/
	async refresh(region, credential, fetchImpl = fetch) {
		const identity = credential.claims.userId ?? credential.claims.exp.toString();
		if (this.#inflight !== void 0) {
			await this.#inflight;
			return false;
		}
		this.#lastIdentity = identity;
		this.#inflight = (async () => {
			try {
				const response = await fetchImpl(catalogUrl(region), { headers: { authorization: `Bearer ${credential.token}` } });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const models = parseCatalog(await response.json());
				if (models.length === 0) throw new Error("catalog contained no MiniMax models");
				this.set(models, "live", Date.now());
			} catch (error) {
				this.#snapshot.error = error instanceof Error ? error.message : String(error);
				if (this.#snapshot.source !== "live") this.set(FALLBACK_MODELS, "fallback");
			}
		})();
		try {
			await this.#inflight;
		} finally {
			this.#inflight = void 0;
		}
		return true;
	}
	/** Identity the served catalog belongs to, if any. */
	get identity() {
		return this.#lastIdentity;
	}
};
//#endregion
//#region src/adapter.ts
/**
* Registering MiniMax Code's models as a DSH provider.
*
* The upstream endpoint is a standard Anthropic Messages API, so this plugin
* reuses the shared pi-ai adapter rather than implementing a transport: the
* work here is deciding *which* models to publish, pointing them at the right
* base URL, and keeping that in step with the live catalog.
*
* @module dsh-connect-minimaxcode/adapter
*/
/** How long a silent stream may last before the transport gives up. */
const MINIMAX_STREAM_IDLE_TIMEOUT_MS = 6e5;
/**
* Adapter-owned defaults a resolved route must carry.
*
* `PiAiAdapterOptions.profiles` wants a *resolved* route, so the image bounds
* below are the schema's own defaults (20MiB base64 payload, 2048px pixel
* budget, 1MiB per inline version). The retry policy is resolved by the
* library's public helper rather than hand-written. Both were previously hidden
* behind a cast, which is also what hid the missing required `auth` option.
*/
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/** Unknown price, stated as zero rather than invented. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/**
* Translate one catalog entry into the descriptor pi-ai expects.
*
* Capabilities come from upstream rather than being assumed, so a model that
* loses tool support upstream stops advertising it here. `video` is dropped from
* the declared input modalities because pi-ai models images, not video.
*
* Two gateway quirks are encoded here, both measured against the live endpoint:
*
* - `authorization` is why this descriptor carries `headers` at all. pi-ai's
*   anthropic client sends the resolved apiKey as `x-api-key`, and MiniMax
*   rejects that alone with 401 "token is required"; it accepts both headers, so
*   the bearer value is added alongside rather than replacing it.
* - `thinkingLevelMap.off = null` marks "thinking off" as unsupported. Every
*   MiniMax model here requires reasoning, and pi-ai answers an explicit
*   `thinkingEnabled: false` with `thinking: {type: "disabled"}`, which the
*   gateway refuses with `400 ... requires adaptive thinking`. Marking the level
*   unsupported makes pi-ai omit the field instead, which the gateway accepts
*   (and, correctly, hides the option that cannot work).
*
* @param model - Catalog entry to describe.
* @param baseUrl - Region gateway base the anthropic client extends.
* @param authorization - Value for the `Authorization` header, when signed in.
* @returns The pi-ai model descriptor.
*/
function toPiModel(model, baseUrl, authorization) {
	const input = model.inputModalities.includes("image") ? ["text", "image"] : ["text"];
	return {
		id: model.id,
		name: model.name,
		api: "anthropic-messages",
		provider: MINIMAXCODE_PROVIDER_ID,
		baseUrl,
		reasoning: model.reasoning,
		input: [...input],
		cost: { ...NO_COST },
		contextWindow: model.contextWindow,
		maxTokens: model.maxOutputTokens ?? 128e3,
		...authorization === void 0 ? {} : { headers: { authorization } },
		...model.reasoning ? { thinkingLevelMap: { off: null } } : {}
	};
}
/**
* Build the DSH adapter that serves the catalog.
*
* The model list is rebuilt on demand rather than snapshotted, which is what
* lets a refresh upstream appear without restarting the host.
*
* @param options - Catalog, region and token resolution.
* @returns The adapter plus a way to drop its cached profiles.
*/
function createMinimaxCodeAdapter(options) {
	const { catalog } = options;
	const buildModels = () => {
		const token = options.bearerToken();
		const authorization = token === void 0 ? void 0 : `Bearer ${token}`;
		return catalog.current().map((model) => toPiModel(model, chatBaseUrl(options.region()), authorization));
	};
	const provider = {
		...createProvider({
			id: MINIMAXCODE_PROVIDER_ID,
			name: "MiniMax Code",
			auth: { apiKey: {
				name: "MiniMax Code access token",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "MiniMax Code"
					};
				}
			} },
			models: buildModels(),
			api: anthropicMessagesApi()
		}),
		getModels: () => buildModels()
	};
	/**
	* Build a fresh route map for the catalog and region of this moment.
	*
	* `getModels` already reads the live catalog on every call, so the model list
	* needs no invalidation; what a refresh does invalidate is the per-model state
	* carried by the route — configured maxTokens and recorded model errors, which
	* would otherwise outlive a catalog or region change.
	*/
	const buildProfiles = () => {
		const route = {
			provider: MINIMAXCODE_PROVIDER_ID,
			displayName: "MiniMax Code",
			streamIdleTimeoutMs: MINIMAX_STREAM_IDLE_TIMEOUT_MS,
			retryPolicy: resolveRetryPolicy(void 0, "dsh-connect-minimaxcode retryPolicy"),
			configuredMaxTokens: /* @__PURE__ */ new Map(),
			modelErrors: /* @__PURE__ */ new Map(),
			...REQUEST_IMAGE_BUDGETS,
			piProvider: provider
		};
		return /* @__PURE__ */ new Map([[MINIMAXCODE_PROVIDER_ID, route]]);
	};
	let profiles = buildProfiles();
	return {
		adapter: new PiAiAdapter({
			profiles: () => profiles,
			resolveApiKey: options.resolveApiKey,
			auth: INERT_AUTH
		}),
		invalidate: () => {
			profiles = buildProfiles();
		}
	};
}
//#endregion
//#region src/status-route.ts
/** Route this plugin mounts, matching its settings card. */
const MINIMAX_STATUS_PATH = "/plugins/dsh-connect-minimaxcode/status";
const HINTS = {
	"app-missing": "未找到 MiniMax Code 的登录信息。请先安装并登录 MiniMax Code 桌面 App，然后重启 DSH。",
	"not-signed-in": "MiniMax Code 尚未登录。请在 MiniMax Code 桌面 App 中登录后重启 DSH。",
	unreadable: "登录信息文件无法读取。请确认 MiniMax Code 仍处于登录状态。",
	malformed: "登录令牌格式无法解析。请在 MiniMax Code 中重新登录后重启 DSH。"
};
/**
* Build the card's status document.
*
* The three non-signed-in states carry different remedies, and the difference
* is the whole point of the card: a user who has never installed the app needs
* a different next step than one whose token simply aged out.
*/
function statusDocument(deps) {
	const { auth } = deps;
	const base = {
		state: auth.state,
		region: deps.region,
		catalogSource: deps.catalogSource,
		...deps.catalogError === void 0 ? {} : { catalogError: deps.catalogError },
		models: deps.models,
		refreshing: deps.refreshing
	};
	if (auth.state === "expired") return {
		...base,
		expiry: "expired",
		daysRemaining: 0,
		hint: "登录令牌已过期。请打开并登录 MiniMax Code 桌面 App 以获取新令牌，然后重启 DSH。"
	};
	if (auth.state === "signed-out") return {
		...base,
		hint: HINTS[auth.reason ?? "not-signed-in"] ?? HINTS["not-signed-in"]
	};
	return {
		...base,
		expiry: auth.expiry,
		daysRemaining: auth.daysRemaining
	};
}
/** Only loopback callers may read the document. */
function isLoopback(host) {
	if (host === void 0) return false;
	const name = host.replace(/:\d+$/, "");
	return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}
//#endregion
//#region src/index.ts
/** Loader entry name; also the id the bundle patch inserts. */
const name = "dsh-connect-minimaxcode";
/** Services this plugin needs before it can serve anything. */
const inject = ["llm"];
/** Which gateway a given account should be served from. */
function pickRegion(preferred) {
	if (preferred !== void 0 && MINIMAX_REGIONS.includes(preferred)) return preferred;
	return "cn";
}
/** How often the card may pull a fresh catalog. */
const CATALOG_TTL_MS = 3e5;
/**
* Compose the plugin.
*
* The credential is re-read on every request rather than cached at start: the
* desktop app refreshes its token independently, and a long-lived host would
* otherwise pin an expired one for the rest of the process.
*
* @param ctx - Service container.
*/
function apply(ctx) {
	const catalog = new MinimaxCatalog();
	let region = "cn";
	let credential;
	let lastCatalogAtMs = 0;
	let refreshing = false;
	const readNow = async () => {
		const state = await readCredential();
		if (state.state !== "signed-in") {
			credential = void 0;
			catalog.invalidate();
			return;
		}
		credential = state.credential;
		return credential;
	};
	/** Refresh the catalog at most once per TTL, never blocking a request. */
	const refreshCatalog = async (current) => {
		if (refreshing || Date.now() - lastCatalogAtMs < CATALOG_TTL_MS) return;
		refreshing = true;
		try {
			await catalog.refresh(region, current);
			lastCatalogAtMs = Date.now();
		} finally {
			refreshing = false;
		}
	};
	const { adapter, invalidate } = createMinimaxCodeAdapter({
		catalog,
		region: () => region,
		resolveApiKey: async () => (await readNow())?.token,
		bearerToken: () => bearerToken()
	});
	ctx.llm.registerAdapter(["minimaxcode"], adapter);
	/** Build the document the card renders, without ever exposing the token. */
	const buildStatus = async () => {
		const state = await readCredential();
		return statusDocument({
			auth: state.state === "signed-in" ? {
				state: "signed-in",
				daysRemaining: Math.ceil(expiresInMs(state.credential.claims) / 864e5),
				expiry: expiryLevel(state.credential.claims)
			} : state.state === "expired" ? { state: "expired" } : {
				state: "signed-out",
				reason: state.reason
			},
			region,
			catalogSource: catalog.source,
			catalogError: catalog.error,
			models: catalog.current().map(({ id, name: modelName, contextWindow }) => ({
				id,
				name: modelName,
				contextWindow
			})),
			refreshing
		});
	};
	(async () => {
		const current = await readNow();
		if (current !== void 0) {
			region = pickRegion(void 0);
			await refreshCatalog(current);
			invalidate();
		}
	})();
	ctx.inject(["webServer"], (webCtx) => {
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: MINIMAX_STATUS_PATH,
			handler: async (req, res) => {
				if (!isLoopback(req.headers.host)) {
					res.writeHead(403, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "loopback only" }));
					return;
				}
				try {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(await buildStatus()));
				} catch (error) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
				}
			}
		}));
	});
}
//#endregion
export { FALLBACK_MODELS, MINIMAXCODE_PROVIDER_ID, MINIMAX_AUTH_FILENAME, MINIMAX_DATA_DIR, MINIMAX_GATEWAYS, MINIMAX_REGIONS, MINIMAX_STATUS_PATH, MINIMAX_STREAM_IDLE_TIMEOUT_MS, MinimaxCatalog, apply, authPath, bearerToken, catalogUrl, chatBaseUrl, createMinimaxCodeAdapter, dataDir, daysRemaining, decodeClaims, expiresInMs, expiryLevel, inject, name, parseAuthDocument, parseCatalog, readCredential, statusDocument };
