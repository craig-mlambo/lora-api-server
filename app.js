import Fastify from 'fastify';

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

// GET /api/ttn/uplinks — proxy TTN Storage Integration uplink history.
// Query params:
//   last     — time window to fetch (e.g. 24h, 10m, 7d). Defaults to 24h.
//   deviceId — optional; only return uplinks from this device.
fastify.get('/api/ttn/uplinks', async (request, reply) => {
  if (!TTN_API_KEY) {
    return reply.code(500).send({ error: 'TTN_API_KEY is not configured' });
  }

  const last = request.query.last ?? '24h';
  const deviceId = request.query.deviceId ?? null;

  const result = await fetchUplinks(last);
  if (!result.ok) {
    return reply.code(result.status).send({ error: 'TTN storage API error', detail: result.detail });
  }

  const uplinks = deviceId
    ? result.uplinks.filter((u) => u.end_device_ids?.device_id === deviceId)
    : result.uplinks;

  return reply.send({ last, deviceId, count: uplinks.length, uplinks });
});

// GET /api/ttn/uplinks/:deviceId — uplink history for a single device.
// Query params:
//   last — time window to fetch (e.g. 24h, 10m, 7d). Defaults to 24h.
fastify.get('/api/ttn/uplinks/:deviceId', async (request, reply) => {
  if (!TTN_API_KEY) {
    return reply.code(500).send({ error: 'TTN_API_KEY is not configured' });
  }

  const last = request.query.last ?? '24h';
  const { deviceId } = request.params;

  const result = await fetchUplinks(last);
  if (!result.ok) {
    return reply.code(result.status).send({ error: 'TTN storage API error', detail: result.detail });
  }

  const uplinks = result.uplinks.filter((u) => u.end_device_ids?.device_id === deviceId);

  return reply.send({ last, deviceId, count: uplinks.length, uplinks });
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
