import "@earendil-works/pi-ai";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { Context } from "@deepseek-ai/cordis";
//#region src/auth.d.ts
/** File the desktop app writes its runtime auth context into. */
declare const MINIMAX_AUTH_FILENAME = "local-runtime.auth.json";
/** Directory holding it, relative to the user's home. */
declare const MINIMAX_DATA_DIR = ".minimax";
/** Region-specific gateways the desktop app ships with. */
declare const MINIMAX_GATEWAYS: {
  readonly cn: "https://agent.minimax.cn";
  readonly io: "https://agent.minimax.io";
  readonly com: "https://agent.minimaxi.com";
};
/** A gateway this plugin knows how to talk to. */
type MinimaxRegion = keyof typeof MINIMAX_GATEWAYS;
/** Every region, for a fallback sweep when the configured one fails. */
declare const MINIMAX_REGIONS: readonly MinimaxRegion[];
/**
 * Base URL for pi-ai's anthropic client on a region gateway.
 *
 * This must stop *before* the API version segment: the Anthropic SDK appends
 * `/v1/messages` itself, so a base ending in `/v1` produced the doubled path
 * `/mavis/api/v1/llm/v1/v1/messages`, which the gateway answers with
 * `503 direct_route_not_configured`. The correct request URL is therefore
 * `<this>/v1/messages`.
 */
declare function chatBaseUrl(region: MinimaxRegion): string;
/** Base URL of the authoritative model catalog on a region gateway. */
declare function catalogUrl(region: MinimaxRegion): string;
/** Default data directory, honouring the app's own override variables. */
declare function dataDir(env?: NodeJS.ProcessEnv): string;
/** Absolute path of the auth file this plugin reads. */
declare function authPath(env?: NodeJS.ProcessEnv): string;
/** The JWT claims this plugin acts on. */
interface TokenClaims {
  /** Expiry, seconds since the epoch. */
  exp: number;
  /** Account id the issuer embedded, when present. */
  userId?: string;
  /** Display name the issuer embedded, when present. */
  name?: string;
}
/** A decoded, still-valid-at-read-time credential. */
interface Credential {
  token: string;
  claims: TokenClaims;
  /** Milliseconds since the epoch, from the file's own `updatedAtMs`. */
  updatedAtMs?: number;
}
/** Why a credential could not be used, in a form the UI can render. */
type AuthFailure = {
  state: 'signed-out';
  reason: 'app-missing' | 'not-signed-in' | 'unreadable' | 'malformed';
} | {
  state: 'expired';
  expiresAtMs: number;
};
type AuthState = {
  state: 'signed-in';
  credential: Credential;
} | AuthFailure;
/**
 * Decode a JWT payload without verifying its signature.
 *
 * Only the expiry is trusted, and only to decide how loudly to warn: a token we
 * cannot parse is reported as malformed rather than silently accepted, and a
 * token that verifies as expired is reported as expired rather than sent. The
 * issuer remains the sole authority on both questions.
 */
declare function decodeClaims(token: string): TokenClaims | undefined;
/** Milliseconds until the token expires; negative once it has. */
declare function expiresInMs(claims: TokenClaims, now?: number): number;
/** How a remaining lifetime should be presented to the user. */
type ExpiryLevel = 'healthy' | 'expiring' | 'expired';
/** Classify a token's remaining lifetime for display. */
declare function expiryLevel(claims: TokenClaims, now?: number): ExpiryLevel;
/** Whole days left, rounded up so 1 hour reads as "1 day", not "0 days". */
declare function daysRemaining(claims: TokenClaims, now?: number): number;
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
declare function parseAuthDocument(text: string, now?: number): AuthState;
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
declare function readCredential(env?: NodeJS.ProcessEnv, now?: number): Promise<AuthState>;
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
declare function bearerToken(env?: NodeJS.ProcessEnv, now?: number): string | undefined;
//#endregion
//#region src/catalog.d.ts
/** One model as the upstream describes it. */
interface CatalogModel {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens?: number;
  /** Whether the model accepts tool definitions and emits `tool_use`. */
  toolCall: boolean;
  /** Whether the model emits reasoning blocks. */
  reasoning: boolean;
  /** Input modalities, e.g. `text`, `image`, `video`. */
  inputModalities: string[];
  /** Whether the model accepts images at all. */
  attachment: boolean;
}
/** Provider id registered with DSH, distinct from the upstream one. */
declare const MINIMAXCODE_PROVIDER_ID = "minimaxcode";
/**
 * Used when the catalog cannot be fetched, so the picker still offers the
 * models the desktop app is known to ship.
 *
 * Deliberately small and conservative: a fallback entry overstates nothing we
 * could not confirm.
 */
declare const FALLBACK_MODELS: readonly CatalogModel[];
/** Where the currently served list came from. */
type CatalogSource = 'live' | 'fallback';
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
declare function parseCatalog(document: unknown): CatalogModel[];
/**
 * Holds the catalog and answers the picker's questions about it.
 *
 * Refreshes are explicit: the plugin refreshes at startup and on demand, and
 * keeps serving the last good snapshot while a refresh is in flight, so a
 * network blip never empties the model list.
 */
