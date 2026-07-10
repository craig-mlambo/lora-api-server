import Fastify from 'fastify';

const fastify = Fastify({ logger: true });

// In-memory store: Map<deviceId, reading[]>
const readingsByDevice = new Map();

function getBestSignal(rxMetadata = []) {
  if (!rxMetadata.length) return {};
  // Pick the gateway with the highest RSSI
  const best = rxMetadata.reduce((a, b) =>
    (a.rssi ?? -Infinity) >= (b.rssi ?? -Infinity) ? a : b
  );
  return {
    rssi: best.rssi ?? null,
    snr: best.snr ?? null,
    gatewayId: best.gateway_ids?.gateway_id ?? null,
  };
}

// POST /api/water-readings — TTN uplink webhook
fastify.post('/api/water-readings', async (request, reply) => {
  const body = request.body;

  if (!body?.end_device_ids || !body?.uplink_message) {
    return reply.code(400).send({ error: 'Invalid TTN uplink payload' });
  }

  const { end_device_ids, received_at, uplink_message } = body;
  const { decoded_payload, rx_metadata, f_port, f_cnt, settings } = uplink_message;

  if (!decoded_payload) {
    fastify.log.warn({ deviceId: end_device_ids.device_id }, 'Uplink received with no decoded_payload — check TTN payload formatter');
  }

  const signal = getBestSignal(rx_metadata);

  const reading = {
    deviceId: end_device_ids.device_id,
    devEui: end_device_ids.dev_eui,
    appId: end_device_ids.application_ids?.application_id ?? null,
    timestamp: received_at,
    // LoRaWAN frame info
    fPort: f_port ?? null,
    fCount: f_cnt ?? null,
    dataRate: settings?.data_rate_index ?? null,
    frequency: settings?.frequency ?? null,
    // Signal quality
    ...signal,
    // Decoded sensor payload (null if formatter not configured)
    payload: decoded_payload ?? null,
  };

  const deviceId = reading.deviceId;
  if (!readingsByDevice.has(deviceId)) {
    readingsByDevice.set(deviceId, []);
  }
  readingsByDevice.get(deviceId).push(reading);

  fastify.log.info({ reading }, 'Water meter reading received');

  return reply.code(200).send({ status: 'ok' });
});

// GET /api/water-readings — all readings, newest first
fastify.get('/api/water-readings', async (request, reply) => {
  const all = [];
  for (const readings of readingsByDevice.values()) {
    all.push(...readings);
  }
  all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return reply.send(all);
});

// GET /api/water-readings/devices — list known device IDs
fastify.get('/api/water-readings/devices', async (request, reply) => {
  return reply.send([...readingsByDevice.keys()]);
});

// GET /api/water-readings/:deviceId — readings for one device, newest first
fastify.get('/api/water-readings/:deviceId', async (request, reply) => {
  const { deviceId } = request.params;
  const readings = readingsByDevice.get(deviceId);
  if (!readings) {
    return reply.code(404).send({ error: `No readings found for device '${deviceId}'` });
  }
  return reply.send([...readings].reverse());
});

fastify.listen({ port: 3012, host: '0.0.0.0' }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
});
