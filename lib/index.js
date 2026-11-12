import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { LlmAdapter, resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
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
*
* The window is 1,000,000 rather than the 512,000 the upstream `limit` block
* reports: 512k is the billing tier boundary, and the gateway itself was
* measured serving 946,206 tokens before refusing ~1,050,000 with
* `invalid params, context window exceeds limit (2013)`.
*
* The reasoning modes are the upstream ones measured on 2026-11-10: `M3` is
* `switchable` and accepts `thinking: {type: "disabled"}`, `M3.1-Flash` is
* `forced_on` and refuses it. Encoding them here keeps the fallback honest
* about what the gateway accepts even when no catalog could be fetched.
*/
const FALLBACK_MODELS = [{
	id: "MiniMax-M3",
	name: "M3",
	contextWindow: 1e6,
	maxOutputTokens: 128e3,
	toolCall: true,
	reasoning: true,
	inputModalities: [
		"text",
		"image",
		"video"
	],
	attachment: true,
	reasoningOptional: true
}, {
	id: "MiniMax-M3.1-Flash",
	name: "M3.1-Flash",
	contextWindow: 1e6,
	maxOutputTokens: 128e3,
	toolCall: true,
	reasoning: true,
	inputModalities: [
		"text",
		"image",
		"video"
	],
	attachment: true,
	reasoningOptional: false
}];
/** Whether two effort level lists name the same levels in the same order. */
function sameEffortLevels(a, b) {
	if (a === void 0 || b === void 0) return a === b;
	return a.length === b.length && a.every((value, index) => value === b[index]);
}
/** Model with the same id, from a newer snapshot. */
function sameCatalog(a, b) {
	if (a.length !== b.length) return false;
	return a.every((model, index) => {
		const other = b[index];
		return model.id === other.id && model.contextWindow === other.contextWindow && model.toolCall === other.toolCall && model.reasoning === other.reasoning && model.attachment === other.attachment && model.reasoningOptional === other.reasoningOptional && sameEffortLevels(model.effortLevels, other.effortLevels);
	});
}
/** Keep only models whose id the upstream keys them by. */
function usable(id, raw) {
	return id.length > 0 && id.startsWith("MiniMax-") && typeof raw === "object" && raw !== null;
}
/**
* The window the gateway actually enforces.
*
* Upstream reports two different numbers, and they mean different things:
* `limit.context` is the *default* window — the billing tier boundary, above
* which input costs more — while `context_window_options` lists every window
* the gateway will accept, the largest being the hard ceiling.
*
* Measured against the live gateway on 2026-10-25: a prompt of 946,206 tokens
* was served normally, and one of ~1,050,000 was refused with
* `invalid params, context window exceeds limit (2013)`. The ceiling is
* therefore the largest option, not `limit.context`.
*
* Declaring the default instead of the ceiling is not a cosmetic difference:
* the adapter compares the gateway's own token count against this number, so a
* conversation that runs past 512k is reported as a context overflow on every
* turn even though the gateway answers it perfectly well.
*
* @param raw - The upstream model entry.
* @param limit - The upstream `limit` block, already read.
* @returns The window to declare, in tokens.
*/
function readContextWindow(raw, limit) {
	const options = raw.context_window_options;
	if (Array.isArray(options)) {
		const sizes = options.filter((value) => typeof value === "number" && Number.isInteger(value) && value > 0);
		if (sizes.length > 0) return Math.max(...sizes);
	}
	return typeof limit.context === "number" ? limit.context : 2e5;
}
/**
* Read upstream's `thinking_config.mode`.
*
* `switchable` is the only mode whose reasoning can be turned off; every
* other value — including a missing block, which the gateway treats as
* mandatory reasoning — leaves the model's reasoning required.
*
* @param raw - The upstream model entry.
* @returns Whether reasoning is optional, or undefined when upstream said nothing.
*/
function readReasoningOptional(raw) {
	const mode = (raw.thinking_config ?? {}).mode;
	if (mode === "switchable") return true;
	if (mode === "forced_on") return false;
}
/**
* Read upstream's `effort_options`.
*
* The levels are recorded as upstream names them; nothing maps them onto a
* request yet, because pi-ai's level mapping dispatches the budget form for
* these models and the effort levels would need the adaptive form to travel.
*
* @param raw - The upstream model entry.
* @returns The declared levels, or undefined when upstream declares none.
*/
function readEffortLevels(raw) {
	const options = raw.effort_options;
	if (!Array.isArray(options)) return void 0;
	const names = options.filter((value) => typeof value === "string");
	return names.length > 0 ? names : void 0;
}
/** Read the fields the upstream sends, tolerating their absence. */
function readModel(id, raw) {
	const limit = raw.limit ?? {};
	const modalities = raw.modalities ?? {};
	const input = Array.isArray(modalities.input) ? modalities.input.filter((m) => typeof m === "string") : ["text"];
	const contextWindow = readContextWindow(raw, limit);
	return {
		id,
		name: typeof raw.name === "string" ? raw.name : id,
		contextWindow,
		maxOutputTokens: typeof limit.output === "number" ? limit.output : void 0,
		toolCall: raw.tool_call === true,
		reasoning: raw.reasoning === true,
		inputModalities: input,
		attachment: raw.attachment === true || input.includes("image"),
		reasoningOptional: readReasoningOptional(raw),
		effortLevels: readEffortLevels(raw)
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
* - `thinkingLevelMap.off` is how a model says "reasoning cannot be turned
*   off". pi-ai answers an explicit `thinkingEnabled: false` with
*   `thinking: {type: "disabled"}` whenever `off` is not `null`, and omits the
*   field entirely when it is. Which of the two a model needs is upstream's
*   call, not this plugin's: `thinking_config.mode` is `switchable` for a model
*   that accepts the disabled form and `forced_on` for one that refuses it with
*   `400 ... requires adaptive thinking` (both measured on 2026-11-10). So the
*   restriction is declared only where it is real — pinning `off` to `null` for
*   a switchable model would make its reasoning impossible to turn off, and
*   leaving it unset for a forced_on model would make the gateway answer 400.
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
		...model.reasoning ? model.reasoningOptional === true ? {} : { thinkingLevelMap: { off: null } } : {}
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
		auth: INERT_AUTH,
		...options.resolveAttachments === void 0 ? {} : { resolveAttachments: options.resolveAttachments },
		...options.resolveImageAccess === void 0 ? {} : { resolveImageAccess: options.resolveImageAccess }
	});
	return {
		adapter: options.onUsage === void 0 ? inner : new MeteredAdapter(inner, options.onUsage),
		invalidate: () => {
			profiles = buildProfiles();
		}
	};
}
//#endregion
//#region src/image-input.ts
/**
* Build the two image-input hooks from the services the host provides.
*
* Both services are read per request through `ctx.get` rather than declared as
* startup injections: they may be provided after this plugin loads, and a host
* without them must still start and serve text. A host that provides no
* attachment store simply keeps refusing images, which is the old behaviour
* rather than a new failure.
*
* `resolveImageAccess` is what lets a model read the normalized image from a
* tool as well as see it inline. It degrades to `undefined` when the host
* exposes no host-path mapping, and the adapter then reports no local copy.
*
* @param ctx - the plugin fiber whose services are read.
* @returns The optional {@link AdapterOptions} hooks, ready to spread.
*/
function imageInputHooks(ctx) {
	return {
		resolveAttachments: () => ctx.get("attachments"),
		resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath), ref)
	};
}
//#endregion
//#region src/status-route.ts
/** Route this plugin mounts, matching its settings card. */
const MINIMAX_STATUS_PATH = "/plugins/dsh-connect-minimaxcode/status";
/** Route the card posts to when it wants something done rather than read. */
const MINIMAX_ACTION_PATH = "/plugins/dsh-connect-minimaxcode/action";
/**
* Route the card posts to when it wants a picture or a video made.
*
* It is a route of its own rather than another action because generation is
* expensive and asynchronous: an action answers at once, while a video task
* takes a minute and a half and is polled.
*/
const MINIMAX_GENERATE_PATH = "/plugins/dsh-connect-minimaxcode/generate";
/**
* Route the card reports what the host offers it on.
*
* Delivering a generated picture into a conversation needs several pieces of
* the host — the session, its face, the input box's attachment channel — and
* they are handed over in different ways. Reporting what is actually there
* turns "it did not work" into "this piece is missing", which is the only
* useful answer when something like that goes wrong.
*/
const MINIMAX_CAPABILITY_PATH = "/plugins/dsh-connect-minimaxcode/capability";
const HINTS = {
	"app-missing": "未找到 MiniMax Code 的登录信息。请先安装并登录 MiniMax Code 桌面 App，然后重启 DSH。",
	"not-signed-in": "MiniMax Code 尚未登录。请在 MiniMax Code 桌面 App 中登录后重启 DSH。",
	unreadable: "登录信息文件无法读取。请确认 MiniMax Code 仍处于登录状态。",
	malformed: "登录令牌格式无法解析。请在 MiniMax Code 中重新登录后重启 DSH。",
	"credential-revoked": "登录凭据已被服务器撤销，模型请求无法通过。请点击下方登录按钮重新登录 MiniMax Code。",
	"credential-expired": "登录凭据已过期。请点击下方登录按钮重新登录 MiniMax Code。"
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
		...deps.rateLimit === void 0 ? {} : { rateLimit: deps.rateLimit },
		...deps.usage === void 0 ? {} : { usage: deps.usage },
		...deps.signin === void 0 ? {} : { signin: deps.signin },
		...deps.login === void 0 ? {} : { login: deps.login },
		...deps.usageProfile === void 0 ? {} : { usageProfile: deps.usageProfile },
		...deps.plan === void 0 ? {} : { plan: deps.plan },
		...deps.capability === void 0 ? {} : { capability: deps.capability },
		...deps.generation === void 0 ? {} : { generation: deps.generation }
	};
	if (auth.state === "expired") return {
		...base,
		expiry: "expired",
		daysRemaining: 0,
		hint: HINTS[auth.reason ?? ""] ?? "登录令牌已过期。请打开并登录 MiniMax Code 桌面 App 以获取新令牌，然后重启 DSH。"
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
//#region src/generation.ts
/** Open-platform API host per region. */
const MINIMAX_API_HOSTS = {
	cn: "https://api.minimax.cn",
	io: "https://api.minimaxi.com",
	com: "https://api.minimaxi.com"
};
/** Image generation endpoint: the documented OpenAI-style path. */
const IMAGE_GENERATIONS_PATH = "/v1/images/generations";
/** The endpoint that hands out the account's open-platform key. */
const PLAN_CREDIT_PATH = "/backend/account/token_plan_credit";
/** The host the plan key comes from, per region. */
const PLAN_CREDIT_HOSTS = {
	cn: "https://www.minimaxi.com",
	io: "https://www.minimaxi.com",
	com: "https://www.minimaxi.com"
};
/** Video generation task endpoint. */
const VIDEO_GENERATION_PATH = "/v2/video_generation";
/** Video task query endpoint; the task id is the path segment. */
const VIDEO_QUERY_PATH = "/v2/query/video_generation";
/** The image models the endpoint serves. */
const IMAGE_MODELS = ["MiniMax-H3-Image", "MiniMax-H3-Image-Highspeed"];
/** The video model the endpoint serves. */
const VIDEO_MODEL = "MiniMax-H3";
/** Aspect ratios the desktop app offers for images. */
const IMAGE_ASPECT_RATIOS = [
	"auto",
	"16:9",
	"3:2",
	"4:3",
	"5:4",
	"1:1",
	"4:5",
	"3:4",
	"2:3",
	"9:16",
	"3:1",
	"1:3"
];
/** Output areas the endpoint serves. */
const IMAGE_AREAS = [
	"1K",
	"2K",
	"4K"
];
/** Aspect ratios the desktop app offers for video. */
const VIDEO_RATIOS = [
	"21:9",
	"16:9",
	"4:3",
	"1:1",
	"3:4",
	"9:16"
];
/** Output resolutions the endpoint serves for video. */
const VIDEO_RESOLUTIONS = ["768P", "2K"];
/** Durations the endpoint serves for video, in seconds. */
const VIDEO_DURATIONS = [
	5,
	6,
	7,
	8,
	9,
	10,
	11,
	12,
	13,
	14,
	15
];
/** A generation call that the upstream refused, with the reason it gave. */
var GenerationError = class extends Error {
	/** The upstream's own status code, when it gave one. */
	code;
	constructor(message, code) {
		super(message);
		this.name = "GenerationError";
		this.code = code;
	}
};
/**
* Read the account's open-platform key.
*
* The credit endpoint answers the desktop app's OAuth bearer, and its
* answer carries the key. It is not a secret the person had to configure: it
* belongs to the account, the same way the balance does.
*/
async function fetchPlanApiKey(credential, region, fetchImpl = fetch) {
	const response = await fetchImpl(`${PLAN_CREDIT_HOSTS[region]}${PLAN_CREDIT_PATH}?business=Agent&device_platform=desktop`, { headers: {
		accept: "application/json",
		authorization: `Bearer ${credential.token}`
	} });
	if (!response.ok) throw new GenerationError(`token plan credit request failed: HTTP ${response.status}`, response.status);
	const key = (await response.json()).api_key;
	return typeof key === "string" && key.length > 0 ? key : void 0;
}
/** The upstream's error message, when the body carries one. */
function readErrorMessage(body) {
	if (typeof body !== "object" || body === null) return void 0;
	const record = body;
	const error = record.error;
	if (typeof error === "object" && error !== null) {
		const message = error.message;
		if (typeof message === "string") return message;
	}
	const base = record.base_resp;
	if (typeof base === "object" && base !== null) {
		const message = base.status_msg;
		if (typeof message === "string") return message;
	}
}
/**
* The upstream's own refusal, when it answers with one.
*
* The generation endpoints do not always use the HTTP status to say no: a
* task that does not exist comes back as `200` with
* `base_resp.status_code: 2013`. Reading only the HTTP status would turn
* that into an empty answer and leave the caller polling a task that will
* never arrive, so the body's own code is checked too.
*/
function readBodyRefusal(body) {
	const code = readErrorCode(body);
	if (code === void 0 || code === 0) return void 0;
	return {
		message: readErrorMessage(body) ?? `the upstream refused the request (${code})`,
		code
	};
}
/** The upstream's own code, when the body carries one. */
function readErrorCode(body) {
	if (typeof body !== "object" || body === null) return void 0;
	const record = body;
	const error = record.error;
	if (typeof error === "object" && error !== null) {
		const code = error.http_code;
		const parsed = typeof code === "string" ? Number(code) : code;
		if (typeof parsed === "number" && Number.isFinite(parsed)) return parsed;
	}
	const base = record.base_resp;
	if (typeof base === "object" && base !== null) {
		const code = base.status_code;
		if (typeof code === "number" && Number.isFinite(code)) return code;
	}
}
/**
* Call a generation endpoint and turn its refusal into a readable error.
*
* The upstream reports a bad parameter as HTTP 400 with a code in the
* message, and a bad credential as HTTP 401; both arrive as an error body
* whose `error.message` says what was wrong. The message is kept verbatim
* because it names the offending field.
*/
async function callGeneration(apiKey, url, body, fetchImpl) {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: {
			accept: "application/json",
			authorization: `Bearer ${apiKey}`,
			"content-type": "application/json"
		},
		body: JSON.stringify(body)
	});
	const text = await response.text();
	let document;
	try {
		document = JSON.parse(text);
	} catch {
		if (!response.ok) throw new GenerationError(`generation request failed: HTTP ${response.status}`, response.status);
		throw new GenerationError("generation response was not JSON");
	}
	if (!response.ok) throw new GenerationError(readErrorMessage(document) ?? `generation request failed: HTTP ${response.status}`, readErrorCode(document) ?? response.status);
	const refusal = readBodyRefusal(document);
	if (refusal !== void 0) throw new GenerationError(refusal.message, refusal.code);
	return document ?? {};
}
/**
* Generate images from a prompt.
*
* The bytes are fetched while the URL is still fresh: the endpoint's link
* expires in 24 hours, and a plugin that only kept the link would leave the
* picture behind.
*/
async function generateImages(options) {
	const fetchImpl = options.fetchImpl ?? fetch;
	const body = {
		model: options.model ?? IMAGE_MODELS[0],
		prompt: options.prompt,
		response_format: "url"
	};
	if (options.count !== void 0) body.n = options.count;
	if (options.aspectRatio !== void 0) body.aspect_ratio = options.aspectRatio;
	if (options.area !== void 0) body.area = options.area;
	const document = await callGeneration(options.apiKey, `${MINIMAX_API_HOSTS[options.region]}${IMAGE_GENERATIONS_PATH}`, body, fetchImpl);
	const images = [];
	for (const entry of document.data ?? []) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry;
		const image = {};
		if (typeof record.url === "string") image.url = record.url;
		if (typeof record.size === "string") image.size = record.size;
		if (typeof record.revised_prompt === "string") image.revisedPrompt = record.revised_prompt;
		if (typeof record.b64_json === "string") {
			image.bytes = Buffer.from(record.b64_json, "base64");
			image.mediaType = "image/jpeg";
		}
		images.push(image);
	}
	const usage = document.usage;
	return {
		images,
		generatedImages: typeof usage?.generated_images === "number" ? usage.generated_images : void 0,
		totalTokens: typeof usage?.total_tokens === "number" ? usage.total_tokens : void 0,
		requestId: typeof document.request_id === "string" ? document.request_id : void 0
	};
}
/**
* Download a generated image's bytes.
*
* The link the endpoint hands out is good for a day; the picture is fetched
* now so that nothing the plugin shows depends on that clock.
*/
async function downloadImage(url, fetchImpl = fetch) {
	const response = await fetchImpl(url);
	if (!response.ok) throw new GenerationError(`image download failed: HTTP ${response.status}`, response.status);
	return {
		bytes: new Uint8Array(await response.arrayBuffer()),
		mediaType: (response.headers.get("content-type") ?? "image/jpeg").split(";")[0] ?? "image/jpeg"
	};
}
/**
* Start a video generation task.
*
* The task is asynchronous: the endpoint answers with an identifier and the
* video appears later, so the caller polls {@link queryVideoTask}.
*/
async function startVideoTask(options) {
	const fetchImpl = options.fetchImpl ?? fetch;
	const content = [{
		type: "text",
		text: options.prompt
	}];
	if (options.firstFrameUrl !== void 0) content.push({
		type: "image_url",
		image_url: { url: options.firstFrameUrl },
		role: "first_frame"
	});
	if (options.lastFrameUrl !== void 0) content.push({
		type: "image_url",
		image_url: { url: options.lastFrameUrl },
		role: "last_frame"
	});
	const body = {
		model: VIDEO_MODEL,
		content
	};
	if (options.duration !== void 0) body.duration = options.duration;
	if (options.resolution !== void 0) body.resolution = options.resolution;
	if (options.ratio !== void 0) body.ratio = options.ratio;
	const taskId = (await callGeneration(options.apiKey, `${MINIMAX_API_HOSTS[options.region]}${VIDEO_GENERATION_PATH}`, body, fetchImpl)).task_id;
	if (typeof taskId !== "string" || taskId.length === 0) throw new GenerationError("the video task carried no task id");
	return taskId;
}
/**
* Read a video task's state.
*
* The finished video's address is in the task's content; the endpoint also
* reports a plain `status` string for the simpler shape.
*/
async function queryVideoTask(options) {
	const response = await (options.fetchImpl ?? fetch)(`${MINIMAX_API_HOSTS[options.region]}${VIDEO_QUERY_PATH}/${encodeURIComponent(options.taskId)}`, { headers: {
		accept: "application/json",
		authorization: `Bearer ${options.apiKey}`
	} });
	const text = await response.text();
	let document;
	try {
		document = JSON.parse(text) ?? {};
	} catch {
		throw new GenerationError(`video task query failed: HTTP ${response.status}`, response.status);
	}
	if (!response.ok) throw new GenerationError(readErrorMessage(document) ?? `video task query failed: HTTP ${response.status}`, readErrorCode(document) ?? response.status);
	const refusal = readBodyRefusal(document);
	if (refusal !== void 0) throw new GenerationError(refusal.message, refusal.code);
	const task = document.task ?? document;
	const content = task.content;
	const usage = task.usage;
	return {
		taskId: options.taskId,
		status: typeof task.status === "string" ? task.status : void 0,
		url: typeof content?.url === "string" ? content.url : void 0,
		resolution: typeof task.resolution === "string" ? task.resolution : void 0,
		duration: typeof task.duration === "number" ? task.duration : void 0,
		ratio: typeof task.ratio === "string" ? task.ratio : void 0,
		totalSeconds: typeof usage?.total_seconds === "number" ? usage.total_seconds : void 0,
		totalTokens: typeof usage?.total_tokens === "number" ? usage.total_tokens : void 0
	};
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
/** Open-platform account API, which serves the per-model usage summary. */
const MINIMAX_OPEN_HOSTS = {
	cn: "https://www.minimaxi.com",
	io: "https://www.minimaxi.com",
	com: "https://www.minimaxi.com"
};
/** Membership endpoint: carries the credit summary. */
const MEMBERSHIP_PATH = "/matrix/api/v1/commerce/get_membership_info";
/** Credit ledger endpoint: per-grant amounts and expiry. */
const CREDIT_DETAILS_PATH = "/minimax-cloud/api/v1/credit/details";
/** Per-model token usage summary (open platform). */
const USAGE_SUMMARY_PATH = "/backend/account/token_plan/usage_summary";
/** Open-platform credit endpoint that carries the account's plan key. */
const TOKEN_PLAN_CREDIT_PATH = "/backend/account/token_plan_credit";
/**
* Rate-limit window endpoint, as the open platform documents it.
*
* The M Plan FAQ names `GET /v1/token_plan/remains` as the way to read the
* quota over HTTP. It asks for an API secret key rather than the desktop
* app's OAuth bearer, and it is the path the upstream still maintains: the
* older path this plugin started with now answers 200 with an empty body
* even for accounts that do have windows.
*/
const TOKEN_PLAN_REMAINS_PATH = "/v1/token_plan/remains";
/**
* Rate-limit window endpoint the plugin used first.
*
* Kept as a fallback for an account whose open platform hands out no plan
* key, since the documented path needs one.
*/
const REMAINS_PERCENT_PATH = "/backend/account/token_plan/remains_percent";
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
* Read the plan out of a membership response.
*
* The upstream only fills these in for an account that subscribes: without a
* plan `has_token_plan` is false and the tier is absent. `subscription_type`
* says so too — "mplan" once a plan is held, "none" before.
*
* @returns The plan, or `undefined` when the response carries no plan fields.
*/
function parsePlanSummary(document) {
	if (typeof document !== "object" || document === null) return void 0;
	const record = document;
	const hasTokenPlan = record.has_token_plan;
	const tier = typeof record.token_plan_tier === "string" && record.token_plan_tier.length > 0 ? record.token_plan_tier : void 0;
	const expires = toNumber$1(record.token_plan_expires_at);
	const expiresAtMs = expires === void 0 || expires <= 0 ? void 0 : expires;
	if (hasTokenPlan !== true && tier === void 0 && expiresAtMs === void 0) return void 0;
	return {
		tier,
		expiresAtMs,
		active: hasTokenPlan === true || tier !== void 0
	};
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
* Fetch the membership document.
*
* One answer carries several things: the credit balance, the plan the
* account subscribes to, and when that plan ends. They are read together so
* that the account is asked once.
*/
async function fetchMembershipDocument(credential, region, fetchImpl = fetch) {
	const response = await fetchImpl(`${MINIMAX_ACCOUNT_HOSTS[region]}${MEMBERSHIP_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${credential.token}`
		},
		body: "{}"
	});
	if (!response.ok) throw new Error(`membership request failed: HTTP ${response.status}`);
	const document = await response.json();
	return typeof document === "object" && document !== null ? document : void 0;
}
/**
* Fetch the current credit balance.
*
* @returns The balance, or `undefined` when the account has no credit summary.
*/
async function fetchCreditSummary(credential, region, fetchImpl = fetch) {
	const document = await fetchMembershipDocument(credential, region, fetchImpl);
	return document === void 0 ? void 0 : parseCreditSummary(document);
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
* Read the two rate-limit windows out of a remains response.
*
* The upstream answers with one entry per metered group; the general one is
* the only one the plan meters today, and the first entry is used when it is
* absent. The window length is derived from the entry's own endpoints rather
* than assumed to be five hours or seven days — the plan's terms have
* changed before, and the display should follow whatever the server says.
*
* A window the server marks as unlimited (`current_*_status` of 3) carries no
* allowance to be a percentage of, so it produces no window at all: reporting
* "0%" of an unlimited quota would be a number nobody can act on.
*
* **Which share the upstream reports changed.** It used to answer with the
* share already used, as a string ("19%"); with a plan subscribed it answers
* with the share still *remaining*, as a plain number (90). Both are
* accepted, and the two are opposites, so what leaves this function is
* always the share used — otherwise the same window would read 90% used on
* a plan that has barely spent anything.
*/
function parseRateLimitWindows(document) {
	if (typeof document !== "object" || document === null) return void 0;
	const remains = document.model_remains;
	if (!Array.isArray(remains) || remains.length === 0) return void 0;
	const entry = remains.find((item) => typeof item === "object" && item !== null && item.model_name === "general") ?? remains[0];
	if (typeof entry !== "object" || entry === null) return void 0;
	const record = entry;
	const interval = readWindow(record.current_interval_used_percent, record.current_interval_remaining_percent, record.start_time, record.end_time, record.current_interval_status);
	const weekly = readWindow(record.current_weekly_used_percent, record.current_weekly_remaining_percent, record.weekly_start_time, record.weekly_end_time, record.current_weekly_status);
	if (interval === void 0 || weekly === void 0) return void 0;
	return {
		interval,
		weekly
	};
}
/**
* The status the upstream gives a window that is not limited at all.
*
* The desktop app reads it the same way: `isUnlimited: 3 === status`.
*/
const UNLIMITED_STATUS = 3;
/**
* The share of a window's allowance already used, whichever way it is reported.
*
* The endpoint named the used share `current_*_used_percent` and then
* renamed it to `current_*_remaining_percent` while inverting its meaning.
* The used share is what a person needs, so it is what this returns; the
* remaining share is subtracted from a hundred to get there.
*/
function readUsedPercent(used, remaining) {
	const usedPercent = parsePercent(used);
	if (usedPercent !== void 0) return usedPercent;
	const remainingPercent = parsePercent(remaining);
	if (remainingPercent === void 0) return void 0;
	return 100 - remainingPercent;
}
/** Assemble one window from its percent and edge fields; all must be present. */
function readWindow(percent, remainingPercent, startAtMs, resetAtMs, status) {
	if (status === UNLIMITED_STATUS) return void 0;
	const usedPercent = readUsedPercent(percent, remainingPercent);
	const start = toNumber$1(startAtMs);
	const reset = toNumber$1(resetAtMs);
	if (usedPercent === void 0 || start === void 0 || reset === void 0) return void 0;
	return {
		usedPercent,
		startAtMs: start,
		resetAtMs: reset
	};
}
/**
* Read "19%" as 19, and a bare 19 as 19 as well.
*
* The desktop app parses both shapes, so both are accepted here: anything
* unreadable stays unreadable rather than becoming a zero.
*/
function parsePercent(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
	if (typeof value !== "string") return void 0;
	const parsed = Number(value.replace(/%\s*$/, ""));
	return Number.isFinite(parsed) ? parsed : void 0;
}
/**
* Fetch the plan's two rate-limit windows from the older open-platform path.
*
* The endpoint lives on the open-platform host, like the usage summary, and
* answers the same OAuth credential the membership endpoint takes. The JWT the
* model gateway accepts does not work here: this is an account endpoint.
*
* @returns The windows, or `undefined` when the response carries none.
*/
async function fetchRateLimitWindows(credential, region, fetchImpl = fetch) {
	const response = await fetchImpl(`${MINIMAX_OPEN_HOSTS[region]}${REMAINS_PERCENT_PATH}?business=Agent&device_platform=desktop`, { headers: {
		accept: "application/json",
		authorization: `Bearer ${credential.token}`
	} });
	if (!response.ok) throw new Error(`rate-limit window request failed: HTTP ${response.status}`);
	return parseRateLimitWindows(await response.json());
}
/**
* Read the open platform's plan key.
*
* The documented quota endpoint wants an API secret key, and the open
* platform is where the account's key comes from: the desktop app asks the
* same endpoint with its OAuth bearer and gets the key back in the answer,
* so the key is a property of the account rather than something the person
* has to configure.
*
* @returns The key, or `undefined` when the account has none.
*/
async function fetchTokenPlanApiKey(credential, region, fetchImpl = fetch) {
	const response = await fetchImpl(`${MINIMAX_OPEN_HOSTS[region]}${TOKEN_PLAN_CREDIT_PATH}?business=Agent&device_platform=desktop`, { headers: {
		accept: "application/json",
		authorization: `Bearer ${credential.token}`
	} });
	if (!response.ok) throw new Error(`token plan credit request failed: HTTP ${response.status}`);
	const key = (await response.json()).api_key;
	return typeof key === "string" && key.length > 0 ? key : void 0;
}
/**
* Read a string field, ignoring anything that is not a string.
*
* The upstream's token counts carry their own unit ("826.14M"), so they are
* kept as the wording it used rather than pulled apart into a number.
*/
function toText(value) {
	return typeof value === "string" ? value : void 0;
}
/**
* Read the usage profile out of a summary response.
*
* Every field is optional in practice: the upstream adds fields over time, and
* an account with no history at all answers with a body that carries none of
* them. A field that is missing — or that arrives in a shape this does not
* recognise — is therefore reported as absent rather than as an error, so one
* odd field never costs the whole profile. A body that is not an object at
* all carries no profile and yields none.
*/
function parseUsageProfile(document) {
	if (typeof document !== "object" || document === null || Array.isArray(document)) return void 0;
	const record = document;
	const day = record.most_active_day;
	const mostActiveDay = typeof day === "object" && day !== null ? day : void 0;
	const date = toText(mostActiveDay?.date);
	const tokenCount = toText(mostActiveDay?.token_count);
	const daily = Array.isArray(record.daily_token_usage) ? record.daily_token_usage.filter((entry) => typeof entry === "number" && Number.isFinite(entry)) : void 0;
	return {
		totalDays: toNumber$1(record.total_days),
		activeDays: toNumber$1(record.active_days),
		currentConsecutiveDays: toNumber$1(record.current_consecutive_days),
		totalTokenConsumed: toText(record.total_token_consumed),
		usageRankingPercent: toNumber$1(record.usage_ranking_percent),
		mostActiveDay: date === void 0 && tokenCount === void 0 ? void 0 : {
			date,
			tokenCount
		},
		lastUpdateTime: toText(record.last_update_time),
		dailyTokenUsage: daily
	};
}
/**
* Fetch the account's usage profile.
*
* The endpoint lives on the open-platform host and takes the same OAuth
* bearer the membership endpoint takes; the JWT the model gateway accepts
* does not work here. The query is the one the desktop app sends, and it is
* not trimmed down: `token_type` picks which token kind is counted and
* `heatmap_days` sets how far back the daily series reaches.
*
* @returns The profile, or `undefined` when the response carries no object.
*/
async function fetchUsageProfile(credential, region, fetchImpl = fetch) {
	const response = await fetchImpl(`${MINIMAX_OPEN_HOSTS[region]}${USAGE_SUMMARY_PATH}?token_type=5&heatmap_days=365&business=Agent&device_platform=desktop`, { headers: {
		accept: "application/json",
		authorization: `Bearer ${credential.token}`
	} });
	if (!response.ok) throw new Error(`usage summary request failed: HTTP ${response.status}`);
	return parseUsageProfile(await response.json());
}
/** The upstream's own code for "this account has no plan subscription". */
const NO_SUBSCRIPTION_CODE = 2062;
/** The upstream's own code for "the request carried no usable API key". */
const MISSING_API_KEY_CODE = 1004;
/** The upstream's status code inside a response body, when it carries one. */
function readBaseRespCode(document) {
	const base = document.base_resp;
	if (typeof base !== "object" || base === null) return void 0;
	const code = base.status_code;
	return typeof code === "number" ? code : void 0;
}
/**
* Read the windows from the documented quota endpoint.
*
* The upstream says plainly when there is nothing to report: `2062` means
* the account has no plan subscription, and the quota does not exist for it
* at all. That is a fact about the plan rather than a failure to read, so
* it is reported as such and not as an error — the windows of a plan the
* account does not hold are not missing data.
*/
async function fetchTokenPlanWindows(apiKey, region, fetchImpl = fetch) {
	const response = await fetchImpl(`${MINIMAX_OPEN_HOSTS[region]}${TOKEN_PLAN_REMAINS_PATH}`, { headers: {
		accept: "application/json",
		authorization: `Bearer ${apiKey}`,
		"content-type": "application/json"
	} });
	if (!response.ok) throw new Error(`rate-limit window request failed: HTTP ${response.status}`);
	const document = await response.json();
	const code = readBaseRespCode(document);
	if (code === NO_SUBSCRIPTION_CODE) return { absence: "no-subscription" };
	if (code === MISSING_API_KEY_CODE) return { error: "the open platform did not accept the plan key" };
	const windows = parseRateLimitWindows(document);
	if (windows === void 0) return { error: "response carried no rate-limit windows" };
	return { windows };
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
	#rateLimit;
	#rateLimitError;
	#plan;
	#rateLimitAbsence;
	#rateLimitAtMs;
	#usageProfile;
	#usageProfileError;
	#apiKey;
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
	/** The plan's rate-limit windows as last read. */
	get rateLimit() {
		return this.#rateLimit;
	}
	/** Why the windows could not be read, when they could not. */
	get rateLimitError() {
		return this.#rateLimitError;
	}
	/** The plan the account subscribes to, as the last read found it. */
	get plan() {
		return this.#plan;
	}
	/** Why the plan has no windows, when the upstream said so plainly. */
	get rateLimitAbsence() {
		return this.#rateLimitAbsence;
	}
	/** When the windows were last read. */
	get rateLimitAtMs() {
		return this.#rateLimitAtMs;
	}
	/** The account's usage profile as last read. */
	get usageProfile() {
		return this.#usageProfile;
	}
	/** Why the usage profile could not be read, when it could not. */
	get usageProfileError() {
		return this.#usageProfileError;
	}
	/**
	* Read the balance and record how much was consumed since the last read.
	*
	* The credit ledger is read alongside it, but a ledger that cannot be read
	* never hides the balance: the two come from different endpoints and only
	* the balance is essential. The rate-limit windows and the usage profile
	* ride along under the same rule — they come from yet other endpoints, and
	* none of the four takes the others down with it.
	*
	* @returns Whether the balance changed.
	*/
	async refresh(credential, region, fetchImpl = fetch, now = Date.now()) {
		let changed = false;
		try {
			const document = await fetchMembershipDocument(credential, region, fetchImpl);
			if (document !== void 0) this.#plan = parsePlanSummary(document);
			const summary = document === void 0 ? void 0 : parseCreditSummary(document);
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
		await this.refreshRateLimit(credential, region, fetchImpl, now);
		await this.refreshUsageProfile(credential, region, fetchImpl);
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
	/**
	* Read the plan's rate-limit windows.
	*
	* Same rule as the ledger: a failure is remembered but never thrown, and a
	* window that cannot be read leaves the last one on display.
	*/
	async refreshRateLimit(credential, region, fetchImpl = fetch, now = Date.now()) {
		try {
			const read = await this.readWindows(credential, region, fetchImpl);
			if (read.error === void 0) this.#rateLimit = read.windows;
			this.#rateLimitAbsence = read.absence;
			this.#rateLimitError = read.error;
			this.#rateLimitAtMs = now;
		} catch (error) {
			this.#rateLimitError = error instanceof Error ? error.message : String(error);
		}
	}
	/**
	* Read the account's usage profile.
	*
	* Same rule as the ledger: a failure is remembered but never thrown, and a
	* profile that cannot be read leaves the last one on display.
	*/
	async refreshUsageProfile(credential, region, fetchImpl = fetch) {
		try {
			const profile = await fetchUsageProfile(credential, region, fetchImpl);
			this.#usageProfile = profile;
			this.#usageProfileError = void 0;
		} catch (error) {
			this.#usageProfileError = error instanceof Error ? error.message : String(error);
		}
	}
	/**
	* Read the windows from whichever endpoint can answer.
	*
	* The documented endpoint needs the open platform's plan key, which the
	* same platform hands out; the key is remembered because it does not
	* change from one read to the next. An account with no key at all still
	* gets the older path's answer.
	*/
	async readWindows(credential, region, fetchImpl = fetch) {
		const apiKey = this.#apiKey ?? await fetchTokenPlanApiKey(credential, region, fetchImpl);
		this.#apiKey = apiKey;
		if (apiKey !== void 0) try {
			return await fetchTokenPlanWindows(apiKey, region, fetchImpl);
		} catch (error) {
			const legacy = await fetchRateLimitWindows(credential, region, fetchImpl);
			if (legacy !== void 0) return { windows: legacy };
			throw error;
		}
		const legacy = await fetchRateLimitWindows(credential, region, fetchImpl);
		return legacy === void 0 ? { error: "response carried no rate-limit windows" } : { windows: legacy };
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
/** Remove the plugin's own credential, which is what signing out means. */
async function deletePluginCredential(env = process.env) {
	const { rm } = await import("node:fs/promises");
	await rm(pluginCredentialPath(env), { force: true });
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
/**
* Whether a message says the server refused the credential itself.
*
* The account and catalog endpoints answer a revoked or unknown bearer with
* `401`, and the only place that surfaces is the message the request layer
* built. Matching the status code rather than the wording keeps this working
* whatever language the message is written in.
*/
const isUnauthorized = (message) => message !== void 0 && /\bHTTP 401\b/.test(message);
/**
* Whether a failed refresh means the credential can never be used again.
*
* The authorization server answers a revoked or already-spent refresh token
* with `400`/`401`, and a credential that carries no refresh token can never
* be renewed at all. Both are final. A `5xx` or a dropped connection is not:
* throwing the credential away over a bad minute upstream would sign the
* person out for nothing.
*/
const isRefreshRefused = (message) => message.includes("没有可用于续期的 refresh token") || /\bHTTP (400|401)\b/.test(message);
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
	/** Whether the server refused the plugin's own credential. */
	let revokedByServer = false;
	/** What the card last reported about what the host offered it. */
	let capability;
	/**
	* Give up on the plugin's own credential after the server refused it.
	*
	* A revoked token keeps its expiry date, so every later call would send the
	* same dead token and fail the same way. The only way back is a new sign-in,
	* so the credential is deleted, the cached views of the account it belonged
	* to are dropped, and the card is left asking for one.
	*/
	const revokePluginCredential = async () => {
		await deletePluginCredential();
		if (pluginState.deviceLogin !== void 0) {
			pluginState = {
				...pluginState,
				deviceLogin: void 0
			};
			await writePluginState(pluginState);
		}
		revokedByServer = true;
		modelToken = void 0;
		loginSource = void 0;
		loginPending = false;
		creditState = "signed-out";
		signinPanel = void 0;
		signinClaim = void 0;
		signinError = void 0;
		catalog.invalidate();
		lastCreditAtMs = Date.now();
		lastSigninAtMs = Date.now();
		lastCatalogAtMs = 0;
	};
	/**
	* The credential the model gateway is called with.
	*
	* The plugin's own sign-in comes first: it is the credential the person
	* chose, and on a machine where the desktop app was never installed it is
	* the only one there is.
	*
	* The desktop app's OAuth grant is next, and it is not a mere fallback: it
	* is the credential a current install actually holds. Its `mmoat_` bearer is
	* what the gateway accepts, while the legacy JWT older installs left behind
	* is refused with `401 auth failed` — so the OAuth file has to be consulted
	* before that JWT, or a working machine looks broken.
	*/
	const resolveGatewayCredential = async () => {
		const own = await readPluginCredential();
		if (own !== void 0) {
			if (credentialNeedsRefresh(own)) try {
				const next = await refreshPluginCredential(own, region);
				await writePluginCredential(next);
				loginSource = "plugin";
				modelToken = next.accessToken;
				revokedByServer = false;
				return {
					token: next.accessToken,
					claims: { exp: Math.floor((next.expiresAtMs ?? Date.now()) / 1e3) }
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (isRefreshRefused(message)) {
					await revokePluginCredential();
					return;
				}
			}
			else {
				loginSource = "plugin";
				modelToken = own.accessToken;
				return {
					token: own.accessToken,
					claims: { exp: Math.floor((own.expiresAtMs ?? Date.now()) / 1e3) }
				};
			}
		}
		const oauth = await ensureOAuthCredential(region, process.env);
		if (oauth.state === "signed-in") {
			loginSource = "desktop-app";
			modelToken = oauth.credential.token;
			return {
				token: oauth.credential.token,
				claims: { exp: Math.floor((oauth.credential.expiresAtMs ?? Date.now()) / 1e3) }
			};
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
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (isRefreshRefused(message)) {
					await revokePluginCredential();
					return {
						state: "signed-out",
						reason: "not-signed-in"
					};
				}
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
		if ([credits.error, credits.ledgerError].find((message) => isUnauthorized(message)) !== void 0) {
			await revokePluginCredential();
			return;
		}
		if (credits.snapshot !== void 0) revokedByServer = false;
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
			const message = error instanceof Error ? error.message : String(error);
			if (isUnauthorized(message)) {
				await revokePluginCredential();
				return;
			}
			signinError = message;
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
			const message = error instanceof Error ? error.message : String(error);
			if (isUnauthorized(message)) {
				await revokePluginCredential();
				return;
			}
			signinError = message;
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
	/**
	* The account's usage profile as the card reads it.
	*
	* The upstream's own summary of the account's history: how many days it has
	* been used in a row, how much it has consumed, and where it ranks. It is
	* about the account rather than about this host, which is what the pill's
	* own token count reports.
	*/
	const buildUsageProfileStatus = () => {
		const profile = credits.usageProfile;
		if (profile === void 0) return credits.usageProfileError === void 0 ? void 0 : {
			state: "unavailable",
			error: credits.usageProfileError
		};
		return {
			state: "ok",
			totalDays: profile.totalDays,
			activeDays: profile.activeDays,
			consecutiveDays: profile.currentConsecutiveDays,
			totalTokenConsumed: profile.totalTokenConsumed,
			rankingPercent: profile.usageRankingPercent,
			mostActiveDay: profile.mostActiveDay,
			updatedAt: profile.lastUpdateTime
		};
	};
	/**
	* The plan the account holds, as the card reads it.
	*
	* It comes from the same membership answer as the balance, so it is free.
	*/
	const buildPlanStatus = () => {
		const held = credits.plan;
		if (held === void 0) return void 0;
		return {
			active: held.active,
			tier: held.tier,
			expiresAtMs: held.expiresAtMs
		};
	};
	/** The plan's rolling usage windows as the card reads them. */
	const buildRateLimitStatus = () => {
		if (creditState === "signed-out" || creditState === "expired") return { state: creditState };
		const windows = credits.rateLimit;
		if (windows === void 0) return {
			state: "unavailable",
			...credits.rateLimitAbsence === void 0 ? {} : { reason: credits.rateLimitAbsence },
			...credits.rateLimitError === void 0 ? {} : { error: credits.rateLimitError }
		};
		return {
			state: "ok",
			interval: windows.interval,
			weekly: windows.weekly,
			...credits.rateLimitAtMs === void 0 ? {} : { updatedAtMs: credits.rateLimitAtMs }
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
		...imageInputHooks(ctx),
		onUsage: (model, usage) => {
			meter.record(model, usage);
			refreshCredits();
		}
	});
	ctx.llm.registerAdapter(["minimaxcode"], adapter);
	/**
	* The sign-in state the card reports.
	*
	* It describes the credential the gateway will actually be called with, not
	* a particular file on disk: the card exists to answer "will a request
	* work", and a token the server refused is not a sign-in however unexpired
	* it looks. Reading the legacy JWT alone is what made a machine whose model
	* gateway was working report a signed-out, expired card.
	*/
	const buildAuthStatus = async () => {
		if (revokedByServer) return {
			state: "signed-out",
			reason: "credential-revoked"
		};
		const current = await readNow();
		if (current !== void 0) {
			const remaining = expiresInMs(current.claims);
			if (remaining <= 0) return {
				state: "expired",
				reason: "credential-expired"
			};
			return {
				state: "signed-in",
				daysRemaining: Math.ceil(remaining / 864e5),
				expiry: expiryLevel(current.claims)
			};
		}
		const state = await readCredential();
		if (state.state === "expired") return { state: "expired" };
		if (state.state === "signed-out") return {
			state: "signed-out",
			reason: state.reason
		};
		return { state: "signed-in" };
	};
	/** Build the document the card renders, without ever exposing the token. */
	const buildStatus = async () => {
		await refreshCredits();
		await refreshSignin();
		return statusDocument({
			auth: await buildAuthStatus(),
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
			rateLimit: buildRateLimitStatus(),
			usage: buildUsageStatus(),
			signin: buildSigninStatus(),
			login: buildLoginStatus(),
			usageProfile: buildUsageProfileStatus(),
			plan: buildPlanStatus(),
			capability,
			generation: {
				imageModels: [...IMAGE_MODELS],
				imageAspectRatios: [...IMAGE_ASPECT_RATIOS],
				imageAreas: [...IMAGE_AREAS],
				videoDurations: [...VIDEO_DURATIONS],
				videoResolutions: [...VIDEO_RESOLUTIONS],
				videoRatios: [...VIDEO_RATIOS]
			}
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
					revokedByServer = false;
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
	/**
	* The plan's own API key, remembered for the session.
	*
	* The generation endpoints want the open platform's key rather than the
	* desktop app's OAuth bearer, and the key belongs to the account: the
	* credit endpoint hands it out to the OAuth credential the plugin already
	* holds. It is fetched once and kept for as long as the plugin runs.
	*/
	let planApiKey;
	const resolvePlanApiKey = async () => {
		if (planApiKey !== void 0) return planApiKey;
		const account = await resolveAccountCredential();
		if (account.state !== "signed-in") throw new GenerationError("尚未登录 MiniMax Code");
		const key = await fetchPlanApiKey(account.credential, region);
		if (key === void 0) throw new GenerationError("账户没有开放平台密钥，无法调用生成接口");
		planApiKey = key;
		return key;
	};
	/**
	* Commit a generated picture to the host's attachment store.
	*
	* The store is read per request: the host may provide it after this plugin
	* loads, and a host without one must still show the picture. The media type
	* is narrowed to the four the store accepts, because it checks the declared
	* type against the decoded bytes.
	*
	* @returns The durable reference, when the picture was stored.
	*/
	const saveGeneratedImage = async (bytes, mediaType) => {
		const store = ctx.get("attachments");
		if (store === void 0) return void 0;
		const type = mediaType === "image/png" || mediaType === "image/webp" || mediaType === "image/gif" ? mediaType : "image/jpeg";
		try {
			const ref = await store.saveImage({
				data: bytes,
				mediaType: type,
				name: "minimax-h3-image"
			});
			return {
				attachmentId: ref.attachmentId,
				width: ref.width,
				height: ref.height,
				bytes: ref.bytes
			};
		} catch {
			return;
		}
	};
	/**
	* Make a picture or start a video.
	*
	* A picture comes back at once, as bytes: the upstream's link is good for
	* a day, and a link that expires would leave the picture behind. A video
	* is a task that takes a minute and a half, so this answers with the task's
	* identifier and the card polls for the result.
	*/
	const runGeneration = async (body) => {
		const kind = body.kind;
		const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
		if (prompt.length === 0) return {
			ok: false,
			error: "请填写提示词"
		};
		const apiKey = await resolvePlanApiKey();
		if (kind === "video") return {
			ok: true,
			kind: "video",
			taskId: await startVideoTask({
				apiKey,
				region,
				prompt,
				duration: typeof body.duration === "number" ? body.duration : void 0,
				resolution: typeof body.resolution === "string" ? body.resolution : void 0,
				ratio: typeof body.ratio === "string" ? body.ratio : void 0,
				firstFrameUrl: typeof body.firstFrameUrl === "string" ? body.firstFrameUrl : void 0,
				lastFrameUrl: typeof body.lastFrameUrl === "string" ? body.lastFrameUrl : void 0
			})
		};
		const result = await generateImages({
			apiKey,
			region,
			prompt,
			model: typeof body.model === "string" ? body.model : void 0,
			aspectRatio: typeof body.aspectRatio === "string" ? body.aspectRatio : void 0,
			area: typeof body.area === "string" ? body.area : void 0,
			count: typeof body.count === "number" ? body.count : void 0
		});
		const first = result.images[0];
		if (first === void 0) return {
			ok: false,
			error: "上游没有返回图片"
		};
		if (first.bytes === void 0 && first.url === void 0) return {
			ok: false,
			error: "上游没有返回图片"
		};
		const image = first.bytes !== void 0 ? {
			bytes: first.bytes,
			mediaType: first.mediaType ?? "image/jpeg"
		} : await downloadImage(first.url);
		const saved = await saveGeneratedImage(image.bytes, image.mediaType);
		return {
			ok: true,
			kind: "image",
			size: first.size,
			revisedPrompt: first.revisedPrompt,
			totalTokens: result.totalTokens,
			requestId: result.requestId,
			mediaType: image.mediaType,
			dataUrl: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString("base64")}`,
			...saved === void 0 ? {} : { attachment: saved }
		};
	};
	/** Read a video task's state. */
	const readVideoTask = async (taskId) => {
		const task = await queryVideoTask({
			apiKey: await resolvePlanApiKey(),
			region,
			taskId
		});
		return {
			ok: true,
			kind: "video",
			taskId: task.taskId,
			status: task.status,
			url: task.url
		};
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
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: MINIMAX_CAPABILITY_PATH,
			handler: async (req, res) => {
				if (!isLoopback(req.headers.host)) {
					res.writeHead(403, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "loopback only" }));
					return;
				}
				try {
					const raw = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("report") ?? "";
					let findings = {};
					try {
						const parsed = JSON.parse(raw);
						if (typeof parsed === "object" && parsed !== null) for (const [key, value] of Object.entries(parsed)) findings[key] = String(value);
					} catch {
						findings = { report: "unreadable" };
					}
					capability = {
						at: Date.now(),
						findings
					};
					res.writeHead(204);
					res.end();
				} catch (error) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
				}
			}
		}));
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: MINIMAX_GENERATE_PATH,
			handler: async (req, res) => {
				if (!isLoopback(req.headers.host)) {
					res.writeHead(403, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "loopback only" }));
					return;
				}
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				try {
					if (req.method === "GET") {
						const taskId = url.searchParams.get("taskId") ?? "";
						if (taskId.length === 0) {
							res.writeHead(400, { "Content-Type": "application/json" });
							res.end(JSON.stringify({
								ok: false,
								error: "缺少 taskId"
							}));
							return;
						}
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify(await readVideoTask(taskId)));
						return;
					}
					if (req.method !== "POST") {
						res.writeHead(405, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "POST only" }));
						return;
					}
					let body = {};
					try {
						const text = await readRequestBody(req);
						if (text.length > 0) {
							const parsed = JSON.parse(text);
							if (typeof parsed === "object" && parsed !== null) body = parsed;
						}
					} catch {}
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(await runGeneration(body)));
				} catch (error) {
					const status = error instanceof GenerationError ? 400 : 500;
					res.writeHead(status, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
						...error instanceof GenerationError && error.code !== void 0 ? { code: error.code } : {}
					}));
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
export { DEVICE_CODE_GRANT, DEVICE_CODE_PATH, EMPTY_USAGE, FALLBACK_MODELS, MEMBERSHIP_PATH, MINIMAXCODE_PROVIDER_ID, MINIMAX_ACTION_PATH, MINIMAX_AUTH_FILENAME, MINIMAX_DATA_DIR, MINIMAX_GATEWAYS, MINIMAX_OAUTH_CLIENT_ID, MINIMAX_REGIONS, MINIMAX_STATUS_PATH, MINIMAX_STREAM_IDLE_TIMEOUT_MS, MODEL_PRICES, MinimaxCatalog, MinimaxCredits, PLUGIN_CREDENTIAL_FILENAME, PLUGIN_STATE_FILENAME, REMAINS_PERCENT_PATH, SIGNIN_CLAIM_PATH, SIGNIN_CLAIM_RESULT, SIGNIN_CYCLE_DAYS, SIGNIN_DAY_STATUS, SIGNIN_PANEL_PATH, UsageMeter, apply, authPath, bearerToken, catalogUrl, chatBaseUrl, claimSignin, createMinimaxCodeAdapter, dataDir, daysRemaining, decodeClaims, deletePluginCredential, dshHome, ensureOAuthCredential, estimateCny, expiresInMs, expiryLevel, fetchCreditSummary, fetchMembershipDocument, fetchRateLimitWindows, fetchSigninPanel, inject, localDay, makePkce, name, parseAuthDocument, parseCatalog, parseCreditSummary, parseOAuthDocument, parsePlanSummary, parseRateLimitWindows, parseSigninClaim, parseSigninPanel, pluginCredentialPath, pluginStatePath, pollDeviceLogin, priceFor, readCredential, readOAuthCredential, readPluginCredential, readPluginState, refreshOAuthCredential, refreshPluginCredential, startDeviceLogin, statusDocument, timezoneId, writeOAuthCredential, writePluginCredential, writePluginState };
