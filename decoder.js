// Dependency-free decoder for Panda Ultrasonic DN15 water meters.
//
// Panda meters speak CJ/T 188-2004 (Chinese utility-meter protocol) internally and
// tunnel the frame through LoRaWAN. TTN delivers the frame as base64 in
// uplink_message.frm_payload. See panda-decoder.md for the full reverse-engineering
// write-up. This mirrors that decoder in plain JavaScript.

export class CJT188Error extends Error {}

const METER_TYPES = {
  0x10: 'cold_water',
  0x11: 'hot_water',
};

// Register roles in DI 0x1290, in frame order.
const REGISTERS = ['cumulative_flow', 'settlement_flow', 'reverse_flow', 'instant_flow'];

// Unit byte -> human label (from the panda-decoder.md verification sample).
const UNITS = {
  0x2b: 'm3',
  0x2c: 'L',
  0x35: 'flow_rate',
};

// Two BCD digits of a byte as a string, e.g. 0x26 -> "26".
function bcdDigits(byte) {
  return ((byte >> 4) & 0x0f).toString() + (byte & 0x0f).toString();
}

// Single byte BCD as a number, e.g. 0x41 -> 41.
function bcdByte(byte) {
  return ((byte >> 4) & 0x0f) * 10 + (byte & 0x0f);
}

// Little-endian BCD integer from a byte slice (reverse byte order, concat digits).
function bcdValueLE(slice) {
  let digits = '';
  for (let i = slice.length - 1; i >= 0; i--) digits += bcdDigits(slice[i]);
  return parseInt(digits, 10);
}

// Decode a base64 LoRaWAN payload string into a Uint8Array.
export function base64ToBytes(b64) {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

// Decode a raw CJ/T 188 byte array (Uint8Array or number[]) into a reading object.
export function decodeCjt188(input) {
  const b = Array.from(input);

  // 1. Skip any 0xFF wake-up/preamble bytes, require the 0x68 start byte.
  let i = 0;
  while (i < b.length && b[i] === 0xff) i++;
  if (b[i] !== 0x68) throw new CJT188Error('Missing 0x68 CJ/T 188 start byte');

  const start = i;
  const meterTypeByte = b[start + 1];
  const addrBytes = b.slice(start + 2, start + 9); // 7-byte address
  const control = b[start + 9];
  const dataLen = b[start + 10];
  const dataStart = start + 11;
  const data = b.slice(dataStart, dataStart + dataLen);
  const checksumIndex = dataStart + dataLen;
  const checksum = b[checksumIndex];
  const endByte = b[checksumIndex + 1];

  if (data.length < dataLen) throw new CJT188Error('Frame truncated: data shorter than declared length');
  if (endByte !== 0x16) throw new CJT188Error('Missing 0x16 CJ/T 188 end byte');

  // 2. Serial = 7-byte address, little-endian BCD (reverse + concat digits).
  let serial = '';
  for (let j = addrBytes.length - 1; j >= 0; j--) serial += bcdDigits(addrBytes[j]);

  // 3. Data block: DI (LE), sequence, four [unit][4-byte BCD] registers, extras, RTC, status.
  const di = data[0] | (data[1] << 8);
  const seq = data[2];

  const registers = {};
  let off = 3;
  for (const name of REGISTERS) {
    const unitByte = data[off];
    const value = bcdValueLE(data.slice(off + 1, off + 5));
    registers[name] = {
      value,
      unit: UNITS[unitByte] ?? `0x${unitByte.toString(16).padStart(2, '0')}`,
      unit_byte: unitByte,
    };
    off += 5;
  }

  const extraBytes = data.slice(off, off + 3); // e.g. 76 18 00 — battery/signal (unconfirmed)
  off += 3;

  // 4. Meter RTC: 7 BCD bytes, ss mm hh DD MM YY(low) YY(high).
  const rtc = data.slice(off, off + 7);
  off += 7;
  const ss = bcdByte(rtc[0]);
  const mm = bcdByte(rtc[1]);
  const hh = bcdByte(rtc[2]);
  const DD = bcdByte(rtc[3]);
  const MM = bcdByte(rtc[4]);
  const year = parseInt(bcdDigits(rtc[6]) + bcdDigits(rtc[5]), 10);
  const pad = (n) => String(n).padStart(2, '0');
  const meterTime = `${year}-${pad(MM)}-${pad(DD)}T${pad(hh)}:${pad(mm)}:${pad(ss)}`;

  // 5. Status / valve flags: 3 bytes, little-endian integer.
  const statusBytes = data.slice(off, off + 3);
  const status = statusBytes[0] | (statusBytes[1] << 8) | (statusBytes[2] << 16);

  // 6. Checksum = sum(0x68 .. last data byte) mod 256.
  let sum = 0;
  for (let j = start; j < checksumIndex; j++) sum = (sum + b[j]) & 0xff;
  const checksumOk = sum === checksum;

  return {
    meter_type: METER_TYPES[meterTypeByte] ?? `0x${meterTypeByte.toString(16).padStart(2, '0')}`,
    serial,
    control: `0x${control.toString(16).padStart(2, '0')}`,
    di: di.toString(16).padStart(4, '0'),
    seq,
    ...registers,
    extra_bytes: extraBytes,
    meter_time: meterTime,
    status,
    checksum_ok: checksumOk,
  };
}

// Convenience: decode straight from a base64 frm_payload string.
export function decodeBase64(b64) {
  return decodeCjt188(base64ToBytes(b64));
}
