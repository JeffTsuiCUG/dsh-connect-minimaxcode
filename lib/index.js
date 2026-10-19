import { readFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { LlmAdapter, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
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
* could not confirm. Last verified against the live catalog on 2026-10-19,
* when upstream retired `MiniMax-M2.7` and `MiniMax-M2.7-highspeed` and
* promoted the model previously served anonymously (internally "space bunny")
* as `MiniMax-M3.1-Flash`.
*/
const FALLBACK_MODELS = [{
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
}, {
	id: "MiniMax-M3.1-Flash",
	name: "M3.1-Flash",
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
* An adapter that reports what each request used.
*
* The usage counters ride on the stream the gateway already sends, so
* measuring costs nothing extra: the chunk is copied out of the stream and
* handed to the callback, and the chunk itself still reaches the host
* unchanged. Both entry points are covered — the plain stream and the one a
* prepared call dispatches through — because the host may use either.
*/
var MeteredAdapter = class extends LlmAdapter {
	#inner;
	#onUsage;
	constructor(inner, onUsage) {
		super();
		this.#inner = inner;
		this.#onUsage = onUsage;
	}
	providerInfo(provider) {
		return this.#inner.providerInfo(provider);
	}
	providerRetryPolicy(provider) {
		return this.#inner.providerRetryPolicy(provider);
	}
	listModels(provider) {
		return this.#inner.listModels(provider);
	}
	resolveModel(provider, model, signal) {
		return this.#inner.resolveModel(provider, model, signal);
	}
	async prepareCall(provider, model, signal) {
		const prepared = await this.#inner.prepareCall(provider, model, signal);
		return {
			...prepared,
			stream: (options) => this.#metered(prepared.stream(options), model)
		};
	}
	stream(options) {
		return this.#metered(this.#inner.stream(options), options.model);
	}
	/** Copy the usage out of a stream, leaving the stream itself untouched. */
	#metered(chunks, model) {
		const onUsage = this.#onUsage;
		return { async *[Symbol.asyncIterator]() {
			for await (const chunk of chunks) {
				if (chunk.type === "usage") {
					const usage = chunk.usage;
					onUsage(model, {
						inputTokens: usage.inputTokens,
						outputTokens: usage.outputTokens,
						cacheReadTokens: usage.cacheReadTokens ?? 0,
						cacheWriteTokens: usage.cacheWriteTokens ?? 0,
						reasoningTokens: usage.reasoningTokens ?? 0
					});
				}
				yield chunk;
			}
		} };
	}
};
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
	const inner = new PiAiAdapter({
		profiles: () => profiles,
		resolveApiKey: options.resolveApiKey,
		auth: INERT_AUTH
	});
	return {
		adapter: options.onUsage === void 0 ? inner : new MeteredAdapter(inner, options.onUsage),
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
		refreshing: deps.refreshing,
		...deps.credits === void 0 ? {} : { credits: deps.credits },
		...deps.usage === void 0 ? {} : { usage: deps.usage }
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
//#region src/credits.ts
/**
* The MiniMax Code account's credit balance.
*
* Two credentials exist on this machine and they are not interchangeable:
*
* - `local-runtime.auth.json` holds a JWT the model gateway accepts. It cannot
*   read account data: every credit endpoint answers `401`.
* - `auth/prod/<region>/mcode-public/auth.json` holds the desktop app's OAuth
*   token (`mmoat_`). That is the credential the account endpoints accept.
*
* The balance itself comes from the membership endpoint the desktop app calls
* itself: `POST /matrix/api/v1/commerce/get_membership_info`, whose response
* carries `op_credit_summary` — the same three numbers the app's own settings
* page renders ("remaining credits", free vs purchased).
*
* Nothing here performs a login. The plugin may refresh an *expired* token
* with the refresh token the app already stored, and writes the rotated pair
* back in the app's own format so the app keeps working; it never starts a
* sign-in, never revokes, and never touches the app's accounts.
*
* @module dsh-connect-minimaxcode/credits
*/
/** The desktop app's own OAuth client id. */
const MINIMAX_OAUTH_CLIENT_ID = "mcode-public";
/** The scope the app requests. */
const MINIMAX_OAUTH_SCOPES = ["agent.default"];
/** The audience the app's tokens are issued for. */
const MINIMAX_OAUTH_AUDIENCE = "agent-backend";
/** Authorization server per region. */
const MINIMAX_AUTH_HOSTS = {
	cn: "https://account.minimax.cn",
	io: "https://account.minimax.io",
	com: "https://account.minimaxi.com"
};
/** Gateway serving the account endpoints per region. */
const MINIMAX_ACCOUNT_HOSTS = {
	cn: "https://agent.minimax.cn",
	io: "https://agent.minimax.io",
	com: "https://agent.minimaxi.com"
};
/** Membership endpoint: carries the credit summary. */
const MEMBERSHIP_PATH = "/matrix/api/v1/commerce/get_membership_info";
/** OAuth token endpoint. */
const TOKEN_PATH = "/oauth2/token";
/** Absolute path of the app's credential file for a region. */
function oauthAuthPath(region, env = process.env) {
	return join(dataDir(env), "auth", "prod", region, "mcode-public", "auth.json");
}
/** Milliseconds until the credential expires; negative once it has. */
function expiresInMs$1(credential, now = Date.now()) {
	return credential.expiresAtMs === void 0 ? void 0 : credential.expiresAtMs - now;
}
/** Whether the credential is close enough to expiry to be worth refreshing. */
function needsRefresh(credential, now = Date.now()) {
	const remaining = expiresInMs$1(credential, now);
	return remaining !== void 0 && remaining <= 12e4;
}
/**
* Parse the app's credential document.
*
* The record key is generated per install, so the record is found by value
* rather than by a hard-coded name.
*/
function parseOAuthDocument(text, now = Date.now()) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			state: "signed-out",
			reason: "unreadable"
		};
	}
	const records = parsed.records;
	if (typeof records !== "object" || records === null) return {
		state: "signed-out",
		reason: "not-signed-in"
	};
	const record = Object.values(records)[0];
	if (typeof record !== "object" || record === null) return {
		state: "signed-out",
		reason: "not-signed-in"
	};
	const entry = record;
	const token = entry.accessToken;
	if (typeof token !== "string" || token.length === 0) return {
		state: "signed-out",
		reason: "not-signed-in"
	};
	const expiresAtMs = typeof entry.expiresAtMs === "number" ? entry.expiresAtMs : void 0;
	const credential = {
		token,
		refreshToken: typeof entry.refreshToken === "string" ? entry.refreshToken : void 0,
		expiresAtMs,
		clientId: typeof entry.clientId === "string" ? entry.clientId : MINIMAX_OAUTH_CLIENT_ID,
		scopes: Array.isArray(entry.scopes) ? entry.scopes.filter((s) => typeof s === "string") : [...MINIMAX_OAUTH_SCOPES],
		audience: typeof entry.audience === "string" ? entry.audience : MINIMAX_OAUTH_AUDIENCE,
		generation: typeof entry.generation === "number" ? entry.generation : void 0
	};
	return expiresAtMs !== void 0 && expiresAtMs <= now ? {
		state: "expired",
		credential
	} : {
		state: "signed-in",
		credential
	};
}
/**
* Read the desktop app's OAuth credential.
*
* Every failure is a state, not an exception: an app that is not installed, or
* not signed in, is a normal condition the UI renders rather than an error the
* host logs on every request.
*/
async function readOAuthCredential(region, env = process.env, now = Date.now()) {
	let text;
	try {
		text = await readFile(oauthAuthPath(region, env), "utf8");
	} catch {
		return {
			state: "signed-out",
			reason: "app-missing"
		};
	}
	return parseOAuthDocument(text, now);
}
/**
* Exchange the stored refresh token for a fresh access token.
*
* The authorization server rotates the refresh token, so the new pair is
* written back into the app's own file, in the app's own format, with an
* atomic replace. `generation` is left untouched on purpose: the app uses it
* to decide whether a stored credential still belongs to its own login, and
* raising it would make the app believe it had been signed in elsewhere.
*/
async function refreshOAuthCredential(region, credential, env = process.env, now = Date.now(), fetchImpl = fetch) {
	if (credential.refreshToken === void 0) return {
		state: "expired",
		credential
	};
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: credential.refreshToken,
		client_id: credential.clientId,
		scope: credential.scopes.join(" "),
		audience: credential.audience
	});
	const response = await fetchImpl(`${MINIMAX_AUTH_HOSTS[region]}${TOKEN_PATH}`, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/x-www-form-urlencoded"
		},
		body
	});
	if (!response.ok) throw new Error(`OAuth refresh failed: HTTP ${response.status}`);
	const document = await response.json();
	const token = document.access_token;
	if (typeof token !== "string" || token.length === 0) throw new Error("OAuth refresh returned no access token");
	const expiresInSec = typeof document.expires_in === "number" ? document.expires_in : void 0;
	const next = {
		...credential,
		token,
		refreshToken: typeof document.refresh_token === "string" ? document.refresh_token : credential.refreshToken,
		expiresAtMs: expiresInSec === void 0 ? void 0 : now + expiresInSec * 1e3
	};
	await writeOAuthCredential(region, next, env);
	return {
		state: "signed-in",
		credential: next
	};
}
/**
* Write a rotated credential back into the app's store.
*
* The document is rewritten as a whole so the app's own reader keeps seeing
* the shape it wrote, and the replace is atomic so a crash mid-write cannot
* leave a truncated credential file behind.
*/
async function writeOAuthCredential(region, credential, env = process.env) {
	const path = oauthAuthPath(region, env);
	let document;
	try {
		document = JSON.parse(await readFile(path, "utf8"));
	} catch {
		return;
	}
	const records = document.records;
	if (typeof records !== "object" || records === null) return;
	const first = Object.entries(records)[0];
	if (first === void 0) return;
	const [key, record] = first;
	if (typeof record !== "object" || record === null) return;
	const existing = record;
	const updated = {
		...existing,
		accessToken: credential.token,
		refreshToken: credential.refreshToken ?? existing.refreshToken,
		tokenType: "Bearer",
		clientId: credential.clientId,
		scopes: credential.scopes,
		audience: credential.audience,
		expiresAtMs: credential.expiresAtMs
	};
	const payload = {
		...document,
		records: {
			...records,
			[key]: updated
		}
	};
	const temporary = `${path}.dsh-connect-minimaxcode.tmp`;
	await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 384 });
	await rename(temporary, path);
}
/**
* Read the credential, refreshing it when it is close to expiry.
*
* A refresh is only attempted for a credential the app already stored, and
* only when it is actually stale: a fresh token is left alone, so the plugin
* never competes with the app for the same grant.
*/
async function ensureOAuthCredential(region, env = process.env, now = Date.now(), fetchImpl = fetch) {
	const state = await readOAuthCredential(region, env, now);
	if (state.state === "signed-in" && !needsRefresh(state.credential, now)) return state;
	if (state.state === "signed-out") return state;
	try {
		return await refreshOAuthCredential(region, state.credential, env, now, fetchImpl);
	} catch {
		return state;
	}
}
/**
* Read the credit summary out of a membership response.
*
* The app's settings page prefers the summary and falls back to the flat
* balance fields, so the same fallback chain is used here.
*/
function parseCreditSummary(document) {
	if (typeof document !== "object" || document === null) return void 0;
	const record = document;
	const summary = record.op_credit_summary;
	if (typeof summary === "object" && summary !== null) {
		const entry = summary;
		const total = toNumber(entry.total_remaining_amount);
		if (total !== void 0) {
			const purchased = toNumber(entry.purchased_remaining_amount) ?? 0;
			return {
				total,
				purchased,
				free: toNumber(entry.free_remaining_amount) ?? total - purchased
			};
		}
	}
	const flat = toNumber(record.opcredit_balance) ?? toNumber(record.total_remains_credit);
	return flat === void 0 ? void 0 : {
		total: flat,
		purchased: 0,
		free: flat
	};
}
/** Read a numeric field the upstream may send as a string. */
function toNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
/**
* Fetch the current credit balance.
*
* @returns The balance, or `undefined` when the account has no credit summary.
*/
async function fetchCreditSummary(credential, region, fetchImpl = fetch) {
	const response = await fetchImpl(`${MINIMAX_ACCOUNT_HOSTS[region]}${MEMBERSHIP_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${credential.token}`
		},
		body: "{}"
	});
	if (!response.ok) throw new Error(`membership request failed: HTTP ${response.status}`);
	return parseCreditSummary(await response.json());
}
/**
* Keeps the current balance and the change between reads.
*
* The first read has nothing to compare against, so it reports no movement
* rather than pretending the whole balance was spent.
*/
var MinimaxCredits = class {
	#snapshot;
	#error;
	/** The balance as last read. */
	get snapshot() {
		return this.#snapshot;
	}
	/** Why the last read failed, when one did. */
	get error() {
		return this.#error;
	}
	/**
	* Read the balance and record how much was consumed since the last read.
	*
	* @returns Whether the balance changed.
	*/
	async refresh(credential, region, fetchImpl = fetch, now = Date.now()) {
		try {
			const summary = await fetchCreditSummary(credential, region, fetchImpl);
			if (summary === void 0) {
				this.#error = "membership response carried no credit summary";
				return false;
			}
			const previous = this.#snapshot;
			this.#snapshot = {
				summary,
				fetchedAtMs: now,
				consumed: previous === void 0 ? 0 : previous.summary.total - summary.total
			};
			this.#error = void 0;
			return previous === void 0 || previous.summary.total !== summary.total;
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
			return false;
		}
	}
};
//#endregion
//#region src/usage.ts
/** An empty usage record. */
const EMPTY_USAGE = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	reasoningTokens: 0
};
/** The published domestic prices of the models this plugin serves. */
const MODEL_PRICES = {
	"MiniMax-M3.1-Flash": {
		input: 1,
		output: 4,
		cacheRead: .1
	},
	"MiniMax-M3": {
		input: 2.1,
		output: 8.4,
		cacheRead: .42
	}
};
/**
* The price for one model at one input size.
*
* M3 is billed in two tiers: requests above 512k input tokens cost double.
* The tier is decided by the billed input, which is the uncached input plus
* the cache read.
*/
function priceFor(model, billedInputTokens) {
	const price = MODEL_PRICES[model];
	if (price === void 0) return void 0;
	if (model === "MiniMax-M3" && billedInputTokens > 512e3) return {
		input: price.input * 2,
		output: price.output * 2,
		cacheRead: price.cacheRead * 2
	};
	return price;
}
/**
* The equivalent amount of one request, in 元.
*
* Returns `undefined` for a model without a published price, rather than
* pretending the request was free.
*/
function estimateCny(model, usage) {
	const price = priceFor(model, usage.inputTokens + usage.cacheReadTokens);
	if (price === void 0) return void 0;
	const perMillion = (tokens, rate) => tokens / 1e6 * rate;
	return perMillion(usage.inputTokens, price.input) + perMillion(usage.outputTokens, price.output) + perMillion(usage.cacheReadTokens, price.cacheRead);
}
/**
* Accumulates what the sessions routed through this plugin have used.
*
* The meter is the plugin's own view: it counts the requests this host made,
* with the counters the gateway returned. It is not the account's total, and
* it is not the credit balance — the balance comes from the account API.
*/
var UsageMeter = class {
	#records = [];
	#byModel = /* @__PURE__ */ new Map();
	/** Every recorded request, oldest first. */
	get records() {
		return this.#records;
	}
	/** The most recent request. */
	get last() {
		return this.#records[this.#records.length - 1];
	}
	/** Record one request's usage. */
	record(model, usage) {
		const entry = {
			model,
			usage: { ...usage },
			cny: estimateCny(model, usage)
		};
		this.#records.push(entry);
		const totals = this.#byModel.get(model) ?? { ...EMPTY_USAGE };
		this.#byModel.set(model, {
			inputTokens: totals.inputTokens + usage.inputTokens,
			outputTokens: totals.outputTokens + usage.outputTokens,
			cacheReadTokens: totals.cacheReadTokens + usage.cacheReadTokens,
			cacheWriteTokens: totals.cacheWriteTokens + usage.cacheWriteTokens,
			reasoningTokens: totals.reasoningTokens + usage.reasoningTokens
		});
		return entry;
	}
	/** Totals across every recorded request. */
	totals() {
		let total = { ...EMPTY_USAGE };
		for (const usage of this.#byModel.values()) total = {
			inputTokens: total.inputTokens + usage.inputTokens,
			outputTokens: total.outputTokens + usage.outputTokens,
			cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
			cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
			reasoningTokens: total.reasoningTokens + usage.reasoningTokens
		};
		return total;
	}
	/** Totals per model. */
	byModel() {
		return this.#byModel;
	}
	/** The equivalent amount of everything recorded, in 元. */
	estimatedCny() {
		let total = 0;
		for (const record of this.#records) if (record.cny !== void 0) total += record.cny;
		return total;
	}
	/** Forget everything recorded. */
	reset() {
		this.#records = [];
		this.#byModel.clear();
	}
};
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
* How often the account's credit balance may be re-read.
*
* The balance is a live counter upstream, but it is an account-wide value:
* reading it too often buys nothing except load on the account API.
*/
const CREDIT_TTL_MS = 3e4;
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
	const credits = new MinimaxCredits();
	const meter = new UsageMeter();
	let region = "cn";
	let credential;
	let lastCatalogAtMs = 0;
	let lastCreditAtMs = 0;
	let refreshing = false;
	let creditState = "unavailable";
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
	/**
	* Read the account's credit balance, at most once per TTL.
	*
	* The account API needs the desktop app's own OAuth token, not the model
	* gateway's JWT, so this reads a second credential file. A stale token is
	* refreshed through the app's own grant and written back in the app's own
	* format, which keeps the app signed in.
	*/
	const refreshCredits = async () => {
		const now = Date.now();
		if (now - lastCreditAtMs < CREDIT_TTL_MS) return;
		lastCreditAtMs = now;
		const state = await ensureOAuthCredential(region, process.env, now);
		if (state.state === "signed-out") {
			creditState = "signed-out";
			return;
		}
		if (state.state === "expired") {
			creditState = "expired";
			return;
		}
		await credits.refresh(state.credential, region, fetch, now);
		creditState = credits.snapshot === void 0 ? "unavailable" : "ok";
	};
	/** The credit balance as the card and the browser half read it. */
	const buildCreditStatus = () => {
		const snapshot = credits.snapshot;
		if (snapshot === void 0) return {
			state: creditState,
			...credits.error === void 0 ? {} : { error: credits.error }
		};
		return {
			state: "ok",
			total: snapshot.summary.total,
			purchased: snapshot.summary.purchased,
			free: snapshot.summary.free,
			consumed: snapshot.consumed,
			updatedAtMs: snapshot.fetchedAtMs
		};
	};
	/** What this host's own requests have used. */
	const buildUsageStatus = () => {
		const totals = meter.totals();
		const last = meter.last;
		return {
			inputTokens: totals.inputTokens,
			outputTokens: totals.outputTokens,
			cacheReadTokens: totals.cacheReadTokens,
			cacheWriteTokens: totals.cacheWriteTokens,
			reasoningTokens: totals.reasoningTokens,
			estimatedCny: meter.estimatedCny(),
			...last?.cny === void 0 ? {} : { lastCny: last.cny },
			...last === void 0 ? {} : { lastModel: last.model },
			requests: meter.records.length
		};
	};
	const { adapter, invalidate } = createMinimaxCodeAdapter({
		catalog,
		region: () => region,
		resolveApiKey: async () => (await readNow())?.token,
		bearerToken: () => bearerToken(),
		onUsage: (model, usage) => {
			meter.record(model, usage);
			refreshCredits();
		}
	});
	ctx.llm.registerAdapter(["minimaxcode"], adapter);
	/** Build the document the card renders, without ever exposing the token. */
	const buildStatus = async () => {
		const state = await readCredential();
		const auth = state.state === "signed-in" ? {
			state: "signed-in",
			daysRemaining: Math.ceil(expiresInMs(state.credential.claims) / 864e5),
			expiry: expiryLevel(state.credential.claims)
		} : state.state === "expired" ? { state: "expired" } : {
			state: "signed-out",
			reason: state.reason
		};
		await refreshCredits();
		return statusDocument({
			auth,
			region,
			catalogSource: catalog.source,
			catalogError: catalog.error,
			models: catalog.current().map(({ id, name: modelName, contextWindow }) => ({
				id,
				name: modelName,
				contextWindow
			})),
			refreshing,
			credits: buildCreditStatus(),
			usage: buildUsageStatus()
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
export { EMPTY_USAGE, FALLBACK_MODELS, MEMBERSHIP_PATH, MINIMAXCODE_PROVIDER_ID, MINIMAX_AUTH_FILENAME, MINIMAX_DATA_DIR, MINIMAX_GATEWAYS, MINIMAX_OAUTH_CLIENT_ID, MINIMAX_REGIONS, MINIMAX_STATUS_PATH, MINIMAX_STREAM_IDLE_TIMEOUT_MS, MODEL_PRICES, MinimaxCatalog, MinimaxCredits, UsageMeter, apply, authPath, bearerToken, catalogUrl, chatBaseUrl, createMinimaxCodeAdapter, dataDir, daysRemaining, decodeClaims, ensureOAuthCredential, estimateCny, expiresInMs, expiryLevel, fetchCreditSummary, inject, name, parseAuthDocument, parseCatalog, parseCreditSummary, parseOAuthDocument, priceFor, readCredential, readOAuthCredential, refreshOAuthCredential, statusDocument, writeOAuthCredential };
