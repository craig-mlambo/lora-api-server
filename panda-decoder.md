# Decoding Panda Ultrasonic DN15 Water Meters on The Things Network

A step-by-step record of how the Panda (CJ/T 188) LoRaWAN payloads were reverse-engineered,
decoded, and turned into a FastAPI ingestion service.

- **Devices:** Panda Ultrasonic DN15 water meters (e.g. `lye-yellow-device-5000240`)
- **Network server:** The Things Network — `eu1.cloud.thethings.network`
- **Application:** `lye-application-01`
- **Sample uplink:** FPort 10, `frm_payload` (base64):
  `/2gQQAIAUDEDJYEkkBLXKwAAAAArAAAAACwAAAAANQAAAAB2GABBEAkUByYgAAIAgxY=`

---

## Step 1 — Get the raw bytes

TTN delivers the LoRaWAN application payload as base64 in `uplink_message.frm_payload`.
Base64-decoding it yields 50 bytes (TTN's default "bytes" formatter shows the same
array in `decoded_payload.bytes`):

```
FF 68 10 40 02 00 50 31 03 25 81 24 90 12 D7 2B 00 00 00 00
2B 00 00 00 00 2C 00 00 00 00 35 00 00 00 00 76 18 00 41 10
09 14 07 26 20 00 02 00 83 16
```

## Step 2 — Identify the protocol

The byte pattern `... 68 <type> <7-byte address> <control> <length> ... <checksum> 16`
is the signature of **CJ/T 188-2004**, the Chinese utility-meter protocol that Panda
meters speak internally (over M-Bus/RS485) and simply tunnel through LoRaWAN.

Clues that confirmed it:

1. `0x68` start byte and `0x16` end byte (classic CJ/T 188 / M-Bus framing).
2. `0x10` after the start byte = **cold water meter** type code.
3. The 7-byte address `40 02 00 50 31 03 25`, read **little-endian BCD**, is
   `25033150000240` — the device ID ends in **5000240**. Match.
4. The checksum byte `0x83` equals the sum of all bytes from `0x68` up to the last
   data byte, modulo 256. Verified arithmetically. Match.
5. A 7-byte BCD timestamp near the end decodes to `2026-07-14 09:10:41`, which is
   the uplink's arrival time in local time (UTC+2), ~2 minutes of clock drift. Match.

## Step 3 — Map the frame field by field

```
FF                       Wake-up / preamble byte
68                       Frame start
10                       Meter type (0x10 = cold water)
40 02 00 50 31 03 25     Address, little-endian BCD -> serial 25033150000240
81                       Control code (meter response to a read command)
24                       Data length = 0x24 = 36 bytes
  90 12                  Data Identifier (DI = 0x1290, vendor "read meter data")
  D7                     Sequence number
  2B 00 00 00 00         Register 1: cumulative flow      (unit 0x2B, value 0)
  2B 00 00 00 00         Register 2: settlement cumulative (unit 0x2B, value 0)
  2C 00 00 00 00         Register 3: reverse flow          (unit 0x2C, value 0)
  35 00 00 00 00         Register 4: instantaneous flow    (unit 0x35, value 0)
  76 18 00               Vendor extras (likely battery %, signal/alarm)
  41 10 09 14 07 26 20   Meter RTC, BCD little-endian: ss mm hh DD MM YY YY
                         -> 2026-07-14 09:10:41
  00 02 00               Status / valve flags
83                       Checksum = sum(0x68 .. last data byte) mod 256
16                       Frame end
```

Notes:

- All register values are **BCD** (binary-coded decimal), little-endian, 4 bytes.
- Every reading is `0` because the meters were newly installed (f_cnt = 6) with no
  water metered yet.
- Open items to confirm against the official Panda protocol document
  (*PANDA PWM-S Residential Ultrasonic Water Meter Manual — LoRaWAN*):
  - Exact unit/scaling of each register (liters vs 0.001 m³, implied decimals).
  - Meaning of the `76 18 00` extra bytes (probable battery % + signal/alarm).
  - Easiest verification: capture an uplink after some consumption and compare
    `cumulative_flow` with the meter's LCD reading.

## Step 4 — TTN uplink payload formatter (JavaScript)

A custom JavaScript `decodeUplink()` was written and added under
**Application → Payload formatters → Uplink → Custom JavaScript**. It:

1. Skips `0xFF` preamble bytes and validates the `0x68` start byte.
2. Reverses the 7-byte BCD address into a readable serial.
3. Parses DI, sequence, the four `[unit][4-byte BCD]` registers, the extras,
   the 7-byte BCD timestamp, and the status word.
4. Recomputes and verifies the checksum (`checksum_ok`).

**Important TTN behaviours discovered along the way:**

- TTN decodes an uplink **once, on arrival**. Changing the formatter does **not**
  retroactively re-decode messages already in storage — only new uplinks get the
  new `decoded_payload`.