declare class MinimaxCatalog {
  #private;
  /** The models to serve right now. */
  current(): CatalogModel[];
  /** Provenance of {@link current}. */
  get source(): CatalogSource;
  /** When {@link current} was fetched, when it came from upstream. */
  get fetchedAtMs(): number | undefined;
  /** Why the last refresh failed, if one did. */
  get error(): string | undefined;
  /**
   * Replace the served list, adopting upstream's own ordering.
   *
   * @returns Whether anything changed, so callers can skip a needless reload.
   */
  set(models: readonly CatalogModel[], source: CatalogSource, fetchedAtMs?: number): boolean;
  /** Drop back to the built-in list, e.g. when the account signs out. */
  invalidate(): void;
  /**
   * Fetch the live catalog for a credential.
   *
   * Serialised through a single in-flight promise: a second caller joins the
   * first run rather than starting a duplicate request.
   *
   * @returns Whether the served list changed.
   */
  refresh(region: MinimaxRegion, credential: Credential, fetchImpl?: typeof fetch): Promise<boolean>;
  /** Identity the served catalog belongs to, if any. */
  get identity(): string | undefined;
}
//#endregion
//#region src/status-route.d.ts
/** Route this plugin mounts, matching its settings card. */
declare const MINIMAX_STATUS_PATH = "/plugins/dsh-connect-minimaxcode/status";
/** What the card renders. */
interface StatusDocument {
  state: 'signed-in' | 'signed-out' | 'expired';
  /** Human-readable next step, present when not signed in. */
  hint?: string;
  /** Whole days until expiry; absent when unknown. */
  daysRemaining?: number;
  /** Traffic-light state for the expiry warning. */
  expiry?: 'healthy' | 'expiring' | 'expired';
  region?: string;
  /** Provenance of the model list. */
  catalogSource?: 'live' | 'fallback';
  catalogError?: string;
  models?: {
    id: string;
    name: string;
    contextWindow: number;
  }[];
  /** Whether a catalog refresh is in flight. */
  refreshing?: boolean;
}
/** Inputs the document is derived from. */
interface StatusDeps {
  auth: {
    state: 'signed-in' | 'signed-out' | 'expired';
    daysRemaining?: number;
    expiry?: 'healthy' | 'expiring' | 'expired';
    reason?: string;
  };
  region: string;
  catalogSource: 'live' | 'fallback';
  catalogError?: string;
  models: {
    id: string;
    name: string;
    contextWindow: number;
  }[];
  refreshing: boolean;
}
/**
 * Build the card's status document.
 *
 * The three non-signed-in states carry different remedies, and the difference
 * is the whole point of the card: a user who has never installed the app needs
 * a different next step than one whose token simply aged out.
 */
declare function statusDocument(deps: StatusDeps): StatusDocument;
//#endregion
//#region src/adapter.d.ts
/** How long a silent stream may last before the transport gives up. */
declare const MINIMAX_STREAM_IDLE_TIMEOUT_MS: number;
/** Options for building the provider. */
interface AdapterOptions {
  catalog: MinimaxCatalog;
  /** Region whose gateway the models are served from. */
  region: () => MinimaxRegion;
  /** Live token, read fresh per call so a re-login takes effect at once. */
  resolveApiKey: () => Promise<string | undefined>;
  /**
   * Live token for the `Authorization` header, read synchronously because the
   * model descriptors that carry it are built inside `getModels()`.
   */
  bearerToken: () => string | undefined;
}
/** What {@link createMinimaxCodeAdapter} hands back. */
interface AdapterBundle {
  adapter: PiAiAdapter;
  /** Drop cached profiles so the next pick rebuilds them. */
  invalidate: () => void;
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
declare function createMinimaxCodeAdapter(options: AdapterOptions): AdapterBundle;
//#endregion
//#region src/index.d.ts
/** Loader entry name; also the id the bundle patch inserts. */
declare const name = "dsh-connect-minimaxcode";
/** Services this plugin needs before it can serve anything. */
declare const inject: string[];
/**
 * Compose the plugin.
 *
 * The credential is re-read on every request rather than cached at start: the
 * desktop app refreshes its token independently, and a long-lived host would
 * otherwise pin an expired one for the rest of the process.
 *
 * @param ctx - Service container.
 */
declare function apply(ctx: Context): void;
//#endregion
export { type AuthState, type CatalogModel, type CatalogSource, type Credential, FALLBACK_MODELS, MINIMAXCODE_PROVIDER_ID, MINIMAX_AUTH_FILENAME, MINIMAX_DATA_DIR, MINIMAX_GATEWAYS, MINIMAX_REGIONS, MINIMAX_STATUS_PATH, MINIMAX_STREAM_IDLE_TIMEOUT_MS, MinimaxCatalog, type MinimaxRegion, type StatusDocument, type TokenClaims, apply, authPath, bearerToken, catalogUrl, chatBaseUrl, createMinimaxCodeAdapter, dataDir, daysRemaining, decodeClaims, expiresInMs, expiryLevel, inject, name, parseAuthDocument, parseCatalog, readCredential, statusDocument };