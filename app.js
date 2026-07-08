import Fastify from 'fastify';

const fastify = Fastify({ logger: true });

const readings = [];

// TTN webhook — receives uplink data from The Things Network
fastify.post('/api/water-readings', async (request, reply) => {
  const { end_device_ids, received_at, uplink_message } = request.body;

  const reading = {
    deviceId: end_device_ids.device_id,
    devEui: end_device_ids.dev_eui,
    timestamp: received_at,
    ...uplink_message.decoded_payload,
  };

  readings.push(reading);
  fastify.log.info(reading, 'Water meter reading received');

  return reply.code(200).send({ status: 'ok' });
});

fastify.get('/api/water-readings', async (request, reply) => {
  return reply.send(readings);
});

fastify.listen({ port: 3011, host: '0.0.0.0' }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
});