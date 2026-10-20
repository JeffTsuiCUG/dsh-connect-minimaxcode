import "@earendil-works/pi-ai";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
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
 * could not confirm. Last verified against the live catalog on 2026-10-19,
 * when upstream retired `MiniMax-M2.7` and `MiniMax-M2.7-highspeed` and
 * promoted the model previously served anonymously (internally "space bunny")
 * as `MiniMax-M3.1-Flash`.
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
//#region src/credits.d.ts
/** The desktop app's own OAuth client id. */
declare const MINIMAX_OAUTH_CLIENT_ID = "mcode-public";
/** Membership endpoint: carries the credit summary. */
declare const MEMBERSHIP_PATH = "/matrix/api/v1/commerce/get_membership_info";
/** The OAuth credential the account endpoints accept. */
interface OAuthCredential {
  /** The `mmoat_` bearer token. */
  token: string;
  /** The refresh token, when the app stored one. */
  refreshToken?: string;
  /** Expiry in milliseconds since the epoch, when known. */
  expiresAtMs?: number;
  /** The client the token was issued to. */
  clientId: string;
  /** Scopes the token carries. */
  scopes: string[];
  /** Audience the token was issued for. */
  audience: string;
  /** The app's login generation; preserved verbatim on write-back. */
  generation?: number;
}
/** Why the account data may be unavailable. */
type OAuthState = {
  state: 'signed-in';
  credential: OAuthCredential;
} | {
  state: 'expired';
  credential: OAuthCredential;
} | {
  state: 'signed-out';
  reason: 'app-missing' | 'not-signed-in' | 'unreadable' | 'malformed';
};
/**
 * Parse the app's credential document.
 *
 * The record key is generated per install, so the record is found by value
 * rather than by a hard-coded name.
 */
declare function parseOAuthDocument(text: string, now?: number): OAuthState;
/**
 * Read the desktop app's OAuth credential.
 *
 * Every failure is a state, not an exception: an app that is not installed, or
 * not signed in, is a normal condition the UI renders rather than an error the
 * host logs on every request.
 */
declare function readOAuthCredential(region: MinimaxRegion, env?: NodeJS.ProcessEnv, now?: number): Promise<OAuthState>;
/**
 * Exchange the stored refresh token for a fresh access token.
 *
 * The authorization server rotates the refresh token, so the new pair is
 * written back into the app's own file, in the app's own format, with an
 * atomic replace. `generation` is left untouched on purpose: the app uses it
 * to decide whether a stored credential still belongs to its own login, and
 * raising it would make the app believe it had been signed in elsewhere.
 */
declare function refreshOAuthCredential(region: MinimaxRegion, credential: OAuthCredential, env?: NodeJS.ProcessEnv, now?: number, fetchImpl?: typeof fetch): Promise<OAuthState>;
/**
 * Write a rotated credential back into the app's store.
 *
 * The document is rewritten as a whole so the app's own reader keeps seeing
 * the shape it wrote, and the replace is atomic so a crash mid-write cannot
 * leave a truncated credential file behind.
 */
declare function writeOAuthCredential(region: MinimaxRegion, credential: OAuthCredential, env?: NodeJS.ProcessEnv): Promise<void>;
/**
 * Read the credential, refreshing it when it is close to expiry.
 *
 * A refresh is only attempted for a credential the app already stored, and
 * only when it is actually stale: a fresh token is left alone, so the plugin
 * never competes with the app for the same grant.
 */
declare function ensureOAuthCredential(region: MinimaxRegion, env?: NodeJS.ProcessEnv, now?: number, fetchImpl?: typeof fetch): Promise<OAuthState>;
/** The credit balance the desktop app shows. */
interface CreditSummary {
  /** Remaining credits, free plus purchased. */
  total: number;
  /** Remaining purchased credits. */
  purchased: number;
  /** Remaining free (granted) credits. */
  free: number;
}
/**
 * Read the credit summary out of a membership response.
 *
 * The app's settings page prefers the summary and falls back to the flat
 * balance fields, so the same fallback chain is used here.
 */
declare function parseCreditSummary(document: unknown): CreditSummary | undefined;
/**
 * Fetch the current credit balance.
 *
 * @returns The balance, or `undefined` when the account has no credit summary.
 */
