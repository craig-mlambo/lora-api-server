import Fastify from 'fastify';
import { decodeBase64, decodeCjt188, CJT188Error } from './decoder.js';

const fastify = Fastify({ logger: true });

// TTN Storage Integration config (see .env / .env.example)
const TTN_STORAGE_URL =
  process.env.TTN_STORAGE_URL ??
  'https://eu1.cloud.thethings.network/api/v3/as/applications/lye-application-01/packages/storage/uplink_message';
const TTN_API_KEY = process.env.TTN_API_KEY ?? '';

// Fetch uplink history from the TTN Storage Integration for a given time window.
// Returns { ok, status, uplinks, detail }.
async function fetchUplinks(last) {
  const url = `${TTN_STORAGE_URL}?last=${encodeURIComponent(last)}`;

  let upstream;
  try {
    upstream = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TTN_API_KEY}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    fastify.log.error({ err }, 'Failed to reach TTN storage API');
    return { ok: false, status: 502, detail: 'Failed to reach TTN storage API' };
  }

  const text = await upstream.text();

  if (!upstream.ok) {
    fastify.log.error({ status: upstream.status, body: text }, 'TTN storage API error');
    return { ok: false, status: upstream.status, detail: text };
  }

  // TTN streams newline-delimited JSON objects, each shaped { result: <uplink> }.
  const uplinks = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed.result ?? parsed;
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return { ok: true, status: 200, uplinks };
}

// Attach a `decoded` CJ/T 188 reading to an uplink, decoded from its raw frm_payload.
// Falls back to decoded_payload.bytes, and records a decode error instead of throwing.
function withDecoded(uplink) {
  const msg = uplink.uplink_message ?? {};
  try {
    let decoded;
    if (msg.frm_payload) {
      decoded = decodeBase64(msg.frm_payload);
    } else if (Array.isArray(msg.decoded_payload?.bytes)) {
      decoded = decodeCjt188(msg.decoded_payload.bytes);
    } else {
      return { ...uplink, decoded: null, decode_error: 'No frm_payload to decode' };
    }
    return { ...uplink, decoded };
  } catch (err) {
    const detail = err instanceof CJT188Error ? err.message : 'Failed to decode payload';
    return { ...uplink, decoded: null, decode_error: detail };
  }
}

// GET /api/ttn/uplinks — proxy TTN Storage Integration uplink history.
// Query params:
//   last     — time window to fetch (e.g. 24h, 10m, 7d). Defaults to 24h.
//   deviceId — optional; only return uplinks from this device.
//   decode   — set to "false" to skip CJ/T 188 decoding. Defaults to decoding on.
fastify.get('/api/ttn/uplinks', async (request, reply) => {
  if (!TTN_API_KEY) {
    return reply.code(500).send({ error: 'TTN_API_KEY is not configured' });
  }

  const last = request.query.last ?? '24h';
  const deviceId = request.query.deviceId ?? null;
  const decode = request.query.decode !== 'false';

  const result = await fetchUplinks(last);
  if (!result.ok) {
    return reply.code(result.status).send({ error: 'TTN storage API error', detail: result.detail });
  }

  let uplinks = deviceId
    ? result.uplinks.filter((u) => u.end_device_ids?.device_id === deviceId)
    : result.uplinks;
  if (decode) uplinks = uplinks.map(withDecoded);

  return reply.send({ last, deviceId, count: uplinks.length, uplinks });
});

// GET /api/ttn/uplinks/:deviceId — uplink history for a single device.
// Query params:
//   last   — time window to fetch (e.g. 24h, 10m, 7d). Defaults to 24h.
//   decode — set to "false" to skip CJ/T 188 decoding. Defaults to decoding on.
fastify.get('/api/ttn/uplinks/:deviceId', async (request, reply) => {
  if (!TTN_API_KEY) {
    return reply.code(500).send({ error: 'TTN_API_KEY is not configured' });
  }

  const last = request.query.last ?? '24h';
  const decode = request.query.decode !== 'false';
  const { deviceId } = request.params;

  const result = await fetchUplinks(last);
  if (!result.ok) {
    return reply.code(result.status).send({ error: 'TTN storage API error', detail: result.detail });
  }

  let uplinks = result.uplinks.filter((u) => u.end_device_ids?.device_id === deviceId);
  if (decode) uplinks = uplinks.map(withDecoded);

  return reply.send({ last, deviceId, count: uplinks.length, uplinks });
});

// POST /api/ttn/decode — debug helper: decode a raw payload without hitting TTN.
// Body: { "frm_payload": "<base64>" } or { "hex": "FF 68 10 ..." } or { "bytes": [255,104,...] }
fastify.post('/api/ttn/decode', async (request, reply) => {
  const body = request.body ?? {};
  try {
    let decoded;
    if (body.frm_payload) {
      decoded = decodeBase64(body.frm_payload);
    } else if (typeof body.hex === 'string') {
      const bytes = body.hex.trim().split(/[\s,]+/).map((h) => parseInt(h, 16));
      decoded = decodeCjt188(bytes);
    } else if (Array.isArray(body.bytes)) {
      decoded = decodeCjt188(body.bytes);
    } else {
      return reply.code(400).send({ error: 'Provide one of: frm_payload, hex, bytes' });
    }
    return reply.send({ decoded });
  } catch (err) {
    const detail = err instanceof CJT188Error ? err.message : 'Failed to decode payload';
    return reply.code(400).send({ error: 'Decode failed', detail });
  }
});

// Vercel serverless: export a handler instead of binding to a port
export default async function handler(req, res) {
  await fastify.ready();
  fastify.server.emit('request', req, res);
}

// Local dev: start a real server
if (!process.env.VERCEL) {
  const port = process.env.PORT ?? 3012;
  fastify.listen({ port, host: '0.0.0.0' }, (err) => {
    if (err) {
      fastify.log.error(err);
      process.exit(1);
    }
  });
}
