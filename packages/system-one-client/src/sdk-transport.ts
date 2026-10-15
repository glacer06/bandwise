// SdkTransport: System One calls through @typesafe-ai/sdk, on TypeSafe direct, OpenRouter
// (ADR-011) or Vercel AI Gateway (ADR-013). This package is the only importer of the SDK.
//
// Every client is built with an explicit baseURL (from core's SYSTEM_ONE_PROVIDER_BASE_URLS, never
// env), defaultModel, logLevel "warn" and the scrubbing logger, so TYPESAFE_BASE_URL,
// TYPESAFE_DEFAULT_MODEL and TYPESAFE_LOG_LEVEL can never steer tenant traffic or log its bodies.
// Compression is explicit too: off on every provider (SDK_COMPRESSION).
// Retries belong to the SDK: each call passes its timeout and retry budget; there is no second loop.
//
// The request body is built field by field from SystemOneRequest (state, model, questions), so no
// `providerOptions` is ever sent and Vercel's evaluation fallbacks stay off (ADR-013). A response
// that still shows a fallback is rejected by assertNotEvaluationFallback, which reads the headers
// the SDK exposes through withResponse().

import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  type Compression,
  type EntryType,
  type Questions,
  TypeSafeClient,
  type TypeSafeClientConfig,
  TypeSafeError,
} from "@typesafe-ai/sdk";
import {
  ERROR_CODES,
  SYSTEM_ONE_PROVIDER_BASE_URLS,
  type SystemOneCallOptions,
  type SystemOneCallResult,
  type SystemOneProvider,
  type SystemOneRequest,
  SystemOneResponse,
  type SystemOneTransport,
  TransportError,
  isTransportError,
} from "@bandwise/core";
import { ClientCache } from "./client-cache.js";
import { assertNotEvaluationFallback } from "./fixture/fallback-guard.js";
import { transportErrorForStatus } from "./fixture/status-map.js";
import { type LogSink, createScrubbingLogger } from "./logger.js";

/** The log level every SDK client gets. `debug` would log request bodies unredacted. */
export const SDK_LOG_LEVEL = "warn" as const;

/**
 * Request body compression for every SDK client. SDK 0.7 defaults to zstd on Node 22.15 or newer,
 * so the default would differ between runtimes, and the OpenRouter and Vercel routes (ADR-011,
 * ADR-013) were only ever checked with plain bodies. Off everywhere keeps the wire what it was on
 * SDK 0.6. Turning it on for a provider needs a live smoke on that provider first, and for
 * OpenRouter or Vercel an amendment to its ADR.
 */
export const SDK_COMPRESSION: Compression = false;

/**
 * SDK 0.7 reads this pattern anywhere in a request as a reference to an attached image and, with no
 * image attached, rejects the call before sending. Bandwise attaches no images, so a match in the
 * state is caller text the SDK will not send: it fails as invalid_state, not as a System One
 * rejection. A match in a question's text is a spec problem and stays system_one_invalid_request.
 */
export const SDK_IMAGE_REFERENCE = /<image:[0-9a-f]{32}>/;

export interface SdkTransportOptions {
  /** Where the scrubbing logger writes. Default: console. */
  logSink?: LogSink;
  /** A fetch implementation for tests or transport configuration. Default: global fetch. */
  fetch?: TypeSafeClientConfig["fetch"];
  /** Most clients kept (one per provider and key). */
  maxClients?: number;
}

/** Build one SDK client for a provider and key, with every safety option explicit. */
export function createSdkClient(
  provider: SystemOneProvider,
  apiKey: string,
  defaultModel: string,
  options: Pick<SdkTransportOptions, "logSink" | "fetch"> = {},
): TypeSafeClient {
  const config: TypeSafeClientConfig = {
    apiKey,
    baseURL: SYSTEM_ONE_PROVIDER_BASE_URLS[provider],
    defaultModel,
    logLevel: SDK_LOG_LEVEL,
    logger: createScrubbingLogger(options.logSink),
    compression: SDK_COMPRESSION,
    dangerouslyAllowBrowser: false,
  };
  if (options.fetch !== undefined) config.fetch = options.fetch;
  return new TypeSafeClient(config);
}

/** Map any error from the SDK to a scrubbed TransportError (system-one-api-contract.md, Errors). */
export function mapSdkError(e: unknown, provider: SystemOneProvider): TransportError {
  if (isTransportError(e)) return e;
  if (e instanceof APIUserAbortError) {
    return new TransportError({ code: "client_aborted", retryable: false, requestId: null }, "the call was aborted");
  }
  if (e instanceof APIConnectionError) {
    // Includes APITimeoutError. The SDK already retried.
    return new TransportError(
      { code: "system_one_unavailable", retryable: ERROR_CODES.system_one_unavailable.retryable, requestId: null },
      `System One on ${provider} could not be reached`,
    );
  }
  if (e instanceof APIError) return transportErrorForStatus(e.status, provider, e.requestId ?? null);
  if (e instanceof TypeSafeError) {
    // Raised before sending, for example empty questions, a null state, or an image reference in a
    // question's text: a compiler or spec bug. An image reference in the state is caught in call().
    return new TransportError({ code: "system_one_invalid_request", retryable: false, requestId: null }, "the SDK rejected the request before sending it");
  }
  return new TransportError(
    { code: "system_one_unavailable", retryable: ERROR_CODES.system_one_unavailable.retryable, requestId: null },
    "System One call failed",
  );
}

export class SdkTransport implements SystemOneTransport {
  private readonly clients: ClientCache<TypeSafeClient>;

  constructor(private readonly options: SdkTransportOptions = {}) {
    this.clients = new ClientCache(options.maxClients);
  }

  /** Clients currently cached. */
  get cachedClients(): number {
    return this.clients.size;
  }

  /** Drop the cached client for a key, for example after rotation or a 401. */
  evict(provider: SystemOneProvider, apiKey: string): void {
    this.clients.evict(provider, apiKey);
  }

  async call(req: SystemOneRequest, opts: SystemOneCallOptions): Promise<SystemOneCallResult> {
    if (req.state != null && SDK_IMAGE_REFERENCE.test(JSON.stringify(req.state))) {
      throw new TransportError(
        { code: "invalid_state", retryable: false, requestId: null },
        "the state holds a literal <image:...> reference, which the SDK will not send without an attached image",
      );
    }
    const client = this.clients.getOrCreate(opts.provider, opts.apiKey, () =>
      createSdkClient(opts.provider, opts.apiKey, req.model, this.options),
    );
    try {
      const { data, requestId, response } = await client
        .systemOne(
          { state: req.state as NonNullable<EntryType>, model: req.model, questions: req.questions as unknown as Questions },
          { timeout: opts.timeoutMs, retry: { maxRetries: opts.retry.maxRetries, maxRetryAfterMs: opts.retry.maxRetryAfterMs }, signal: opts.signal },
        )
        .withResponse();
      const parsed = SystemOneResponse.safeParse(data);
      if (!parsed.success) {
        throw new TransportError(
          { code: "system_one_unavailable", retryable: false, requestId: requestId ?? null },
          `System One on ${opts.provider} returned a response Bandwise cannot read`,
        );
      }
      const id = requestId ?? parsed.data.id ?? null;
      assertNotEvaluationFallback(parsed.data, opts.provider, id, response.headers);
      return { response: parsed.data, requestId: id };
    } catch (e) {
      throw mapSdkError(e, opts.provider);
    }
  }
}