declare function fetchCreditSummary(credential: OAuthCredential, region: MinimaxRegion, fetchImpl?: typeof fetch): Promise<CreditSummary | undefined>;
/** The balance plus what changed since the previous read. */
interface CreditSnapshot {
  summary: CreditSummary;
  /** Milliseconds since the epoch, when the balance was read. */
  fetchedAtMs: number;
  /**
   * Credits consumed since the previous read.
   *
   * The upstream balance is a live counter, so the difference between two
   * reads is the credits actually spent in between. It can be negative when
   * credits are granted (the app grants credits daily), and it counts every
   * client of the account, not just this one.
   */
  consumed: number;
}
/**
 * One grant of credits.
 *
 * Credits are granted in lots, and each lot carries its own expiry: the
 * desktop app grants credits daily, and a lot falls due thirty calendar days
 * after the day it was granted, at midnight in the account's own timezone.
 * Credits in a lot are lost when that moment arrives.
 */
interface CreditLot {
  /** How much this lot was granted. */
  granted: number;
  /** How much of it is left. */
  remaining: number;
  /** How much of it has been used. */
  consumed: number;
  /** When the lot was granted, in milliseconds since the epoch. */
  grantedAtMs: number;
  /** When the lot expires, in milliseconds since the epoch. */
  expireAtMs: number;
  /** The upstream's kind of lot, when it says. */
  creditType?: number;
}
/** What the lots say about credits that are about to be lost. */
interface ExpirySummary {
  /** Credits in lots that expire within {@link EXPIRING_WINDOW_DAYS} days. */
  expiring: number;
  /** How many lots that is. */
  expiringLots: number;
  /** Credits in lots that expire within {@link EXPIRING_HORIZON_DAYS} days. */
  expiringSoon: number;
  /** When the next lot with credits left expires. */
  nextExpiryAtMs?: number;
  /** The next lots with credits left, soonest first. */
  upcoming: {
    amount: number;
    expireAtMs: number;
  }[];
  /** Credits left across every lot. */
  totalRemaining: number;
}
/**
 * Keeps the current balance and the change between reads.
 *
 * The first read has nothing to compare against, so it reports no movement
 * rather than pretending the whole balance was spent.
 */
declare class MinimaxCredits {
  #private;
  /** The balance as last read. */
  get snapshot(): CreditSnapshot | undefined;
  /** Why the last read failed, when one did. */
  get error(): string | undefined;
  /** The credit lots as last read. */
  get lots(): readonly CreditLot[];
  /** What the lots say about expiry, when the ledger could be read. */
  get expiry(): ExpirySummary | undefined;
  /** When the ledger was last read. */
  get ledgerAtMs(): number | undefined;
  /** Why the ledger could not be read, when it could not. */
  get ledgerError(): string | undefined;
  /**
   * Read the balance and record how much was consumed since the last read.
   *
   * The credit ledger is read alongside it, but a ledger that cannot be read
   * never hides the balance: the two come from different endpoints and only
   * the balance is essential.
   *
   * @returns Whether the balance changed.
   */
  refresh(credential: OAuthCredential, region: MinimaxRegion, fetchImpl?: typeof fetch, now?: number): Promise<boolean>;
  /**
   * Read the credit ledger and work out what is about to expire.
   *
   * A failure here is remembered but never thrown: the balance is what the
   * user needs most, and a ledger that is temporarily unavailable must not
   * take it down with it.
   */
  refreshLedger(credential: OAuthCredential, region: MinimaxRegion, fetchImpl?: typeof fetch, now?: number): Promise<void>;
}
//#endregion
//#region src/usage.d.ts
/**
 * What a conversation actually cost.
 *
 * Every response from the gateway carries its own usage counters, so the
 * consumption of a session can be measured exactly rather than estimated from
 * the transcript. The upstream sends four numbers, and the distinction
 * between them matters: `input_tokens` counts only the tokens that missed the
 * prompt cache, so a naive sum understates a long conversation badly.
 *
 * The conversion to money uses MiniMax's published domestic price list
 * (元/百万 tokens). It is an equivalent amount, not a charge: the credits the
 * desktop app shows are a separate resource, and MiniMax publishes no
 * numeric exchange rate between the two.
 *
 * @module dsh-connect-minimaxcode/usage
 */
