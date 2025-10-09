import 'dotenv/config';
import express from 'express';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { nip04, nip44, type Event as NostrEvent, SimplePool } from 'nostr-tools';
import { hexToBytes, normalizeURL } from 'nostr-tools/utils';
import { Readable } from 'node:stream';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';

const PRIVATE_LINK_EVENT_KIND = 30001;
const DEFAULT_CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 60);
const relayUrls = (process.env.RELAY_URLS || '')
  .split(',')
  .map(url => url.trim())
  .filter(Boolean)
  .map(url => {
    try {
      return normalizeURL(url);
    } catch (error) {
      logger.warn({ url, err: error }, 'invalid relay url, skipping');
      return null;
    }
  })
  .filter((url): url is string => typeof url === 'string');

if (!process.env.PRIVATE_LINK_SERVICE_SECRET) {
  throw new Error('PRIVATE_LINK_SERVICE_SECRET is required');
}
if (relayUrls.length === 0) {
  throw new Error('RELAY_URLS is required');
}

const rawServiceSecret = process.env.PRIVATE_LINK_SERVICE_SECRET.trim();
let serviceSecret: string;
let serviceSecretBytes: Uint8Array;

try {
  serviceSecret = rawServiceSecret.toLowerCase();
  serviceSecretBytes = hexToBytes(serviceSecret);
} catch (error) {
  throw new Error('PRIVATE_LINK_SERVICE_SECRET must be a valid hex string');
}

if (serviceSecretBytes.length !== 32) {
  throw new Error('PRIVATE_LINK_SERVICE_SECRET must represent a 32-byte key');
}
const blossomHeaderConfig = (process.env.BLOSSOM_REQUEST_HEADERS || '')
  .split(';')
  .map(entry => entry.trim())
  .filter(Boolean)
  .map(entry => {
    const index = entry.indexOf(':');
    if (index === -1) return null;
    const key = entry.slice(0, index).trim();
    const value = entry.slice(index + 1).trim();
    return key && value ? [key, value] : null;
  })
  .filter((entry): entry is [string, string] => Array.isArray(entry));

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const pool = new SimplePool();

const app = express();
app.use(pinoHttp({ logger }));

const aliasPattern = /^[a-z0-9]{6,128}$/;

app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

type CacheEntry = {
  status: 'active' | 'revoked';
  targetUrl: string | null;
  cacheExpiresAt: number;
  linkExpiresAt?: number | null;
  reason?: 'revoked' | 'expired';
};

const aliasCache = new Map<string, CacheEntry>();

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function normalizeExpiration(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return null;
  const normalized = Math.floor(numeric);
  if (normalized <= 0) return null;
  return normalized;
}

function extractExpirationTag(event: NostrEvent): number | null {
  const tag = event.tags.find(entry => Array.isArray(entry) && entry[0] === 'expiration' && typeof entry[1] === 'string');
  if (!tag) return null;
  return normalizeExpiration(tag[1]);
}

async function decryptEnvelope(event: NostrEvent): Promise<PrivateLinkEnvelope | null> {
  const ciphertext = event.content;
  const pubkey = event.pubkey;
  if (!ciphertext || !pubkey) return null;
  const attempts = [
    () => {
      const conversationKey = nip44.getConversationKey(serviceSecretBytes, pubkey);
      return nip44.decrypt(ciphertext, conversationKey);
    },
    () => nip04.decrypt(serviceSecret, pubkey, ciphertext),
  ];
  for (const attempt of attempts) {
    try {
      const plaintext = await attempt();
      if (!plaintext) continue;
      const parsed = JSON.parse(plaintext);
      if (!parsed || typeof parsed !== 'object') continue;
      if (parsed.version !== 1) continue;
      return parsed as PrivateLinkEnvelope;
    } catch (error) {
      logger.error({ err: error, pubkey, alias }, 'decrypt attempt failed');
      continue;
    }
  }
  return null;
}

async function fetchAlias(alias: string): Promise<CacheEntry | null> {
  const events = await pool.querySync(
    relayUrls,
    { kinds: [PRIVATE_LINK_EVENT_KIND], '#d': [alias] },
    { maxWait: 5000 }
  );
  if (events.length === 0) return null;

  events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  const nowTs = nowSeconds();
  for (const event of events) {
    const envelope = await decryptEnvelope(event);
    if (!envelope) continue;
    if (envelope.alias !== alias) continue;
    const tagExpiration = extractExpirationTag(event);
    const linkExpiresAt = normalizeExpiration(envelope.expiresAt ?? tagExpiration);
    if (typeof linkExpiresAt === 'number' && linkExpiresAt <= nowTs) {
      return {
        status: 'revoked',
        targetUrl: null,
        cacheExpiresAt: nowTs + DEFAULT_CACHE_TTL_SECONDS,
        linkExpiresAt,
        reason: 'expired',
      };
    }
    if (envelope.status === 'revoked') {
      return {
        status: 'revoked',
        targetUrl: null,
        cacheExpiresAt: nowTs + DEFAULT_CACHE_TTL_SECONDS,
        linkExpiresAt: linkExpiresAt ?? null,
        reason: 'revoked',
      };
    }
    const url = envelope.target?.url || buildUrlFromTarget(envelope.target);
    if (!url) continue;
    return {
      status: 'active',
      targetUrl: url,
      cacheExpiresAt: nowTs + DEFAULT_CACHE_TTL_SECONDS,
      linkExpiresAt: linkExpiresAt ?? null,
    };
  }
  return null;
}