- A **device-level** formatter overrides the **application-level** one. Set devices
  to "Use application payload formatter" to avoid surprises.
- You can test instantly without waiting for a transmission:
  - The test box under *Payload formatters → Uplink*, or
  - *Messaging → Simulate uplink* (base64 payload, FPort 10), which pushes a fully
    decoded message through to all integrations.

## Step 5 — Parallel decoding script against the Storage API

Because the Storage Integration always retains the **raw** `frm_payload`, historical
messages can be decoded outside TTN regardless of what formatter was active when
they arrived. A standalone Python script (`ttn_panda_decoder.py`) was built that:

1. Calls the Storage endpoint:
   `GET https://eu1.cloud.thethings.network/api/v3/as/applications/{app_id}/packages/storage/uplink_message`
   (insert `/devices/{device_id}` before `/packages` for a single meter), with
   `Authorization: Bearer <API key>` (key needs *Read application traffic* rights).
2. Parses the response as **newline-delimited JSON** — one `{"result": {...}}`
   object per line.
3. Base64-decodes each `frm_payload` and runs the same CJ/T 188 decoder in Python.

Usage:

```bash
export TTN_API_KEY="NNSXS...."
python3 ttn_panda_decoder.py --app lye-application-01 --last 15d
python3 ttn_panda_decoder.py --app lye-application-01 --device lye-yellow-device-5000240
```

Query parameters: `last` (e.g. `24h`, `15d` — retention is limited, hence the
"last 15 days" on the dashboard) or `after=<RFC3339>` for incremental pulls.

## Step 6 — FastAPI ingestion service

The decoder was refactored into a small FastAPI project so the same logic serves
live webhooks, on-demand history pulls, and debugging:

```
panda_api/
├── requirements.txt        # fastapi, uvicorn, httpx
└── app/
    ├── decoder.py          # decode_cjt188() / decode_b64() — pure Python, no deps
    ├── ttn_client.py       # async httpx client streaming the Storage API NDJSON
    ├── settings.py         # env config: TTN_APP_ID, TTN_API_KEY, WEBHOOK_TOKEN
    └── main.py             # FastAPI routes
```

Endpoints:

| Route | Purpose |
|---|---|
| `POST /ttn/webhook` | Live ingestion. TTN Webhooks integration pushes each uplink; the handler validates an optional `X-Webhook-Token` header, decodes, and returns a flat reading (with a `TODO` hook for persisting to a database). |
| `GET /readings` | Backfill/pull. Streams from the Storage API and decodes on the fly. Supports `device_id`, `last`, `after`, `limit`. |
| `POST /decode` | Debug. Accepts `{"frm_payload": "<base64>"}` or `{"hex": "..."}`. |
| `GET /health` | Liveness check. |

TTN webhook setup: **Integrations → Webhooks → Add webhook → Custom**, base URL
`https://your-server/ttn/webhook`, enable only the *Uplink message* event, and add
an additional header `X-Webhook-Token: <secret>` matching the `WEBHOOK_TOKEN`
environment variable.

Run:

```bash
pip install -r requirements.txt
export TTN_APP_ID="lye-application-01"
export TTN_API_KEY="NNSXS...."
export WEBHOOK_TOKEN="some-secret"
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Design decisions:

- The decoder is a **dependency-free module**, importable from FastAPI, MQTT
  consumers, batch scripts, or unit tests alike.
- Malformed frames raise `CJT188Error`, which the handlers catch and record as
  `{"error": ..., "frm_payload": ...}` — no uplink is silently lost.
- Events without `frm_payload` (e.g. join-accepts) are skipped gracefully.

## Step 7 — Verification

The whole chain was tested against the real captured payload:

```json
{
  "meter_type": "cold_water",
  "serial": "25033150000240",
  "control": "0x81",
  "di": "1290",
  "seq": 215,
  "cumulative_flow":  { "value": 0, "unit": "m3" },
  "settlement_flow":  { "value": 0, "unit": "m3" },
  "reverse_flow":     { "value": 0, "unit": "L" },
  "instant_flow":     { "value": 0, "unit": "flow_rate" },
  "extra_bytes": [118, 24, 0],
  "meter_time": "2026-07-14T09:10:41",
  "status": 512,
  "checksum_ok": true
}
```

Serial matches the device ID, the meter clock matches the uplink time, and the
checksum validates — confirming the frame mapping is correct.

## Next steps

1. Let a meter register real consumption, then compare `cumulative_flow` against
   the LCD to pin down decimal scaling; adjust `decoder.py` if needed.
2. Get the register map for DI `0x1290` and the `76 18 00` extras from Panda
   support to finalise field names and units.
3. Add persistence (PostgreSQL/Timescale/InfluxDB) at the `TODO` in the webhook
   handler, plus the downlink path if valve control is required later.