/** Token counts of one request, as the gateway reported them. */
interface ModelUsage {
  /** Tokens sent that missed the prompt cache. */
  inputTokens: number;
  /** Tokens produced. */
  outputTokens: number;
  /** Tokens served from the prompt cache. */
  cacheReadTokens: number;
  /** Tokens written into the prompt cache. */
  cacheWriteTokens: number;
  /** Tokens spent reasoning, when the model reports them separately. */
  reasoningTokens: number;
}
/** An empty usage record. */
declare const EMPTY_USAGE: ModelUsage;
/** Prices in 元 per million tokens, from MiniMax's domestic price list. */
interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}
/** The published domestic prices of the models this plugin serves. */
declare const MODEL_PRICES: Readonly<Record<string, ModelPrice>>;
/**
 * The price for one model at one input size.
 *
 * M3 is billed in two tiers: requests above 512k input tokens cost double.
 * The tier is decided by the billed input, which is the uncached input plus
 * the cache read.
 */
declare function priceFor(model: string, billedInputTokens: number): ModelPrice | undefined;
/**
 * The equivalent amount of one request, in 元.
 *
 * Returns `undefined` for a model without a published price, rather than
 * pretending the request was free.
 */
declare function estimateCny(model: string, usage: ModelUsage): number | undefined;
/** One recorded request. */
interface UsageRecord {
  model: string;
  usage: ModelUsage;
  /** Equivalent amount in 元, when the model has a published price. */
  cny?: number;
}
/**
 * Accumulates what the sessions routed through this plugin have used.
 *
 * The meter is the plugin's own view: it counts the requests this host made,
 * with the counters the gateway returned. It is not the account's total, and
 * it is not the credit balance — the balance comes from the account API.
 */
declare class UsageMeter {
  #private;
  /** Every recorded request, oldest first. */
  get records(): readonly UsageRecord[];
  /** The most recent request. */
  get last(): UsageRecord | undefined;
  /** Record one request's usage. */
  record(model: string, usage: ModelUsage): UsageRecord;
  /** Totals across every recorded request. */
  totals(): ModelUsage;
  /** Totals per model. */
  byModel(): ReadonlyMap<string, ModelUsage>;
  /** The equivalent amount of everything recorded, in 元. */
  estimatedCny(): number;
  /** Forget everything recorded. */
  reset(): void;
}
//#endregion
//#region src/credentials.d.ts
/** The file the plugin's own credential lives in. */
declare const PLUGIN_CREDENTIAL_FILENAME = ".minimaxcode-auth.json";
/** The file the plugin's own settings and session live in. */
declare const PLUGIN_STATE_FILENAME = ".minimaxcode-state.json";
/** The credential the plugin obtained for itself. */
interface PluginCredential {
  /** The document's shape. */
  schemaVersion: number;
  /** The OAuth client the token was issued to. */
  clientId: string;
  /** The scopes the token carries. */
  scopes: string[];
  /** The audience the token was issued for. */
  audience: string;
  /** The `mmoat_` bearer token. */
  accessToken: string;
  /** The refresh token, when the server issued one. */
  refreshToken?: string;
  /** Expiry in milliseconds since the epoch. */
  expiresAtMs?: number;
  /** When the token was obtained, in milliseconds since the epoch. */
  obtainedAtMs?: number;
}
/** A device login waiting for the person to authorize it. */
interface DeviceLoginSession {
  /** The device code the token endpoint is polled with. */
  deviceCode: string;
  /** The PKCE verifier that goes with the device code. */
  codeVerifier: string;
  /** The code the person types on the account page. */
  userCode: string;
  /** Where to authorize. */
  verificationUri: string;
  /** Where to authorize, with the code filled in. */
  verificationUriComplete: string;
  /** When the device code stops working, in milliseconds since the epoch. */
  expiresAtMs: number;
}
/** The plugin's own settings. */
interface PluginState {
  /** The document's shape. */
  schemaVersion: number;
  /** Whether the plugin claims the daily grant on its own. */
  autoCheckin: boolean;
  /** The day the last claim happened, in the account's time zone. */
  lastClaimDay?: string;
  /** When the last claim happened, in milliseconds since the epoch. */
  lastClaimAtMs?: number;
  /** The points the last claim granted. */
  lastClaimPoints?: number;
  /** A device login waiting to be authorized. */
  deviceLogin?: DeviceLoginSession;
}
/**
 * The Harness home.
 *
 * The host resolves it the same way: the `DSH_HOME` environment variable when
 * it is set, otherwise `~/.dsh`. The plugin resolves it on its own rather
 * than importing the host's helper, so it also works in a plain command line
 * where the host's packages are not installed.
 */