function buildUrlFromTarget(target: PrivateLinkTarget | null | undefined): string | null {
  if (!target) return null;
  if (target.url) return target.url;
  if (target.server && target.sha256) {
    const normalized = target.server.replace(/\/+$/, '');
    return `${normalized}/${target.sha256}`;
  }
  return null;
}

async function resolveAlias(alias: string): Promise<CacheEntry | null> {
  const cached = aliasCache.get(alias);
  const nowTs = nowSeconds();
  if (cached && cached.cacheExpiresAt > nowTs) {
    if (
      cached.status === 'active' &&
      typeof cached.linkExpiresAt === 'number' &&
      cached.linkExpiresAt <= nowTs
    ) {
      const expiredEntry: CacheEntry = {
        ...cached,
        status: 'revoked',
        targetUrl: null,
        reason: 'expired',
        cacheExpiresAt: nowTs + DEFAULT_CACHE_TTL_SECONDS,
      };
      aliasCache.set(alias, expiredEntry);
      return expiredEntry;
    }
    return cached;
  }
  const entry = await fetchAlias(alias);
  if (entry) {
    aliasCache.set(alias, entry);
  }
  return entry;
}

app.get('/:alias', async (req, res) => {
  const rawAlias = (req.params.alias || '').toLowerCase();
  const alias = rawAlias.replace(/[^a-z0-9]+.*$/, '');
  req.log.info({ rawAlias, alias }, 'alias request');
  if (!aliasPattern.test(alias)) {
    res.status(400).json({ error: 'invalid alias' });
    return;
  }
  try {
    const record = await resolveAlias(alias);
    if (!record) {
      res.status(404).json({ error: 'alias not found' });
      return;
    }
    if (record.status === 'revoked' || !record.targetUrl) {
      const errorMessage = record.reason === 'expired' ? 'alias expired' : 'alias revoked';
      res.status(410).json({ error: errorMessage });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(record.targetUrl, {
        signal: controller.signal,
        headers: buildBlossomHeaders(),
      });
      clearTimeout(timeout);
      if (!response.ok || !response.body) {
        const details = await response.text().catch(() => null);
        res.status(response.status).json({ error: 'upstream fetch failed', details: details || undefined });
        return;
      }

      const body = response.body as unknown;
      const upstreamStream: NodeJS.ReadableStream | null =
        body && typeof (body as { pipe?: unknown }).pipe === 'function'
          ? (body as NodeJS.ReadableStream)
          : body && typeof Readable.fromWeb === 'function'
            ? (Readable.fromWeb(body as NodeReadableStream<Uint8Array>) as unknown as NodeJS.ReadableStream)
            : null;

      res.status(response.status);
      const contentType = response.headers.get('content-type');
      if (contentType) {
        res.setHeader('content-type', contentType);
      }
      const contentLength = response.headers.get('content-length');
      if (contentLength) {
        res.setHeader('content-length', contentLength);
      }

      if (upstreamStream) {
        upstreamStream.pipe(res);
      } else {
        const buffer = Buffer.from(await response.arrayBuffer());
        res.send(buffer);
      }
    } catch (error) {
      clearTimeout(timeout);
      if ((error as Error).name === 'AbortError') {
        res.status(504).json({ error: 'upstream timeout' });
        return;
      }
      req.log.error({ err: error, alias }, 'upstream fetch failed');
      res.status(502).json({ error: 'failed to fetch target' });
    }
  } catch (error) {
    req.log.error({ err: error, alias }, 'alias lookup failed');
    res.status(500).json({ error: 'internal error' });
  }
});

function buildBlossomHeaders(): Record<string, string> {
  if (blossomHeaderConfig.length === 0) return {};
  return blossomHeaderConfig.reduce<Record<string, string>>((acc, [key, value]) => {
    acc[key] = value;
    return acc;
  }, {});
}

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  logger.info({ port }, 'private-link proxy started');
});

process.on('SIGTERM', () => {
  pool.close(relayUrls);
  process.exit(0);
});

process.on('SIGINT', () => {
  pool.close(relayUrls);
  process.exit(0);
});

// types

type PrivateLinkTarget = {
  url?: string | null;
  server?: string | null;
  sha256?: string | null;
};

type PrivateLinkEnvelope = {
  version: number;
  alias: string;
  status: 'active' | 'revoked';
  createdAt?: number;
  revokedAt?: number | null;
  target?: PrivateLinkTarget | null;
  expiresAt?: number | null;
};
