import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { LlmAdapter, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createHash, randomBytes } from "node:crypto";
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
/** Route the card posts to when it wants something done rather than read. */
const MINIMAX_ACTION_PATH = "/plugins/dsh-connect-minimaxcode/action";
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
		...deps.usage === void 0 ? {} : { usage: deps.usage },
		...deps.signin === void 0 ? {} : { signin: deps.signin },
		...deps.login === void 0 ? {} : { login: deps.login }
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
/** Credit ledger endpoint: per-grant amounts and expiry. */
const CREDIT_DETAILS_PATH = "/minimax-cloud/api/v1/credit/details";
/** OAuth token endpoint. */
const TOKEN_PATH$1 = "/oauth2/token";
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
	const response = await fetchImpl(`${MINIMAX_AUTH_HOSTS[region]}${TOKEN_PATH$1}`, {
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
		const total = toNumber$1(entry.total_remaining_amount);
		if (total !== void 0) {
			const purchased = toNumber$1(entry.purchased_remaining_amount) ?? 0;
			return {
				total,
				purchased,
				free: toNumber$1(entry.free_remaining_amount) ?? total - purchased
			};
		}
	}
	const flat = toNumber$1(record.opcredit_balance) ?? toNumber$1(record.total_remains_credit);
	return flat === void 0 ? void 0 : {
		total: flat,
		purchased: 0,
		free: flat
	};
}
/** Read a numeric field the upstream may send as a string. */
function toNumber$1(value) {
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
* Read the credit lots out of a ledger response.
*
* Lots that carry no expiry are ignored: a lot without an expiry date would
* otherwise be treated as one that never expires.
*/
function parseCreditLots(document) {
	if (typeof document !== "object" || document === null) return [];
	const details = document.details;
	if (!Array.isArray(details)) return [];
	const lots = [];
	for (const entry of details) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry;
		const expireAtMs = toNumber$1(record.expire_at_ms);
		if (expireAtMs === void 0) continue;
		const granted = toNumber$1(record.granted_amount) ?? 0;
		const remaining = toNumber$1(record.remaining_amount) ?? 0;
		lots.push({
			granted,
			remaining,
			consumed: toNumber$1(record.consumed_amount) ?? Math.max(0, granted - remaining),
			grantedAtMs: toNumber$1(record.granted_at_ms) ?? 0,
			expireAtMs,
			creditType: toNumber$1(record.credit_type)
		});
	}
	return lots.sort((a, b) => a.expireAtMs - b.expireAtMs);
}
/**
* Fetch the credit ledger.
*
* The ledger is paginated, and the page parameter is `page_number` — `page`
* is accepted and then ignored, which would make every page return the same
* rows. The page size is capped upstream at 100.
*
* The default view already excludes expired grants, which is what this wants:
* a grant that expired has nothing left to lose.
*/
async function fetchCreditLots(credential, region, fetchImpl = fetch) {
	const pageSize = 100;
	const lots = [];
	let page = 1;
	let total = Number.POSITIVE_INFINITY;
	while (lots.length < total && page <= 50) {
		const response = await fetchImpl(`${MINIMAX_ACCOUNT_HOSTS[region]}${CREDIT_DETAILS_PATH}?page_number=${page}&page_size=${pageSize}`, { headers: { authorization: `Bearer ${credential.token}` } });
		if (!response.ok) throw new Error(`credit ledger request failed: HTTP ${response.status}`);
		const document = await response.json();
		const batch = parseCreditLots(document);
		const before = lots.length;
		lots.push(...batch);
		const count = toNumber$1(document.total_count);
		if (count !== void 0) total = count;
		if (batch.length < pageSize) break;
		if (lots.length === before) break;
		page += 1;
	}
	return lots;
}
/**
* Summarize what is about to expire.
*
* Only lots that still hold credits count: a lot that was granted and used up
* expires with nothing to lose, and counting it would make every account look
* like it is about to lose credits.
*/
function summarizeExpiry(lots, now = Date.now()) {
	const alive = lots.filter((lot) => lot.remaining > 0 && lot.expireAtMs > now);
	const within = (days) => alive.filter((lot) => lot.expireAtMs - now <= days * 864e5);
	const week = within(7);
	const month = within(30);
	return {
		expiring: week.reduce((sum, lot) => sum + lot.remaining, 0),
		expiringLots: week.length,
		expiringSoon: month.reduce((sum, lot) => sum + lot.remaining, 0),
		nextExpiryAtMs: alive[0]?.expireAtMs,
		upcoming: alive.slice(0, 5).map((lot) => ({
			amount: lot.remaining,
			expireAtMs: lot.expireAtMs
		})),
		totalRemaining: lots.reduce((sum, lot) => sum + lot.remaining, 0)
	};
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
	#lots = [];
	#expiry;
	#ledgerAtMs;
	#ledgerError;
	/** The balance as last read. */
	get snapshot() {
		return this.#snapshot;
	}
	/** Why the last read failed, when one did. */
	get error() {
		return this.#error;
	}
	/** The credit lots as last read. */
	get lots() {
		return this.#lots;
	}
	/** What the lots say about expiry, when the ledger could be read. */
	get expiry() {
		return this.#expiry;
	}
	/** When the ledger was last read. */
	get ledgerAtMs() {
		return this.#ledgerAtMs;
	}
	/** Why the ledger could not be read, when it could not. */
	get ledgerError() {
		return this.#ledgerError;
	}
	/**
	* Read the balance and record how much was consumed since the last read.
	*
	* The credit ledger is read alongside it, but a ledger that cannot be read
	* never hides the balance: the two come from different endpoints and only
	* the balance is essential.
	*
	* @returns Whether the balance changed.
	*/
	async refresh(credential, region, fetchImpl = fetch, now = Date.now()) {
		let changed = false;
		try {
			const summary = await fetchCreditSummary(credential, region, fetchImpl);
			if (summary === void 0) this.#error = "membership response carried no credit summary";
			else {
				const previous = this.#snapshot;
				this.#snapshot = {
					summary,
					fetchedAtMs: now,
					consumed: previous === void 0 ? 0 : previous.summary.total - summary.total
				};
				this.#error = void 0;
				changed = previous === void 0 || previous.summary.total !== summary.total;
			}
		} catch (error) {
			this.#error = error instanceof Error ? error.message : String(error);
		}
		await this.refreshLedger(credential, region, fetchImpl, now);
		return changed;
	}
	/**
	* Read the credit ledger and work out what is about to expire.
	*
	* A failure here is remembered but never thrown: the balance is what the
	* user needs most, and a ledger that is temporarily unavailable must not
	* take it down with it.
	*/
	async refreshLedger(credential, region, fetchImpl = fetch, now = Date.now()) {
		try {
			const lots = await fetchCreditLots(credential, region, fetchImpl);
			this.#lots = lots;
			this.#expiry = summarizeExpiry(lots, now);
			this.#ledgerAtMs = now;
			this.#ledgerError = void 0;
		} catch (error) {
			this.#ledgerError = error instanceof Error ? error.message : String(error);
		}
	}
};
//#endregion
//#region src/credentials.ts
/**
* The plugin's own credential and state.
*
* The desktop app signs in with the OAuth 2.0 device authorization grant
* (RFC 8628): the app asks the authorization server for a device code, opens
* the account page in the browser, and polls the token endpoint until the
* person signed in. The plugin can run the same grant itself, which means the
* plugin works on a machine where the desktop app was never installed, and
* the only human step is the person signing in to their own account in their
* own browser.
*
* What this module stores is deliberately *not* written into the desktop
* app's files. The app keeps two files whose `generation` counters must stay
* in step, and it treats a mismatch as "signed in somewhere else" and demands
* a new sign-in; the plugin has no business writing there. So the plugin keeps
* its own copy under the Harness home, next to the files the sibling desktop
* connectors keep (`~/.dsh/.minimaxcode-auth.json`).
*
* @module dsh-connect-minimaxcode/credentials
*/
/** The file the plugin's own credential lives in. */
const PLUGIN_CREDENTIAL_FILENAME = ".minimaxcode-auth.json";
/** The file the plugin's own settings and session live in. */
const PLUGIN_STATE_FILENAME = ".minimaxcode-state.json";
/**
* The Harness home.
*
* The host resolves it the same way: the `DSH_HOME` environment variable when
* it is set, otherwise `~/.dsh`. The plugin resolves it on its own rather
* than importing the host's helper, so it also works in a plain command line
* where the host's packages are not installed.
*/
function dshHome(env = process.env) {
	const override = env.DSH_HOME;
	return typeof override === "string" && override.length > 0 ? override : join(homedir(), ".dsh");
}
/** Where the plugin's credential lives. */
function pluginCredentialPath(env = process.env) {
	return join(dshHome(env), PLUGIN_CREDENTIAL_FILENAME);
}
/** Where the plugin's state lives. */
function pluginStatePath(env = process.env) {
	return join(dshHome(env), PLUGIN_STATE_FILENAME);
}
/** Write a document atomically, readable by its owner only. */
async function writePrivate(path, payload) {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp`;
	await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 384 });
	await rename(temporary, path);
}
/** Read the plugin's own credential. */
async function readPluginCredential(env = process.env) {
	let text;
	try {
		text = await readFile(pluginCredentialPath(env), "utf8");
	} catch {
		return;
	}
	let document;
	try {
		document = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof document !== "object" || document === null) return void 0;
	const record = document;
	const accessToken = record.accessToken;
	if (typeof accessToken !== "string" || accessToken.length === 0) return void 0;
	const expiresAtMs = typeof record.expiresAtMs === "number" ? record.expiresAtMs : void 0;
	return {
		schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : 1,
		clientId: typeof record.clientId === "string" ? record.clientId : MINIMAX_OAUTH_CLIENT_ID,
		scopes: Array.isArray(record.scopes) ? record.scopes.filter((s) => typeof s === "string") : [...MINIMAX_OAUTH_SCOPES],
		audience: typeof record.audience === "string" ? record.audience : MINIMAX_OAUTH_AUDIENCE,
		accessToken,
		refreshToken: typeof record.refreshToken === "string" ? record.refreshToken : void 0,
		expiresAtMs,
		obtainedAtMs: typeof record.obtainedAtMs === "number" ? record.obtainedAtMs : void 0
	};
}
/** Write the plugin's own credential. */
async function writePluginCredential(credential, env = process.env) {
	await writePrivate(pluginCredentialPath(env), credential);
}
/** Read the plugin's own state. */
async function readPluginState(env = process.env) {
	let text;
	try {
		text = await readFile(pluginStatePath(env), "utf8");
	} catch {
		return {
			schemaVersion: 1,
			autoCheckin: false
		};
	}
	let document;
	try {
		document = JSON.parse(text);
	} catch {
		return {
			schemaVersion: 1,
			autoCheckin: false
		};
	}
	if (typeof document !== "object" || document === null) return {
		schemaVersion: 1,
		autoCheckin: false
	};
	const record = document;
	const session = record.deviceLogin;
	const deviceLogin = typeof session === "object" && session !== null ? (() => {
		const value = session;
		if (typeof value.deviceCode !== "string" || typeof value.codeVerifier !== "string") return void 0;
		return {
			deviceCode: value.deviceCode,
			codeVerifier: value.codeVerifier,
			userCode: typeof value.userCode === "string" ? value.userCode : "",
			verificationUri: typeof value.verificationUri === "string" ? value.verificationUri : "",
			verificationUriComplete: typeof value.verificationUriComplete === "string" ? value.verificationUriComplete : "",
			expiresAtMs: typeof value.expiresAtMs === "number" ? value.expiresAtMs : 0
		};
	})() : void 0;
	return {
		schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : 1,
		autoCheckin: record.autoCheckin === true,
		lastClaimDay: typeof record.lastClaimDay === "string" ? record.lastClaimDay : void 0,
		lastClaimAtMs: typeof record.lastClaimAtMs === "number" ? record.lastClaimAtMs : void 0,
		lastClaimPoints: typeof record.lastClaimPoints === "number" ? record.lastClaimPoints : void 0,
		deviceLogin
	};
}
/** Write the plugin's own state. */
async function writePluginState(state, env = process.env) {
	await writePrivate(pluginStatePath(env), state);
}
/** Whether the credential is close enough to expiry to be worth refreshing. */
function credentialNeedsRefresh(credential, now = Date.now()) {
	if (credential.expiresAtMs === void 0) return false;
	return credential.expiresAtMs - now <= 12e4;
}
/** The credential in the shape the account endpoints expect. */
function toOAuthCredential(credential) {
	return {
		token: credential.accessToken,
		refreshToken: credential.refreshToken,
		expiresAtMs: credential.expiresAtMs,
		clientId: credential.clientId,
		scopes: credential.scopes,
		audience: credential.audience
	};
}
//#endregion
//#region src/login.ts
/**
* Signing in without the desktop app.
*
* The desktop app's only sign-in is the OAuth 2.0 device authorization grant
* (RFC 8628). The plugin runs the same grant:
*
* 1. `POST /oauth2/device/code` asks for a device code. The answer carries a
*    short `user_code` and the page where the person authorizes it.
* 2. The person opens that page, signs in to their own MiniMax account, and
*    approves the request.
* 3. `POST /oauth2/token` is polled with the device code until the grant
*    arrives.
*
* The plugin never sees a password and never sees a verification code: the
* one human step happens in the person's own browser, on the account site.
* PKCE is used, so a device code that leaks cannot be redeemed without the
* verifier that never left this process.
*
* The token this produces is the same `mmoat_` token the desktop app holds.
* The account endpoints need it, and the model gateway accepts it too — so
* one sign-in is enough for models, credits and the daily grant.
*
* @module dsh-connect-minimaxcode/login
*/
/** The endpoint that issues device codes. */
const DEVICE_CODE_PATH = "/oauth2/device/code";
/** The endpoint that exchanges a device code for a token. */
const TOKEN_PATH = "/oauth2/token";
/** The device authorization grant type. */
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/**
* Make a PKCE verifier and its S256 challenge.
*
* The verifier is 43 characters of base64url entropy, which is what RFC 7636
* asks for, and it never leaves this process.
*/
function makePkce() {
	const verifier = randomBytes(32).toString("base64url");
	return {
		verifier,
		challenge: createHash("sha256").update(verifier).digest("base64url")
	};
}
/**
* Ask for a device code.
*
* @returns The session the person authorizes, or `undefined` when the server
*   would not issue one.
*/
async function startDeviceLogin(region, fetchImpl = fetch, now = Date.now()) {
	const { verifier, challenge } = makePkce();
	const response = await fetchImpl(`${MINIMAX_AUTH_HOSTS[region]}${DEVICE_CODE_PATH}`, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/x-www-form-urlencoded"
		},
		body: new URLSearchParams({
			client_id: MINIMAX_OAUTH_CLIENT_ID,
			scope: MINIMAX_OAUTH_SCOPES.join(" "),
			audience: MINIMAX_OAUTH_AUDIENCE,
			code_challenge: challenge,
			code_challenge_method: "S256"
		})
	});
	if (!response.ok) throw new Error(`申请设备码失败: HTTP ${response.status}`);
	const document = await response.json();
	const deviceCode = document.device_code;
	const userCode = document.user_code;
	const verificationUri = document.verification_uri;
	if (typeof deviceCode !== "string" || deviceCode.length === 0) throw new Error("设备码响应里没有 device_code");
	const expiresInSec = typeof document.expires_in === "number" ? document.expires_in : 300;
	const intervalSec = typeof document.interval === "number" ? document.interval : 3;
	return {
		deviceCode,
		codeVerifier: verifier,
		userCode: typeof userCode === "string" ? userCode : "",
		verificationUri: typeof verificationUri === "string" ? verificationUri : "",
		verificationUriComplete: typeof document.verification_uri_complete === "string" ? document.verification_uri_complete : "",
		expiresAtMs: now + expiresInSec * 1e3,
		intervalSec
	};
}
/** Read the token document the authorization server answers with. */
function readToken(document) {
	if (typeof document !== "object" || document === null) return void 0;
	const record = document;
	const accessToken = record.access_token;
	if (typeof accessToken !== "string" || accessToken.length === 0) return void 0;
	return {
		token: accessToken,
		refreshToken: typeof record.refresh_token === "string" ? record.refresh_token : void 0,
		expiresInSec: typeof record.expires_in === "number" ? record.expires_in : void 0,
		scope: typeof record.scope === "string" ? record.scope : void 0
	};
}
/**
* Poll for the grant.
*
* The authorization server answers `400` while the person has not authorized
* yet, with `authorization_pending` in the body; that is a normal answer, not
* an error.
*/
async function pollDeviceLogin(session, region, fetchImpl = fetch, now = Date.now()) {
	if (session.expiresAtMs !== 0 && session.expiresAtMs <= now) return {
		state: "expired",
		message: "设备码已过期，请重新发起登录"
	};
	const response = await fetchImpl(`${MINIMAX_AUTH_HOSTS[region]}${TOKEN_PATH}`, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/x-www-form-urlencoded"
		},
		body: new URLSearchParams({
			client_id: MINIMAX_OAUTH_CLIENT_ID,
			grant_type: DEVICE_CODE_GRANT,
			device_code: session.deviceCode,
			code_verifier: session.codeVerifier
		})
	});
	const text = await response.text();
	let document;
	try {
		document = JSON.parse(text);
	} catch {
		document = void 0;
	}
	if (response.ok) {
		const token = readToken(document);
		if (token === void 0) return {
			state: "expired",
			message: "登录响应里没有访问令牌"
		};
		return {
			state: "signed-in",
			credential: {
				schemaVersion: 1,
				clientId: MINIMAX_OAUTH_CLIENT_ID,
				scopes: [...MINIMAX_OAUTH_SCOPES],
				audience: MINIMAX_OAUTH_AUDIENCE,
				accessToken: token.token,
				refreshToken: token.refreshToken,
				expiresAtMs: token.expiresInSec === void 0 ? void 0 : now + token.expiresInSec * 1e3,
				obtainedAtMs: now
			}
		};
	}
	const error = typeof document === "object" && document !== null ? document.error : void 0;
	const description = typeof document === "object" && document !== null ? document.error_description : void 0;
	const message = typeof description === "string" ? description : void 0;
	if (error === "authorization_pending") return { state: "pending" };
	if (error === "slow_down") return { state: "slow-down" };
	if (error === "expired_token") return {
		state: "expired",
		message
	};
	if (error === "access_denied") return {
		state: "denied",
		message
	};
	return {
		state: "expired",
		message: message ?? `登录失败: HTTP ${response.status}`
	};
}
/**
* Exchange the stored refresh token for a fresh access token.
*
* The authorization server rotates the refresh token, so the new pair
* replaces the old one wherever it is kept.
*/
async function refreshPluginCredential(credential, region, fetchImpl = fetch, now = Date.now()) {
	if (credential.refreshToken === void 0) throw new Error("没有可用于续期的 refresh token，请重新登录");
	const response = await fetchImpl(`${MINIMAX_AUTH_HOSTS[region]}${TOKEN_PATH}`, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/x-www-form-urlencoded"
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: credential.refreshToken,
			client_id: credential.clientId,
			scope: credential.scopes.join(" "),
			audience: credential.audience
		})
	});
	if (!response.ok) throw new Error(`续期失败: HTTP ${response.status}`);
	const token = readToken(await response.json());
	if (token === void 0) throw new Error("续期响应里没有访问令牌");
	return {
		...credential,
		accessToken: token.token,
		refreshToken: token.refreshToken ?? credential.refreshToken,
		expiresAtMs: token.expiresInSec === void 0 ? void 0 : now + token.expiresInSec * 1e3,
		obtainedAtMs: now
	};
}
//#endregion
//#region src/signin.ts
/**
* The daily check-in that grants the free credits.
*
* MiniMax Code hands out a grant of points every day, and the desktop app
* shows it as a "每日签到" card: a seven-day cycle worth 4000 points, each
* grant valid for thirty days. The app does **not** claim on its own — the
* card opens, and a button does the work — so an account that is only used
* through the model gateway leaves those points unclaimed.
*
* The endpoints are the same ones the card calls:
*
* - `GET /minimax-cloud/api/v1/signin/status` — the cycle, with today's day
*   marked
* - `POST /minimax-cloud/api/v1/signin/claim` — claim today
*
* Both need the account's `mmoat_` bearer token, and both need a **time zone
***: the server answers `invalid timezone_id` when the request carries an
* offset or nothing at all, and it is that time zone that decides which day
* "today" is. The client sends an IANA name (`Asia/Shanghai`), so this does
* too.
*
* The claim is the one request here that changes something upstream. It is
* idempotent per day — claiming again answers "already claimed" and grants
* nothing — but the caller still guards it, because "cannot double-grant" is
* a property of the upstream that is verified rather than assumed.
*
* @module dsh-connect-minimaxcode/signin
*/
/** The claim endpoint. */
const SIGNIN_CLAIM_PATH = "/minimax-cloud/api/v1/signin/claim";
/** The cycle endpoint, which reports the panel. */
const SIGNIN_PANEL_PATH = "/minimax-cloud/api/v1/signin/status";
/** Per-day status, as the desktop app enumerates it. */
const SIGNIN_DAY_STATUS = {
	/** The day has not come yet. */
	upcoming: 1,
	/** The day is today and can be claimed. */
	claimable: 2,
	/** The day is claimed. */
	claimed: 3,
	/** The day does not grant anything. */
	disabled: 4
};
/** How many days a cycle runs. */
const SIGNIN_CYCLE_DAYS = 7;
/** The outcome of a claim. */
const SIGNIN_CLAIM_RESULT = {
	/** The grant was credited. */
	credited: 1,
	/** Today was already claimed; nothing was granted. */
	alreadyClaimed: 2
};
/**
* The time zone the server should treat the request as coming from.
*
* The server wants an IANA name; an offset or a missing value is refused.
* The system's own name is the right answer, since "today" should be the
* user's today.
*/
function timezoneId() {
	try {
		const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return typeof resolved === "string" && resolved.length > 0 ? resolved : "UTC";
	} catch {
		return "UTC";
	}
}
/** Read a number the upstream may send as a string. */
function toNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
/**
* Unwrap the upstream's envelope.
*
* The account APIs answer `200` with a `base_resp` that carries the real
* status, so the HTTP code alone says nothing.
*/
function unwrap(document) {
	if (typeof document !== "object" || document === null) return {
		ok: false,
		message: "签到接口返回了无法解析的响应"
	};
	const record = document;
	const base = record.base_resp;
	if (typeof base === "object" && base !== null) {
		const status = toNumber(base.status_code);
		if (status !== void 0 && status !== 0) {
			const message = base.status_msg;
			return {
				ok: false,
				message: typeof message === "string" ? message : `签到接口返回状态码 ${status}`
			};
		}
	}
	return {
		ok: true,
		data: record.data
	};
}
/**
* Read the cycle out of a panel response.
*
* The server marks exactly one day as today and at most one day as claimable;
* a panel that says otherwise is not something to act on, so it is refused
* rather than half-believed.
*/
function parseSigninPanel(document) {
	const unwrapped = unwrap(document);
	if (!unwrapped.ok) return void 0;
	const data = unwrapped.data;
	if (typeof data !== "object" || data === null) return void 0;
	const record = data;
	const scene = toNumber(record.scene);
	const rawDays = record.days;
	if (scene === void 0 || !Array.isArray(rawDays)) return void 0;
	const days = [];
	let claimable = 0;
	let today = 0;
	for (const entry of rawDays) {
		if (typeof entry !== "object" || entry === null) continue;
		const day = entry;
		const dayNo = toNumber(day.day_no);
		const points = toNumber(day.points);
		const status = toNumber(day.status);
		if (dayNo === void 0 || points === void 0 || status === void 0) continue;
		if (status < 1 || status > 4) continue;
		const isToday = day.is_today === true;
		if (status === SIGNIN_DAY_STATUS.claimable) claimable += 1;
		if (isToday) today += 1;
		days.push({
			dayNo,
			points,
			bonusPoints: toNumber(day.bonus_points) ?? 0,
			status,
			isToday
		});
	}
	if (days.length === 0) return void 0;
	if (claimable > 1 || today > 1) return void 0;
	return {
		scene,
		days
	};
}
/** Read the result of a claim. */
function parseSigninClaim(document) {
	const unwrapped = unwrap(document);
	if (!unwrapped.ok) return void 0;
	const data = unwrapped.data;
	if (typeof data !== "object" || data === null) return void 0;
	const record = data;
	const claimId = record.claim_id;
	const result = toNumber(record.claim_result);
	const dayNo = toNumber(record.day_no);
	const points = toNumber(record.points);
	const expireAtMs = toNumber(record.expire_at_ms);
	if (typeof claimId !== "string" || claimId.length === 0) return void 0;
	if (result !== SIGNIN_CLAIM_RESULT.credited && result !== SIGNIN_CLAIM_RESULT.alreadyClaimed) return void 0;
	if (dayNo === void 0 || dayNo < 1 || dayNo > 7) return void 0;
	if (points === void 0 || points < 0) return void 0;
	if (expireAtMs === void 0) return void 0;
	return {
		claimId,
		result,
		dayNo,
		points,
		bonusPoints: toNumber(record.bonus_points) ?? 0,
		expireAtMs,
		panel: parseSigninPanel({ data: record.panel })
	};
}
/**
* Read the cycle.
*
* @returns The panel, or `undefined` when the account cannot read it.
*/
async function fetchSigninPanel(credential, region, fetchImpl = fetch, timezone = timezoneId()) {
	const response = await fetchImpl(`${MINIMAX_ACCOUNT_HOSTS[region]}${SIGNIN_PANEL_PATH}?timezone_id=${encodeURIComponent(timezone)}`, { headers: { authorization: `Bearer ${credential.token}` } });
	if (!response.ok) throw new Error(`签到状态请求失败: HTTP ${response.status}`);
	return parseSigninPanel(await response.json());
}
/**
* Claim today's grant.
*
* This is the only request in the plugin that changes something upstream. It
* grants the day's points, which expire thirty days later.
*
* @returns What the server answered, or `undefined` when it refused.
*/
async function claimSignin(credential, region, fetchImpl = fetch, timezone = timezoneId()) {
	const response = await fetchImpl(`${MINIMAX_ACCOUNT_HOSTS[region]}${SIGNIN_CLAIM_PATH}?timezone_id=${encodeURIComponent(timezone)}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${credential.token}`,
			"content-type": "application/json"
		},
		body: JSON.stringify({})
	});
	if (!response.ok) throw new Error(`签到请求失败: HTTP ${response.status}`);
	return parseSigninClaim(await response.json());
}
/** The day's key in the account's own time zone, `YYYY-MM-DD`. */
function localDay(now = Date.now(), timezone = timezoneId()) {
	try {
		return new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit"
		}).format(new Date(now));
	} catch {
		return new Date(now).toISOString().slice(0, 10);
	}
}
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
* How often the check-in cycle may be re-read.
*
* The cycle changes once a day, so reading it as often as the balance is
* read would buy nothing but load on the account API.
*/
const SIGNIN_TTL_MS = 3e5;
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
	let lastCatalogAtMs = 0;
	let lastCreditAtMs = 0;
	let lastSigninAtMs = 0;
	let refreshing = false;
	let creditState = "unavailable";
	/** The token the model descriptors carry, refreshed with the credential. */
	let modelToken;
	/** The plugin's own settings, read from its own file. */
	let pluginState = {
		schemaVersion: 1,
		autoCheckin: false
	};
	/** The cycle as the account last reported it. */
	let signinPanel;
	/** What the last claim answered. */
	let signinClaim;
	/** Why the cycle or the claim could not be read. */
	let signinError;
	/** Where the sign-in came from. */
	let loginSource;
	/** Whether a device login is waiting to be authorized. */
	let loginPending = false;
	/**
	* The credential the model gateway is called with.
	*
	* The plugin's own sign-in comes first: it is the credential the person
	* chose, and on a machine where the desktop app was never installed it is
	* the only one there is. The desktop app's token is the fallback, and the
	* two are interchangeable as far as the gateway is concerned — it accepts
	* either bearer.
	*/
	const resolveGatewayCredential = async () => {
		const own = await readPluginCredential();
		if (own !== void 0) {
			if (credentialNeedsRefresh(own)) try {
				const next = await refreshPluginCredential(own, region);
				await writePluginCredential(next);
				loginSource = "plugin";
				modelToken = next.accessToken;
				return {
					token: next.accessToken,
					claims: { exp: Math.floor((next.expiresAtMs ?? Date.now()) / 1e3) }
				};
			} catch {}
			else {
				loginSource = "plugin";
				modelToken = own.accessToken;
				return {
					token: own.accessToken,
					claims: { exp: Math.floor((own.expiresAtMs ?? Date.now()) / 1e3) }
				};
			}
		}
		const state = await readCredential();
		if (state.state !== "signed-in") {
			loginSource = void 0;
			modelToken = void 0;
			return;
		}
		loginSource = "desktop-app";
		modelToken = state.credential.token;
		return state.credential;
	};
	/**
	* The credential the account endpoints are called with.
	*
	* The account API needs the `mmoat_` token, not the gateway's JWT, so this
	* is a second credential: the plugin's own sign-in when there is one, and
	* otherwise the token the desktop app stored.
	*/
	const resolveAccountCredential = async (now = Date.now()) => {
		const own = await readPluginCredential();
		if (own !== void 0) {
			if (credentialNeedsRefresh(own, now)) try {
				const next = await refreshPluginCredential(own, region, fetch, now);
				await writePluginCredential(next);
				return {
					state: "signed-in",
					credential: toOAuthCredential(next)
				};
			} catch {
				return {
					state: "expired",
					credential: toOAuthCredential(own)
				};
			}
			return {
				state: "signed-in",
				credential: toOAuthCredential(own)
			};
		}
		return ensureOAuthCredential(region, process.env, now);
	};
	const readNow = async () => {
		const state = await resolveGatewayCredential();
		if (state === void 0) {
			catalog.invalidate();
			return;
		}
		return state;
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
		const state = await resolveAccountCredential(now);
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
	/**
	* Read the check-in cycle, and claim the day's grant when asked to.
	*
	* The claim is the one request here that changes something upstream. It is
	* made at most once a day, only when the person turned it on, and only when
	* the server itself says the day can be claimed — so a day that is already
	* claimed never produces a request, and a claim that already happened
	* upstream is answered with "already claimed" and grants nothing.
	*/
	const refreshSignin = async () => {
		const now = Date.now();
		if (now - lastSigninAtMs < SIGNIN_TTL_MS && signinPanel !== void 0) return;
		lastSigninAtMs = now;
		const state = await resolveAccountCredential();
		if (state.state !== "signed-in") {
			signinPanel = void 0;
			return;
		}
		let panel;
		try {
			panel = await fetchSigninPanel(state.credential, region, fetch);
			signinPanel = panel;
			signinError = void 0;
		} catch (error) {
			signinError = error instanceof Error ? error.message : String(error);
			return;
		}
		if (!pluginState.autoCheckin || panel === void 0) return;
		const today = panel.days.find((day) => day.isToday);
		if (today === void 0 || today.status !== SIGNIN_DAY_STATUS.claimable) return;
		if (pluginState.lastClaimDay === localDay()) return;
		await performClaim(state.credential);
	};
	/** Claim today's grant and remember that it happened. */
	const performClaim = async (credential) => {
		try {
			const claim = await claimSignin(credential, region, fetch);
			if (claim === void 0) {
				signinError = "签到接口没有返回可识别的结果";
				return;
			}
			signinClaim = claim;
			signinError = void 0;
			if (claim.panel !== void 0) signinPanel = claim.panel;
			pluginState = {
				...pluginState,
				lastClaimDay: localDay(),
				lastClaimAtMs: Date.now(),
				lastClaimPoints: claim.points
			};
			await writePluginState(pluginState);
			lastCreditAtMs = 0;
			refreshCredits();
			return claim;
		} catch (error) {
			signinError = error instanceof Error ? error.message : String(error);
			return;
		}
	};
	/** The credit balance as the card and the browser half read it. */
	const buildCreditStatus = () => {
		const snapshot = credits.snapshot;
		const expiry = credits.expiry;
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
			updatedAtMs: snapshot.fetchedAtMs,
			...expiry === void 0 ? {} : {
				expiring: expiry.expiring,
				expiringLots: expiry.expiringLots,
				expiringSoon: expiry.expiringSoon,
				nextExpiryAtMs: expiry.nextExpiryAtMs,
				upcoming: expiry.upcoming
			},
			...credits.ledgerAtMs === void 0 ? {} : { ledgerAtMs: credits.ledgerAtMs },
			...credits.ledgerError === void 0 ? {} : { ledgerError: credits.ledgerError }
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
	/** The check-in cycle, as the card reads it. */
	const buildSigninStatus = () => {
		if (signinPanel === void 0 && signinError === void 0) return void 0;
		const panel = signinPanel;
		const today = panel?.days.find((day) => day.isToday);
		return {
			state: panel === void 0 ? "unavailable" : "ok",
			...today === void 0 ? {} : { today: {
				dayNo: today.dayNo,
				points: today.points,
				status: today.status,
				claimable: today.status === SIGNIN_DAY_STATUS.claimable,
				claimed: today.status === SIGNIN_DAY_STATUS.claimed
			} },
			...panel === void 0 ? {} : {
				days: panel.days.map((day) => ({
					dayNo: day.dayNo,
					points: day.points,
					status: day.status,
					isToday: day.isToday
				})),
				cyclePoints: panel.days.reduce((sum, day) => sum + day.points, 0)
			},
			autoCheckin: pluginState.autoCheckin,
			...pluginState.lastClaimDay === void 0 ? {} : { lastClaimDay: pluginState.lastClaimDay },
			...pluginState.lastClaimAtMs === void 0 ? {} : { lastClaimAtMs: pluginState.lastClaimAtMs },
			...pluginState.lastClaimPoints === void 0 ? {} : { lastClaimPoints: pluginState.lastClaimPoints },
			...signinClaim === void 0 ? {} : {
				lastClaimResult: signinClaim.result,
				lastClaimPoints: signinClaim.points
			},
			...signinError === void 0 ? {} : { error: signinError }
		};
	};
	/** How the plugin is signed in, as the card reads it. */
	const buildLoginStatus = () => {
		const session = pluginState.deviceLogin;
		const pending = loginPending && session !== void 0;
		return {
			state: pending ? "pending" : loginSource === void 0 ? "signed-out" : "signed-in",
			...loginSource === void 0 ? {} : { source: loginSource },
			...pending && session !== void 0 ? {
				userCode: session.userCode,
				verificationUri: session.verificationUri,
				verificationUriComplete: session.verificationUriComplete,
				expiresAtMs: session.expiresAtMs
			} : {}
		};
	};
	const { adapter, invalidate } = createMinimaxCodeAdapter({
		catalog,
		region: () => region,
		resolveApiKey: async () => (await readNow())?.token,
		bearerToken: () => modelToken,
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
		await refreshSignin();
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
			usage: buildUsageStatus(),
			signin: buildSigninStatus(),
			login: buildLoginStatus()
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
	/**
	* The actions the card can ask for.
	*
	* Every one of them is a request the person made by clicking something, so
	* they are all safe to repeat: a claim that was already made upstream
	* answers "already claimed", and a sign-in that is already waiting answers
	* with the same device code.
	*/
	const runAction = async (action, body) => {
		switch (action) {
			case "claim": {
				const state = await resolveAccountCredential();
				if (state.state !== "signed-in") return {
					ok: false,
					state: state.state,
					error: "尚未登录"
				};
				const claim = await performClaim(state.credential);
				return claim === void 0 ? {
					ok: false,
					error: signinError ?? "签到失败"
				} : {
					ok: true,
					claim,
					panel: signinPanel
				};
			}
			case "login-start": {
				const session = await startDeviceLogin(region);
				if (session === void 0) return {
					ok: false,
					error: "没有拿到设备码"
				};
				pluginState = {
					...pluginState,
					deviceLogin: session
				};
				await writePluginState(pluginState);
				loginPending = true;
				return {
					ok: true,
					userCode: session.userCode,
					verificationUri: session.verificationUri,
					verificationUriComplete: session.verificationUriComplete,
					expiresAtMs: session.expiresAtMs
				};
			}
			case "login-poll": {
				const session = pluginState.deviceLogin;
				if (session === void 0) return {
					ok: false,
					state: "signed-out",
					error: "没有待完成的登录"
				};
				const result = await pollDeviceLogin(session, region);
				if (result.state === "signed-in") {
					await writePluginCredential(result.credential);
					pluginState = {
						...pluginState,
						deviceLogin: void 0
					};
					await writePluginState(pluginState);
					loginPending = false;
					loginSource = "plugin";
					modelToken = result.credential.accessToken;
					catalog.invalidate();
					lastCatalogAtMs = 0;
					lastCreditAtMs = 0;
					readNow();
					return {
						ok: true,
						state: "signed-in"
					};
				}
				if (result.state === "expired" || result.state === "denied") {
					pluginState = {
						...pluginState,
						deviceLogin: void 0
					};
					await writePluginState(pluginState);
					loginPending = false;
					return {
						ok: false,
						state: result.state,
						error: result.message
					};
				}
				return {
					ok: true,
					state: result.state
				};
			}
			case "settings": {
				const autoCheckin = body.autoCheckin;
				if (typeof autoCheckin !== "boolean") return {
					ok: false,
					error: "autoCheckin 必须是布尔值"
				};
				pluginState = {
					...pluginState,
					autoCheckin
				};
				await writePluginState(pluginState);
				if (autoCheckin) refreshSignin();
				return {
					ok: true,
					autoCheckin
				};
			}
			default: return {
				ok: false,
				error: `未知操作: ${action}`
			};
		}
	};
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
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: MINIMAX_ACTION_PATH,
			handler: async (req, res) => {
				if (!isLoopback(req.headers.host)) {
					res.writeHead(403, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "loopback only" }));
					return;
				}
				if (req.method !== "POST") {
					res.writeHead(405, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "POST only" }));
					return;
				}
				let action = "";
				let body = {};
				try {
					action = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("action") ?? "";
					const text = await readRequestBody(req);
					if (text.length > 0) {
						const parsed = JSON.parse(text);
						if (typeof parsed === "object" && parsed !== null) body = parsed;
					}
				} catch {}
				try {
					const result = await runAction(action, body);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(result));
				} catch (error) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
				}
			}
		}));
	});
}
/** Read a request body, up to a size that no card needs to exceed. */
async function readRequestBody(req) {
	let text = "";
	for await (const chunk of req) {
		text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		if (text.length > 65536) break;
	}
	return text;
}
//#endregion
export { DEVICE_CODE_GRANT, DEVICE_CODE_PATH, EMPTY_USAGE, FALLBACK_MODELS, MEMBERSHIP_PATH, MINIMAXCODE_PROVIDER_ID, MINIMAX_AUTH_FILENAME, MINIMAX_DATA_DIR, MINIMAX_GATEWAYS, MINIMAX_OAUTH_CLIENT_ID, MINIMAX_REGIONS, MINIMAX_STATUS_PATH, MINIMAX_STREAM_IDLE_TIMEOUT_MS, MODEL_PRICES, MinimaxCatalog, MinimaxCredits, PLUGIN_CREDENTIAL_FILENAME, PLUGIN_STATE_FILENAME, SIGNIN_CLAIM_PATH, SIGNIN_CLAIM_RESULT, SIGNIN_CYCLE_DAYS, SIGNIN_DAY_STATUS, SIGNIN_PANEL_PATH, UsageMeter, apply, authPath, bearerToken, catalogUrl, chatBaseUrl, claimSignin, createMinimaxCodeAdapter, dataDir, daysRemaining, decodeClaims, dshHome, ensureOAuthCredential, estimateCny, expiresInMs, expiryLevel, fetchCreditSummary, fetchSigninPanel, inject, localDay, makePkce, name, parseAuthDocument, parseCatalog, parseCreditSummary, parseOAuthDocument, parseSigninClaim, parseSigninPanel, pluginCredentialPath, pluginStatePath, pollDeviceLogin, priceFor, readCredential, readOAuthCredential, readPluginCredential, readPluginState, refreshOAuthCredential, refreshPluginCredential, startDeviceLogin, statusDocument, timezoneId, writeOAuthCredential, writePluginCredential, writePluginState };