declare function dshHome(env?: NodeJS.ProcessEnv): string;
/** Where the plugin's credential lives. */
declare function pluginCredentialPath(env?: NodeJS.ProcessEnv): string;
/** Where the plugin's state lives. */
declare function pluginStatePath(env?: NodeJS.ProcessEnv): string;
/** Read the plugin's own credential. */
declare function readPluginCredential(env?: NodeJS.ProcessEnv): Promise<PluginCredential | undefined>;
/** Write the plugin's own credential. */
declare function writePluginCredential(credential: PluginCredential, env?: NodeJS.ProcessEnv): Promise<void>;
/** Read the plugin's own state. */
declare function readPluginState(env?: NodeJS.ProcessEnv): Promise<PluginState>;
/** Write the plugin's own state. */
declare function writePluginState(state: PluginState, env?: NodeJS.ProcessEnv): Promise<void>;
//#endregion
//#region src/login.d.ts
/** The endpoint that issues device codes. */
declare const DEVICE_CODE_PATH = "/oauth2/device/code";
/** The device authorization grant type. */
declare const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** How a device login is going. */
type DeviceLoginState =
/** The person has not authorized it yet. */
{
  state: 'pending';
} |
/** The authorization server asked the client to slow down. */
{
  state: 'slow-down';
} |
/** The device code expired before the person authorized it. */
{
  state: 'expired';
  message?: string;
} |
/** The person declined. */
{
  state: 'denied';
  message?: string;
} |
/** The grant arrived. */
{
  state: 'signed-in';
  credential: PluginCredential;
};
/**
 * Make a PKCE verifier and its S256 challenge.
 *
 * The verifier is 43 characters of base64url entropy, which is what RFC 7636
 * asks for, and it never leaves this process.
 */
declare function makePkce(): {
  verifier: string;
  challenge: string;
};
/**
 * Ask for a device code.
 *
 * @returns The session the person authorizes, or `undefined` when the server
 *   would not issue one.
 */
declare function startDeviceLogin(region: MinimaxRegion, fetchImpl?: typeof fetch, now?: number): Promise<DeviceLoginSession | undefined>;
/**
 * Poll for the grant.
 *
 * The authorization server answers `400` while the person has not authorized
 * yet, with `authorization_pending` in the body; that is a normal answer, not
 * an error.
 */
declare function pollDeviceLogin(session: DeviceLoginSession, region: MinimaxRegion, fetchImpl?: typeof fetch, now?: number): Promise<DeviceLoginState>;
/**
 * Exchange the stored refresh token for a fresh access token.
 *
 * The authorization server rotates the refresh token, so the new pair
 * replaces the old one wherever it is kept.
 */
declare function refreshPluginCredential(credential: PluginCredential, region: MinimaxRegion, fetchImpl?: typeof fetch, now?: number): Promise<PluginCredential>;
//#endregion
//#region src/signin.d.ts
/** The claim endpoint. */
declare const SIGNIN_CLAIM_PATH = "/minimax-cloud/api/v1/signin/claim";
/** The cycle endpoint, which reports the panel. */
declare const SIGNIN_PANEL_PATH = "/minimax-cloud/api/v1/signin/status";
/** Per-day status, as the desktop app enumerates it. */
declare const SIGNIN_DAY_STATUS: {
  /** The day has not come yet. */
  readonly upcoming: 1;
  /** The day is today and can be claimed. */
  readonly claimable: 2;
  /** The day is claimed. */
  readonly claimed: 3;
  /** The day does not grant anything. */
  readonly disabled: 4;
};
/** The status of one day in the cycle. */
type SigninDayStatus = (typeof SIGNIN_DAY_STATUS)[keyof typeof SIGNIN_DAY_STATUS];
/** How many days a cycle runs. */
declare const SIGNIN_CYCLE_DAYS = 7;
/** The outcome of a claim. */
declare const SIGNIN_CLAIM_RESULT: {
  /** The grant was credited. */
  readonly credited: 1;
  /** Today was already claimed; nothing was granted. */
  readonly alreadyClaimed: 2;
};
/** The outcome of a claim. */
type SigninClaimResult = (typeof SIGNIN_CLAIM_RESULT)[keyof typeof SIGNIN_CLAIM_RESULT];
/** One day of the cycle. */
interface SigninDay {
  /** Which day of the cycle this is, 1 to 7. */
  dayNo: number;
  /** Points the day grants. */
  points: number;
  /** Extra points on top, when the day carries a bonus. */
  bonusPoints: number;
  /** The day's status. */
  status: SigninDayStatus;
  /** Whether this is today. */
  isToday: boolean;
}
/** The cycle as the server reports it. */
interface SigninPanel {
  /** Which cycle the account is in. */
  scene: number;
  /** The days of the cycle. */
  days: SigninDay[];
}
/** The result of claiming today's grant. */
interface SigninClaim {
  /** The server's identifier for the claim. */
  claimId: string;
  /** Whether the grant was credited or the day was already claimed. */
  result: SigninClaimResult;
  /** Which day of the cycle was claimed. */
  dayNo: number;
  /** Points granted. */
  points: number;
  /** Extra points granted. */
  bonusPoints: number;
  /** When the granted points expire, in milliseconds since the epoch. */
  expireAtMs: number;
  /** The cycle after the claim. */
  panel?: SigninPanel;
}
/**
 * The time zone the server should treat the request as coming from.
 *
 * The server wants an IANA name; an offset or a missing value is refused.
 * The system's own name is the right answer, since "today" should be the
 * user's today.
 */
