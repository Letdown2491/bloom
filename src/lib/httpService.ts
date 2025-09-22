import axios, { AxiosError } from "axios";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type HttpRequestOptions = {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  signal?: AbortSignal;
  retries?: number;
  retryDelayMs?: number;
  retryJitterRatio?: number;
  retryMaxDelayMs?: number;
  retryOn?: (error: BloomHttpError) => boolean;
  source?: string;
  credentials?: RequestCredentials;
  mode?: RequestMode;
};

export class BloomHttpError extends Error {
  status?: number;
  code?: string;
  data?: unknown;
  request?: { url: string; method: HttpMethod };
  retryable?: boolean;
  source?: string;

  constructor(message: string, options: {
    status?: number;
    code?: string;
    data?: unknown;
    request?: { url: string; method: HttpMethod };
    retryable?: boolean;
    source?: string;
    cause?: unknown;
  } = {}) {
    super(message);
    this.name = "BloomHttpError";
    this.status = options.status;
    this.code = options.code;
    this.data = options.data;
    this.request = options.request;
    this.retryable = options.retryable;
    this.source = options.source;
    if ("cause" in options && options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

const DEFAULT_RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const isRetryableStatus = (status?: number) => (status ? DEFAULT_RETRYABLE_STATUS.has(status) : false);

const extractMessage = (payload: unknown): string | undefined => {
  if (!payload) return undefined;
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const maybeMessage = (payload as { message?: unknown }).message;
    if (typeof maybeMessage === "string" && maybeMessage.trim()) return maybeMessage;
    const errorProp = (payload as { error?: unknown }).error;
    if (typeof errorProp === "string" && errorProp.trim()) return errorProp;
  }
  return undefined;
};

const buildHttpErrorFromResponse = async (
  response: Response,
  options: { request: { url: string; method: HttpMethod }; source?: string }
): Promise<BloomHttpError> => {
  let data: unknown;
  try {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      data = await response.clone().json();
    } else {
      const text = await response.clone().text();
      data = text || undefined;
    }
  } catch (error) {
    data = undefined;
  }

  const message =
    extractMessage(data) ||
    `Request to ${options.request.url} failed with status ${response.status}${response.statusText ? ` (${response.statusText})` : ""}`;

  return new BloomHttpError(message, {
    status: response.status,
    data,
    request: options.request,
    retryable: isRetryableStatus(response.status),
    source: options.source,
  });
};

const normalizeError = (error: unknown, context: { request: { url: string; method: HttpMethod }; source?: string }) => {
  if (error instanceof BloomHttpError) {
    return error;
  }
  if (error instanceof Error) {
    return new BloomHttpError(error.message || "Request failed", {
      request: context.request,
      source: context.source,
      cause: error,
      retryable: !(error instanceof TypeError),
    });
  }
  return new BloomHttpError("Request failed", {
    request: context.request,
    source: context.source,
  });
};

const shouldRetry = (error: BloomHttpError, retryOn?: (error: BloomHttpError) => boolean) => {
  if (retryOn) {
    try {
      return retryOn(error);
    } catch (callbackError) {
      console.error(callbackError);
      return false;
    }
  }
  if (typeof error.retryable === "boolean") {
    return error.retryable;
  }
  return isRetryableStatus(error.status);
};

export const httpRequest = async (options: HttpRequestOptions): Promise<Response> => {
  const {
    url,
    method = "GET",
    headers = {},
    body,
    signal,
    retries = 0,
    retryDelayMs = 600,
    retryJitterRatio = 0.35,
    retryMaxDelayMs = 30_000,
    retryOn,
    source,
    credentials,
    mode,
  } = options;

  const requestContext = { request: { url, method }, source };

  let attempt = 0;
  let lastError: BloomHttpError | null = null;

  while (attempt <= retries) {
    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal,
        credentials,
        mode,
      });

      if (!response.ok) {
        throw await buildHttpErrorFromResponse(response, requestContext);
      }

      return response;
    } catch (error) {
      const normalized = normalizeError(error, requestContext);
      lastError = normalized;
      if (attempt >= retries || !shouldRetry(normalized, retryOn) || signal?.aborted) {
        throw normalized;
      }
      const baseDelay = retryDelayMs * Math.pow(2, attempt);
      const jitter = retryJitterRatio > 0 ? baseDelay * retryJitterRatio * Math.random() : 0;
      const waitMs = Math.min(retryMaxDelayMs, Math.round(baseDelay + jitter));
      attempt += 1;
      if (signal?.aborted) {
        throw normalized;
      }
      await delay(waitMs);
    }
  }

  throw lastError ?? new BloomHttpError("Request failed", requestContext);
};

export const requestJson = async <T = unknown>(
  options: HttpRequestOptions & { parse?: (value: unknown) => T; fallbackValue?: T }
): Promise<T> => {
  const response = await httpRequest({
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
  });

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    throw new BloomHttpError("Failed to parse JSON response", {
      request: { url: options.url, method: options.method ?? "GET" },
      source: options.source,
      cause: error,
    });
  }

  if (options.parse) {
    return options.parse(data);
  }

  return data as T;
};

export const readJsonBody = async (response: Response) => {
  try {
    return await response.json();
  } catch (error) {
    return undefined;
  }
};

export const fromAxiosError = (
  error: unknown,
  context: {
    url: string;
    method: HttpMethod;
    source?: string;
    fallbackMessage?: string;
    retryable?: boolean;
  }
): BloomHttpError => {
  if (error instanceof BloomHttpError) return error;

  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError;
    const status = axiosError.response?.status;
    const data = axiosError.response?.data;
    const message =
      extractMessage(data) ||
      axiosError.message ||
      context.fallbackMessage ||
      `Request to ${context.url} failed${status ? ` with status ${status}` : ""}`;

    return new BloomHttpError(message, {
      status,
      code: axiosError.code || undefined,
      data,
      request: { url: context.url, method: context.method },
      retryable: context.retryable ?? isRetryableStatus(status),
      source: context.source,
      cause: error,
    });
  }

  return new BloomHttpError(context.fallbackMessage || "Request failed", {
    request: { url: context.url, method: context.method },
    source: context.source,
    cause: error instanceof Error ? error : undefined,
    retryable: context.retryable,
  });
};