declare function timezoneId(): string;
/**
 * Read the cycle out of a panel response.
 *
 * The server marks exactly one day as today and at most one day as claimable;
 * a panel that says otherwise is not something to act on, so it is refused
 * rather than half-believed.
 */
declare function parseSigninPanel(document: unknown): SigninPanel | undefined;
/** Read the result of a claim. */
declare function parseSigninClaim(document: unknown): SigninClaim | undefined;
/**
 * Read the cycle.
 *
 * @returns The panel, or `undefined` when the account cannot read it.
 */
declare function fetchSigninPanel(credential: OAuthCredential, region: MinimaxRegion, fetchImpl?: typeof fetch, timezone?: string): Promise<SigninPanel | undefined>;
/**
 * Claim today's grant.
 *
 * This is the only request in the plugin that changes something upstream. It
 * grants the day's points, which expire thirty days later.
 *
 * @returns What the server answered, or `undefined` when it refused.
 */
declare function claimSignin(credential: OAuthCredential, region: MinimaxRegion, fetchImpl?: typeof fetch, timezone?: string): Promise<SigninClaim | undefined>;
/** The day's key in the account's own time zone, `YYYY-MM-DD`. */
declare function localDay(now?: number, timezone?: string): string;
//#endregion
//#region src/status-route.d.ts
/** Route this plugin mounts, matching its settings card. */
declare const MINIMAX_STATUS_PATH = "/plugins/dsh-connect-minimaxcode/status";
/** Route the card posts to when it wants something done rather than read. */
declare const MINIMAX_ACTION_PATH = "/plugins/dsh-connect-minimaxcode/action";
/** The daily check-in, as the card reads it. */
interface SigninStatus {
  /** Whether the cycle could be read. */
  state: 'ok' | 'unavailable';
  /** Today's day in the cycle. */
  today?: {
    /** Which day of the cycle it is, 1 to 7. */
    dayNo: number;
    /** Points the day grants. */
    points: number;
    /** The day's status, as the upstream numbers it. */
    status: number;
    /** Whether the day can be claimed. */
    claimable: boolean;
    /** Whether the day is already claimed. */
    claimed: boolean;
  };
  /** The days of the cycle. */
  days?: {
    dayNo: number;
    points: number;
    status: number;
    isToday: boolean;
  }[];
  /** Points the whole cycle is worth. */
  cyclePoints?: number;
  /** Whether the plugin claims the day's grant on its own. */
  autoCheckin: boolean;
  /** The day the last claim happened. */
  lastClaimDay?: string;
  /** When the last claim happened, in milliseconds since the epoch. */
  lastClaimAtMs?: number;
  /** Points the last claim granted. */
  lastClaimPoints?: number;
  /** Whether the last claim was credited, or the day was already claimed. */
  lastClaimResult?: number;
  /** Why the cycle or the claim could not be read. */
  error?: string;
}
/** How the plugin is signed in, as the card reads it. */
interface LoginStatus {
  /** Whether the plugin has a usable credential. */
  state: 'signed-in' | 'signed-out' | 'pending';
  /** Where the credential came from. */
  source?: 'plugin' | 'desktop-app';
  /** The code to type on the account page, while a sign-in is waiting. */
  userCode?: string;
  /** Where to authorize. */
  verificationUri?: string;
  /** Where to authorize, with the code filled in. */
  verificationUriComplete?: string;
  /** When the device code stops working, in milliseconds since the epoch. */
  expiresAtMs?: number;
}
/** The account's credit balance, as the desktop app shows it. */
interface CreditStatus {
  /** Whether the balance could be read. */
  state: 'ok' | 'unavailable' | 'expired' | 'signed-out';
  /** Remaining credits, free plus purchased. */
  total?: number;
  /** Remaining purchased credits. */
  purchased?: number;
  /** Remaining free (granted) credits. */
  free?: number;
  /** Credits consumed between the two last reads. */
  consumed?: number;
  /** When the balance was read, in milliseconds since the epoch. */
  updatedAtMs?: number;
  /** Why the balance could not be read. */
  error?: string;
  /** Credits that expire within the next week. */
  expiring?: number;
  /** How many grants that is. */
  expiringLots?: number;
  /** Credits that expire within the next month. */
  expiringSoon?: number;
  /** When the next grant with credits left expires. */
  nextExpiryAtMs?: number;
  /** The next grants with credits left, soonest first. */
  upcoming?: {
    amount: number;
    expireAtMs: number;
  }[];
  /** When the ledger was read, in milliseconds since the epoch. */
  ledgerAtMs?: number;
  /** Why the ledger could not be read. */
  ledgerError?: string;
}
/** What the plugin's own requests have used. */
interface UsageStatus {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Equivalent amount of everything this host spent, in 元. */
  estimatedCny: number;
  /** The equivalent amount of the last request, in 元. */
  lastCny?: number;
  /** The model of the last request. */
  lastModel?: string;
  /** How many requests were measured. */
  requests: number;
}
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
  /** The account's credit balance, when it could be read. */
  credits?: CreditStatus;
  /** What this host's requests have used. */
  usage?: UsageStatus;
  /** The daily check-in, when it could be read. */
  signin?: SigninStatus;
  /** How the plugin is signed in. */
  login?: LoginStatus;
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
  /** The account's credit balance, when the account API could be reached. */
  credits?: CreditStatus;
  /** What this host's requests have used. */
  usage?: UsageStatus;
  /** The daily check-in, when the account API could be reached. */
  signin?: SigninStatus;
  /** How the plugin is signed in. */
  login?: LoginStatus;
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
  /**
   * Called with the usage the gateway reported for a finished request.
   *
   * The counters come from the upstream response, not from an estimate of the
   * transcript, so what is reported is what was actually billed.
   */
  onUsage?: (model: string, usage: ModelUsage) => void;
}
/** What {@link createMinimaxCodeAdapter} hands back. */
interface AdapterBundle {
  /**
   * The adapter the host registers.
   *
   * It is the pi-ai adapter itself, or a wrapper around it that copies the
   * usage counters out of the stream.
   */
  adapter: LlmAdapter;
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
export { type AuthState, type CatalogModel, type CatalogSource, type Credential, type CreditSummary, DEVICE_CODE_GRANT, DEVICE_CODE_PATH, type DeviceLoginState, EMPTY_USAGE, FALLBACK_MODELS, MEMBERSHIP_PATH, MINIMAXCODE_PROVIDER_ID, MINIMAX_ACTION_PATH, MINIMAX_AUTH_FILENAME, MINIMAX_DATA_DIR, MINIMAX_GATEWAYS, MINIMAX_OAUTH_CLIENT_ID, MINIMAX_REGIONS, MINIMAX_STATUS_PATH, MINIMAX_STREAM_IDLE_TIMEOUT_MS, MODEL_PRICES, MinimaxCatalog, MinimaxCredits, type MinimaxRegion, type ModelUsage, type OAuthCredential, type OAuthState, PLUGIN_CREDENTIAL_FILENAME, PLUGIN_STATE_FILENAME, type PluginCredential, type PluginState, SIGNIN_CLAIM_PATH, SIGNIN_CLAIM_RESULT, SIGNIN_CYCLE_DAYS, SIGNIN_DAY_STATUS, SIGNIN_PANEL_PATH, type SigninClaim, type SigninDay, type SigninPanel, type StatusDocument, type TokenClaims, UsageMeter, apply, authPath, bearerToken, catalogUrl, chatBaseUrl, claimSignin, createMinimaxCodeAdapter, dataDir, daysRemaining, decodeClaims, dshHome, ensureOAuthCredential, estimateCny, expiresInMs, expiryLevel, fetchCreditSummary, fetchSigninPanel, inject, localDay, makePkce, name, parseAuthDocument, parseCatalog, parseCreditSummary, parseOAuthDocument, parseSigninClaim, parseSigninPanel, pluginCredentialPath, pluginStatePath, pollDeviceLogin, priceFor, readCredential, readOAuthCredential, readPluginCredential, readPluginState, refreshOAuthCredential, refreshPluginCredential, startDeviceLogin, statusDocument, timezoneId, writeOAuthCredential, writePluginCredential, writePluginState };