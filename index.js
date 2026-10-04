// ============================================
// KANCIL VPN BLITZ TUNNEL v1.1
// VLESS + VMess + Trojan via WebSocket + Cloudflare Tunnel
// Tunnel bypass proxy PaaS yg bermasalah handle WebSocket langsung
// cloudflared di-download dari OFFICIAL GitHub release
// ============================================

const http = require('http');
const https = require('https');
const { WebSocketServer, WebSocket } = require('ws');
const net = require('net');
const dgram = require('dgram');
const url = require('url');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const SYSTEM_UUID = process.env.SYSTEM_UUID || "c48619fe-8f02-49e0-b9e9-edf763e17e21";
const DOH_ENDPOINT = process.env.DOH_ENDPOINT || "https://1.1.1.1/dns-query";
const VMESS_MAGIC = "c48619fe-8f02-49e0-b9e9-edf763e17e21";
const TUNNEL_TOKEN = process.env.TUNNEL_TOKEN || ''; // opsional: token tunnel fix dari Cloudflare

// ================= CLOUDFLARE TUNNEL =================
const TUNNEL_BIN = path.join(os.tmpdir(), 'cloudflared'); // /tmp selalu writable di PaaS
let tunnelUrl = '';
let tunnelStatus = 'starting';

function downloadFile(fileUrl, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) => {
      https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { get(res.headers.location); return; }
        if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', reject);
    };
    get(fileUrl);
  });
}

async function ensureCloudflared() {
  if (fs.existsSync(TUNNEL_BIN)) return;
  const arch = os.arch();
  const bin = arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';
  const dlUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/' + bin;
  console.log('[tunnel] download cloudflared (' + arch + ') dari official...');
  await downloadFile(dlUrl, TUNNEL_BIN);
  fs.chmodSync(TUNNEL_BIN, 0o755);
  console.log('[tunnel] cloudflared siap');
}

function startTunnel(port) {
  return new Promise((resolve) => {
    let args;
    if (TUNNEL_TOKEN) {
      args = ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run', '--token', TUNNEL_TOKEN];
    } else {
      args = ['tunnel', '--url', 'http://localhost:' + port, '--no-autoupdate', '--protocol', 'http2'];
    }
    console.log('[tunnel] menjalankan: cloudflared ' + args.join(' ').replace(TUNNEL_TOKEN, '***'));
    const p = spawn(TUNNEL_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      if (!tunnelUrl) {
        const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) {
          tunnelUrl = m[0];
          tunnelStatus = 'active';
          console.log('[tunnel] URL: ' + tunnelUrl);
          resolve(tunnelUrl);
        }
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => { tunnelStatus = 'error: ' + e.message; console.log('[tunnel] ' + tunnelStatus); resolve(''); });
    p.on('exit', (c) => { if (!tunnelUrl) { tunnelStatus = 'exit:' + c; resolve(''); } });
    setTimeout(() => resolve(tunnelUrl), 45000);
    if (TUNNEL_TOKEN) { tunnelStatus = 'active (fixed token)'; setTimeout(() => resolve('token'), 8000); }
  });
}

// Mapping Custom Path ke IP Target
const PROXY_MAP = {
  "id-akamai": "172.232.249.224:2053",
  "id-deneva": "202.155.95.132:443",
  "sg-ovh": "51.79.177.53:443",
  "sg-oracle": "138.2.64.229:443"
};

const horse = Buffer.from("dHJvamFu", 'base64').toString(); // trojan
const flash = Buffer.from("dm1lc3M=", 'base64').toString(); // vmess

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Max-Age": "86400",
};

// ================= CRYPTO HELPERS (VMess AEAD) =================
function parseUuid(uuid) {
  const hex = String(uuid).replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error("Format UUID tidak valid");
  return Buffer.from(hex, "hex");
}

// KDF resmi VMess AEAD (nested HMAC-SHA256, spt v2ray-core proxy/vmess/aead/kdf.go)
function vmessKDF(key, ...paths) {
  const BLOCK = 64;
  const padKey = (k) => {
    let kb = Buffer.isBuffer(k) ? k : Buffer.from(String(k), "utf-8");
    if (kb.length > BLOCK) kb = crypto.createHash("sha256").update(kb).digest();
    const out = Buffer.alloc(BLOCK);
    kb.copy(out);
    return out;
  };
  const hmacNested = (keyBytes, innerDigest, data) => {
    const kb = padKey(keyBytes);
    const ik = Buffer.alloc(BLOCK), ok = Buffer.alloc(BLOCK);
    for (let i = 0; i < BLOCK; i++) { ik[i] = kb[i] ^ 0x36; ok[i] = kb[i] ^ 0x5c; }
    const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return innerDigest(Buffer.concat([ok, innerDigest(Buffer.concat([ik, d]))]));
  };
  const sha256d = (d) => crypto.createHash("sha256").update(d).digest();
  let digest = (data) => hmacNested("VMess AEAD KDF", sha256d, data);
  for (const p of paths) {
    const prev = digest;
    digest = (data) => hmacNested(p, prev, data);
  }
  return digest(key);
}
const vmessKDF16 = (key, ...paths) => vmessKDF(key, ...paths).slice(0, 16);

function gcmDecrypt(key, iv12, cipherWithTag, aad) {
  const tag = cipherWithTag.slice(-16);
  const ct = cipherWithTag.slice(0, -16);
  const d = crypto.createDecipheriv("aes-128-gcm", key, iv12);
  if (aad && aad.length) d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
function gcmEncrypt(key, iv12, plaintext, aad) {
  const e = crypto.createCipheriv("aes-128-gcm", key, iv12);
  if (aad && aad.length) e.setAAD(aad);
  const ct = Buffer.concat([e.update(plaintext), e.final()]);
  return Buffer.concat([ct, e.getAuthTag()]);
}

// ================= VMESS BODY AEAD (chunk stream, sesuai Xray-core) =================
// Spec: proxy/vmess/encoding/server.go + common/crypto/auth.go + chunk.go (XTLS/Xray-core)
// - Request body key  = reqKey  (16B dari header), IV = reqIv (16B dari header)
// - Response body key = SHA256(reqKey)[0:16], IV = SHA256(reqIv)[0:16]
// - Tiap chunk: size(2B, di-mask SHAKE-128 bila opt 0x04) + AES-128-GCM(payload) + padding acak
// - Nonce chunk ke-n: BE16(n) + IV[2:12]  (counter di 2 byte PERTAMA)
const VMESS_OPT_MASKING = 0x04;   // RequestOptionChunkMasking
const VMESS_OPT_PADDING = 0x08;   // RequestOptionGlobalPadding
const VMESS_OPT_AUTHLEN = 0x10;   // RequestOptionAuthenticatedLength
const VMESS_SEC_AES128_GCM = 3;
const VMESS_SEC_CHACHA20_POLY1305 = 4;

// SHAKE-128 satu arah: Node hanya support one-shot XOF, jadi squeeze 1MB di muka.
// 1MB = 524288x draw @2B; cukup untuk ~4GB per arah pada chunk 8KB.
function makeShake128(seed16) {
  const OUT = 1 << 20;
  const h = crypto.createHash("shake128", { outputLength: OUT });
  h.update(seed16);
  const buf = h.digest();
  let pos = 0;
  return {
    nextU16() {
      if (pos + 2 > buf.length) throw new Error("SHAKE-128 habis (koneksi terlalu panjang)");
      const v = buf.readUInt16BE(pos); pos += 2; return v;
    }
  };
}

// GenerateChunkNonce ala Xray: counter BE16 di 2 byte pertama IV (16B -> pakai 12B pertama)
function makeChunkNonce(iv16) {
  const c = Buffer.from(iv16);
  let count = 0;
  return () => {
    const n = Buffer.alloc(12);
    c.copy(n, 0, 0, 12);
    n.writeUInt16BE(count & 0xffff, 0);
    count++;
    return n;
  };
}

function vmessBodyCipher(security, key16) {
  if (security === VMESS_SEC_AES128_GCM) return { algo: "aes-128-gcm", key: Buffer.from(key16) };
  if (security === VMESS_SEC_CHACHA20_POLY1305) {
    // GenerateChacha20Poly1305Key: MD5(k) || MD5(MD5(k))
    const t1 = crypto.createHash("md5").update(key16).digest();
    const t2 = crypto.createHash("md5").update(t1).digest();
    return { algo: "chacha20-poly1305", key: Buffer.concat([t1, t2]) };
  }
  throw new Error("Security VMess tidak didukung: " + security);
}

function vmessAeadSeal(cipher, key, nonce12, plain) {
  const e = crypto.createCipheriv(cipher.algo, key, nonce12);
  const ct = Buffer.concat([e.update(plain), e.final()]);
  return Buffer.concat([ct, e.getAuthTag()]);
}
function vmessAeadOpen(cipher, key, nonce12, sealed) {
  if (sealed.length < 16) throw new Error("Ciphertext terlalu pendek");
  const tag = sealed.slice(-16), ct = sealed.slice(0, -16);
  const d = crypto.createDecipheriv(cipher.algo, key, nonce12);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

// Decoder chunk stream VMess (client -> server / server -> client)
class VmessChunkDecoder {
  constructor(key16, iv16, opt, security) {
    this.cipher = vmessBodyCipher(security, key16);
    this.key = this.cipher.key;
    this.nonceGen = makeChunkNonce(iv16);
    this.opt = opt;
    this.authLen = (opt & VMESS_OPT_AUTHLEN) !== 0;
    this.masking = (opt & VMESS_OPT_MASKING) !== 0;
    this.padding = (opt & VMESS_OPT_PADDING) !== 0;
    if (this.authLen && this.padding) throw new Error("Opsi VMess invalid (authLen+padding)");
    if (this.authLen) {
      this.lenKey = vmessKDF16(key16, "auth_len");
      this.lenNonceGen = makeChunkNonce(iv16);
    }
    this.shake = (this.masking || this.padding) ? makeShake128(iv16) : null;
    this.buf = Buffer.alloc(0);
    this.done = false;
    this.pendingChunk = null; // { sizeLen, padLen, size } bila header chunk sudah dibaca tapi bodi belum lengkap
  }
  // Masukkan bytes mentah; kembalikan { plains: Buffer[], done: bool }
  push(data) {
    if (data && data.length) this.buf = Buffer.concat([this.buf, data]);
    const plains = [];
    if (this.done) return { plains, done: true };
    for (;;) {
      const sizeLen = this.authLen ? 18 : 2;
      if (this.buf.length < sizeLen) break;
      // Undian SHAKE tepat sekali per chunk: simpan bila bodi belum lengkap.
      if (this.pendingChunk === null) {
        const sizeBytes = this.buf.slice(0, sizeLen);
        let padLen = 0, size;
        try {
          if (this.padding) padLen = this.shake.nextU16() % 64;
          if (this.authLen) {
            const raw = vmessAeadOpen(this.cipher, this.lenKey, this.lenNonceGen(), sizeBytes);
            size = raw.readUInt16BE(0) + 16;
          } else if (this.masking) {
            size = (this.shake.nextU16() ^ sizeBytes.readUInt16BE(0)) & 0xffff;
          } else {
            size = sizeBytes.readUInt16BE(0);
          }
        } catch (e) { throw new Error("Decode ukuran chunk VMess gagal: " + e.message); }
        this.pendingChunk = { sizeLen, padLen, size };
      }
      const { sizeLen: sl, padLen, size } = this.pendingChunk;
      if (size === 16 + padLen) { this.done = true; this.buf = this.buf.slice(sl); this.pendingChunk = null; break; } // sinyal terminasi
      if (size < 16 + padLen) throw new Error("Ukuran chunk VMess invalid: " + size);
      if (this.buf.length < sl + size) break; // tunggu bytes lengkap
      this.pendingChunk = null;
      const sealed = this.buf.slice(sl, sl + size - padLen);
      this.buf = this.buf.slice(sl + size);
      let plain;
      try { plain = vmessAeadOpen(this.cipher, this.key, this.nonceGen(), sealed); }
      catch (e) { throw new Error("Dekripsi body VMess gagal: " + e.message); }
      if (plain.length) plains.push(plain);
    }
    return { plains, done: this.done };
  }
}

// Encoder chunk stream VMess
class VmessChunkEncoder {
  constructor(key16, iv16, opt, security) {
    this.cipher = vmessBodyCipher(security, key16);
    this.key = this.cipher.key;
    this.nonceGen = makeChunkNonce(iv16);
    this.opt = opt;
    this.authLen = (opt & VMESS_OPT_AUTHLEN) !== 0;
    this.masking = (opt & VMESS_OPT_MASKING) !== 0;
    this.padding = (opt & VMESS_OPT_PADDING) !== 0;
    if (this.authLen) {
      this.lenKey = vmessKDF16(key16, "auth_len");
      this.lenNonceGen = makeChunkNonce(iv16);
    }
    this.shake = (this.masking || this.padding) ? makeShake128(iv16) : null;
  }
  _seal(plain) {
    const encSize = plain.length + 16;
    let padLen = 0;
    if (this.padding) padLen = this.shake.nextU16() % 64;
    const total = encSize + padLen;
    let sizeBytes;
    if (this.authLen) {
      const lb = Buffer.alloc(2); lb.writeUInt16BE(plain.length + padLen, 0);
      sizeBytes = vmessAeadSeal(this.cipher, this.lenKey, this.lenNonceGen(), lb);
    } else if (this.masking) {
      sizeBytes = Buffer.alloc(2);
      sizeBytes.writeUInt16BE((this.shake.nextU16() ^ total) & 0xffff, 0);
    } else {
      sizeBytes = Buffer.alloc(2); sizeBytes.writeUInt16BE(total, 0);
    }
    const sealed = vmessAeadSeal(this.cipher, this.key, this.nonceGen(), plain);
    const pad = padLen ? crypto.randomBytes(padLen) : Buffer.alloc(0);
    return Buffer.concat([sizeBytes, sealed, pad]);
  }
  sealPacket(plain) { return this._seal(plain); }            // UDP: 1 datagram = 1 chunk
  sealStream(plain) {                                        // TCP: pecah max 8000B/chunk
    const out = [];
    for (let i = 0; i < plain.length; i += 8000) out.push(this._seal(plain.slice(i, i + 8000)));
    return Buffer.concat(out);
  }
  sealEmpty() { return this._seal(Buffer.alloc(0)); }        // sinyal terminasi TCP
}

function parseVmessAddr(buf) {
  const atyp = buf[0];
  if (atyp === 1) return { host: Array.from(buf.slice(1, 5)).join("."), len: 5 };
  if (atyp === 2) { const l = buf[1]; return { host: buf.slice(2, 2 + l).toString("utf-8"), len: 2 + l }; }
  if (atyp === 3) {
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(buf.readUInt16BE(1 + i * 2).toString(16));
    return { host: parts.join(":"), len: 17 };
  }
  throw new Error("Atyp VMess tidak dikenal: " + atyp);
}

// Ekstrak header VMess AEAD (trial-decrypt dgn UUID server).
// Wire: authID(16) + encLen(18) + nonce(8) + encCmd(dataLen+16) + payload
function vmessExtract(buf, uuid) {
  if (buf.length < 42) throw new Error("Buffer VMess terlalu pendek");
  const uuidBytes = parseUuid(uuid);
  const basis = crypto.createHash("md5")
    .update(Buffer.concat([uuidBytes, Buffer.from(VMESS_MAGIC, "utf-8")])).digest(); // cmdKey

  const auth = buf.slice(0, 16);
  const lenEnc = buf.slice(16, 34);
  const nonce = buf.slice(34, 42);

  const lenKey = vmessKDF16(basis, "VMess Header AEAD Key_Length", auth, nonce);
  const lenIv = vmessKDF(basis, "VMess Header AEAD Nonce_Length", auth, nonce).slice(0, 12);
  const rawLen = gcmDecrypt(lenKey, lenIv, lenEnc, auth);
  const dataLen = (rawLen[0] << 8) | rawLen[1];
  if (dataLen < 42 || buf.length < 42 + dataLen + 16) throw new Error("Panjang header VMess tidak valid");

  const cmdEnc = buf.slice(42, 42 + dataLen + 16);
  const payKey = vmessKDF16(basis, "VMess Header AEAD Key", auth, nonce);
  const payIv = vmessKDF(basis, "VMess Header AEAD Nonce", auth, nonce).slice(0, 12);
  const cmd = gcmDecrypt(payKey, payIv, cmdEnc, auth);

  // Layout command: [0]=ver [1..17)=reqIV [17..33)=reqKey [33]=respV [34]=opt
  // [35]=P/sec [36]=reserved [37]=cmd(1=TCP/2=UDP) [38..40)=port [40]=atyp...
  if (cmd[0] !== 1) throw new Error("Versi VMess tidak didukung");
  const reqIv = cmd.slice(1, 17), reqKey = cmd.slice(17, 33);
  const respV = cmd[33], opt = cmd[34], security = cmd[35] & 0x0f, command = cmd[37];
  if (command !== 1 && command !== 2) throw new Error("Command VMess invalid");
  const isUdp = command === 2;
  const port = (cmd[38] << 8) | cmd[39];
  const { host } = parseVmessAddr(cmd.slice(40));
  const payload = buf.slice(42 + dataLen + 16);

  // Response header AEAD (respKey=SHA256(reqKey)[0:16], respIv=SHA256(reqIV)[0:16])
  const respKey = crypto.createHash("sha256").update(reqKey).digest().slice(0, 16);
  const respIv = crypto.createHash("sha256").update(reqIv).digest().slice(0, 16);
  const h1 = gcmEncrypt(vmessKDF16(respKey, "AEAD Resp Header Len Key"),
    vmessKDF(respIv, "AEAD Resp Header Len IV").slice(0, 12), Buffer.from([0, 4]), null);
  const h2 = gcmEncrypt(vmessKDF16(respKey, "AEAD Resp Header Key"),
    vmessKDF(respIv, "AEAD Resp Header IV").slice(0, 12), Buffer.from([respV, 0, 0, 0]), null);
  // Kunci body response (Xray server.go): SHA256(reqKey)[0:16], SHA256(reqIv)[0:16]
  const respBodyKey = crypto.createHash("sha256").update(reqKey).digest().slice(0, 16);
  const respBodyIV = crypto.createHash("sha256").update(reqIv).digest().slice(0, 16);
  return { hasError: false, addressRemote: host, portRemote: port, isUdp,
           rawClientData: payload, replyHead: Buffer.concat([h1, h2]),
           vmessOpt: opt, vmessSec: security, reqKey, reqIv, respBodyKey, respBodyIV };
}

// Parser VLESS: ver(1) uuid(16) optLen(1) opt(?) cmd(1) port(2) atyp(1) addr payload
function readVlessHeader(buf) {
  if (buf.length < 24 || buf[0] !== 0x00) return { hasError: true, message: "Bukan VLESS" };
  const ver = buf[0];
  const optLen = buf[17];
  if (buf.length < 18 + optLen + 4) return { hasError: true, message: "VLESS truncated" };
  const cmd = buf[18 + optLen];
  const isUdp = cmd === 2;
  if (cmd !== 1 && cmd !== 2) return { hasError: true, message: "VLESS Cmd Invalid" };
  const port = buf.readUInt16BE(18 + optLen + 1);
  let ai = 18 + optLen + 3;
  const at = buf[ai];
  let alen;
  if (at === 1) alen = 5;
  else if (at === 2) alen = 2 + buf[ai + 1];
  else if (at === 3) alen = 17;
  else return { hasError: true, message: "VLESS addr type invalid: " + at };
  if (buf.length < ai + alen) return { hasError: true, message: "VLESS addr truncated" };
  let host;
  if (at === 1) host = Array.from(buf.slice(ai + 1, ai + 5)).join(".");
  else if (at === 2) host = buf.slice(ai + 2, ai + alen).toString("utf-8");
  else {
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(buf.readUInt16BE(ai + 1 + i * 2).toString(16));
    host = parts.join(":");
  }
  return { hasError: false, addressRemote: host, portRemote: port, isUdp,
           rawClientData: buf.slice(ai + alen), replyHead: Buffer.from([ver, 0]) };
}

// DNS-over-HTTPS (pengganti UDP mentah ke 8.8.8.8 yg tidak reliable di PaaS)
function dohQuery(payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(DOH_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/dns-message", "content-length": payload.length, "accept": "application/dns-message" },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode === 200) resolve(Buffer.concat(chunks));
        else reject(new Error("DoH status " + res.statusCode));
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("DoH timeout")));
    req.end(payload);
  });
}

// Pecah datagram VMess UDP: tiap datagram diawali panjang 2 byte (big-endian)
function splitVmessDatagrams(buf) {
  const out = [];
  let p = 0;
  while (p + 2 <= buf.length) {
    const l = (buf[p] << 8) | buf[p + 1];
    if (p + 2 + l > buf.length) break;
    out.push(buf.slice(p + 2, p + 2 + l));
    p += 2 + l;
  }
  return out;
}

// Parse satu datagram SOCKS5 UDP Request (Trojan): RSV(2) FRAG(1) ATYP ADDR PORT DATA
function parseSocks5Udp(buf) {
  if (buf.length < 4) throw new Error("Datagram terlalu pendek");
  let ai = 3;
  const at = buf[ai];
  let host, alen;
  if (at === 1) { host = Array.from(buf.slice(ai + 1, ai + 5)).join("."); alen = 5; }
  else if (at === 3) { const l = buf[ai + 1]; host = buf.slice(ai + 2, ai + 2 + l).toString("utf-8"); alen = 2 + l; }
  else if (at === 4) {
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(buf.readUInt16BE(ai + 1 + i * 2).toString(16));
    host = parts.join(":"); alen = 17;
  } else throw new Error("ATYP UDP invalid: " + at);
  const port = buf.readUInt16BE(ai + alen);
  return { host, port, data: buf.slice(ai + alen + 2) };
}

// Bungkus jawaban UDP ala SOCKS5 (untuk respons Trojan)
function wrapSocks5Udp(data) {
  const head = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  return Buffer.concat([head, data]);
}

class GatewayServer {
  constructor() {
    this.wss = null;
  }

  handleHttpRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);

    if (req.method === 'OPTIONS') {
      res.writeHead(200, CORS_HEADERS);
      res.end();
      return;
    }

    if (parsedUrl.pathname === '/tunnel') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ url: tunnelUrl, status: tunnelStatus }));
      return;
    }

    if (parsedUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ status: 'healthy', uptime: Math.floor(process.uptime()) }));
      return;
    }

    if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/dashboard') {
      const currentHost = req.headers.host || 'localhost:3000';
      const uptime = Math.floor(process.uptime());
      const ramUsed = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KANCIL VPN // CYBERPUNK GATEWAY</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');
    body { font-family: 'JetBrains Mono', monospace; background-color: #07080e; color: #cbd5e1; }
    .glow-box { box-shadow: 0 0 20px rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3); }
    .neon-card { background: #0d0f1a; border: 1px solid #1e293b; }
  </style>
</head>
<body class="min-h-screen pb-12">
  <header class="border-b border-slate-800 bg-[#0a0c16]/90 backdrop-blur sticky top-0 z-50 px-6 py-4">
    <div class="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <div class="h-10 w-10 rounded-xl bg-emerald-500/10 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
          <i class="fa-solid fa-bolt text-lg"></i>
        </div>
        <div>
          <h1 class="text-lg font-bold tracking-wider text-white">KANCIL_VPN<span class="text-emerald-400">.sys</span> <span class="text-[10px] align-middle bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 px-2 py-0.5 rounded-full">v1.1 • Tunnel + VMess AEAD</span></h1>
          <p class="text-[10px] text-slate-500">BLITZ TUNNEL GATEWAY v1.1</p>
        </div>
      </div>
      <div class="flex items-center gap-2 bg-emerald-950/60 border border-emerald-800 px-4 py-1.5 rounded-lg">
        <span class="h-2 w-2 rounded-full bg-emerald-400 animate-ping"></span>
        <span class="text-xs font-semibold text-emerald-300">SERVER ACTIVE</span>
      </div>
    </div>
  </header>

  <main class="max-w-6xl mx-auto px-6 pt-8 space-y-6">
    <div id="tunnelBanner" class="neon-card p-4 rounded-xl border border-amber-500/40">
      <p class="text-[10px] text-amber-400 font-bold mb-1">🌐 CLOUDFLARE TUNNEL</p>
      <p id="tunnelUrl" class="text-sm font-mono text-amber-200 break-all">Menghubungkan tunnel...</p>
      <p class="text-[10px] text-slate-500 mt-1">Buka dashboard via URL tunnel di atas agar link generate pakai domain tunnel (bypass proxy blitz).</p>
      <button id="tunnelOpenBtn" onclick="openTunnel()" class="mt-2 hidden bg-amber-600 hover:bg-amber-500 text-slate-950 font-bold px-4 py-1.5 rounded-lg text-xs">Buka via Tunnel</button>
    </div>
    <script>
      fetch('/tunnel').then(r=>r.json()).then(t=>{
        const el=document.getElementById('tunnelUrl');
        if(t.url){ el.textContent=t.url; document.getElementById('tunnelOpenBtn').classList.remove('hidden'); }
        else el.textContent='Status: '+t.status;
      }).catch(()=>{});
      function openTunnel(){ fetch('/tunnel').then(r=>r.json()).then(t=>{ if(t.url) location.href=t.url; }); }
    </script>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div class="neon-card p-4 rounded-xl">
        <p class="text-[10px] text-slate-500 font-bold mb-1">UPTIME</p>
        <p class="text-lg font-bold text-white">${uptime}s</p>
      </div>
      <div class="neon-card p-4 rounded-xl">
        <p class="text-[10px] text-slate-500 font-bold mb-1">RAM USED</p>
        <p class="text-lg font-bold text-emerald-400">${ramUsed} MB</p>
      </div>
      <div class="neon-card p-4 rounded-xl">
        <p class="text-[10px] text-slate-500 font-bold mb-1">PROTOKOL</p>
        <p class="text-lg font-bold text-purple-400">VLESS / TROJAN / VMESS</p>
      </div>
      <div class="neon-card p-4 rounded-xl">
        <p class="text-[10px] text-slate-500 font-bold mb-1">UDP & DNS</p>
        <p class="text-lg font-bold text-amber-400">PASSED 🟢</p>
      </div>
    </div>

    <div class="glow-box bg-[#0c0e18] rounded-2xl p-6">
      <div class="flex items-center gap-2 border-b border-slate-800 pb-3 mb-6">
        <i class="fa-solid fa-sliders text-emerald-400"></i>
        <h2 class="text-sm font-bold tracking-wide text-white">CONFIG GENERATOR</h2>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div class="space-y-4">
          <div>
            <div class="flex items-center justify-between mb-1">
              <label class="text-xs text-slate-400">UUID / Password</label>
              <button onclick="genUUID()" class="text-[10px] text-emerald-400 hover:text-emerald-300">
                <i class="fa-solid fa-arrows-rotate"></i> ACAK UUID
              </button>
            </div>
            <input id="uuid" type="text" value="${SYSTEM_UUID}" class="w-full bg-[#06070c] border border-slate-800 rounded-lg p-2.5 text-xs text-emerald-300 font-mono">
          </div>

          <div>
            <label class="text-xs text-slate-400 block mb-1">Username / Remark</label>
            <input id="remark" type="text" value="Kancil-VPN" class="w-full bg-[#06070c] border border-slate-800 rounded-lg p-2.5 text-xs text-white font-mono">
          </div>

          <div>
            <label class="text-xs text-slate-400 block mb-1">Masa Aktif</label>
            <select id="expired" class="w-full bg-[#06070c] border border-slate-800 rounded-lg p-2.5 text-xs text-emerald-300 font-mono">
              <option value="30m">Trial (30 Menit)</option>
              <option value="7d" selected>Weekly (7 Hari)</option>
              <option value="30d">Monthly (30 Hari)</option>
            </select>
          </div>

          <div>
            <label class="text-xs text-slate-400 block mb-1">Pilih Target Path Proxy</label>
            <select id="path" class="w-full bg-[#06070c] border border-slate-800 rounded-lg p-2.5 text-xs text-emerald-300 font-mono">
              <option value="id-akamai">🇮🇩 /id-akamai (172.232.249.224:2053)</option>
              <option value="id-deneva" selected>🇮🇩 /id-deneva (202.155.95.132:443)</option>
              <option value="sg-ovh">🇸🇬 /sg-ovh (51.79.177.53:443)</option>
              <option value="sg-oracle">🇸🇬 /sg-oracle (138.2.64.229:443)</option>
            </select>
          </div>

          <button onclick="genAcc()" class="w-full bg-emerald-600 hover:bg-emerald-500 text-black font-bold py-3 rounded-lg text-xs transition active:scale-95">
            GENERATE CONFIG LINKS
          </button>
        </div>

        <div class="space-y-4">
          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="text-[10px] text-purple-400 font-bold">VLESS WS TLS</span>
              <button onclick="copyId('vless')" class="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded">COPY</button>
            </div>
            <textarea id="vless" readonly class="w-full bg-[#06070c] border border-slate-800 rounded-lg p-2.5 text-xs text-purple-300 font-mono h-24 resize-none"></textarea>
          </div>
          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="text-[10px] text-emerald-400 font-bold">VMESS WS TLS</span>
              <button onclick="copyId('vmess')" class="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded">COPY</button>
            </div>
            <textarea id="vmess" readonly class="w-full bg-[#06070c] border border-slate-800 rounded-lg p-2.5 text-xs text-emerald-300 font-mono h-24 resize-none"></textarea>
          </div>
          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="text-[10px] text-amber-400 font-bold">TROJAN WS TLS</span>
              <button onclick="copyId('trojan')" class="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded">COPY</button>
            </div>
            <textarea id="trojan" readonly class="w-full bg-[#06070c] border border-slate-800 rounded-lg p-2.5 text-xs text-amber-300 font-mono h-24 resize-none"></textarea>
          </div>
        </div>
      </div>
    </div>
  </main>

  <script>
    const currentHost = location.host.split(':')[0];

    function genUUID() {
      document.getElementById('uuid').value = crypto.randomUUID();
      genAcc();
    }

    function genAcc() {
      const u = document.getElementById('uuid').value.trim();
      const p = document.getElementById('path').value.trim();
      const r = document.getElementById('remark').value.trim() || 'Kancil-VPN';
      const expType = document.getElementById('expired').value;

      let labelExp = "7D";
      if (expType === "30m") labelExp = "30M";
      else if (expType === "30d") labelExp = "30D";

      const cleanPath = "/" + p;
      const remarkTag = encodeURIComponent(\`\${r}[\${labelExp}]-\${p}\`);
      const encPath = encodeURIComponent(cleanPath);

      document.getElementById('vless').value = \`vless://\${u}@\${currentHost}:443?encryption=none&security=tls&sni=\${currentHost}&type=ws&host=\${currentHost}&path=\${encPath}#\${remarkTag}\`;
      const vmessCfg = { v:"2", ps:decodeURIComponent(remarkTag), add:currentHost, port:"443", id:u, aid:"0", scy:"auto", net:"ws", type:"none", host:currentHost, path:cleanPath, tls:"tls", sni:currentHost, alpn:"", fp:"chrome" };
      document.getElementById('vmess').value = "vmess://" + btoa(unescape(encodeURIComponent(JSON.stringify(vmessCfg))));
      document.getElementById('trojan').value = \`trojan://\${u}@\${currentHost}:443?security=tls&sni=\${currentHost}&type=ws&host=\${currentHost}&path=\${encPath}#\${remarkTag}\`;
    }

    function copyId(id) {
      const el = document.getElementById(id);
      el.select();
      navigator.clipboard.writeText(el.value);
      alert('Config berhasil disalin!');
    }

    window.onload = genAcc;
  </script>
</body>
</html>`);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  async handleWebSocketConnection(ws, request) {
    try {
      const parsedUrl = url.parse(request.url, true);
      const rawPath = parsedUrl.pathname.replace("/", "");
      // prxIP per-koneksi (dulu properti instance -> rebutan antar koneksi)
      const prxIP = PROXY_MAP[rawPath] || "104.64.192.116:443";
      await this.websocketHandler(ws, prxIP);
    } catch (err) {
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'Internal Error');
    }
  }

  // Deteksi protokol dari paket pertama (null = belum teridentifikasi, tunggu data lagi).
  // vless (0x00, tervalidasi) -> trojan (password tervalidasi) -> vmess AEAD (trial-decrypt UUID server)
  protocolSniffer(buffer) {
    if (buffer.length >= 24 && buffer[0] === 0x00) {
      try { if (!readVlessHeader(buffer).hasError) return "vless"; } catch (_) {}
    }
    if (buffer.length >= 62 && buffer[0] !== 0x00) {
      const d = buffer.slice(56, 60);
      if (d[0] === 0x0d && d[1] === 0x0a && [0x01,0x03,0x7f].includes(d[2]) && [0x01,0x03,0x04].includes(d[3])) {
        try { if (!this.readHorseHeader(buffer).hasError) return horse; } catch (_) {}
      }
    }
    if (buffer.length >= 42) {
      try { vmessExtract(buffer, SYSTEM_UUID); return flash; } catch (_) {}
    }
    return null;
  }

  // Fallback Shadowsocks (dipanggil bila handshake tak teridentifikasi)
  _ssFallback(ws, remoteSocketWrapper, prxIP, buf) {
    try {
      const header = this.readSsHeader(buf);
      if (header.hasError) throw new Error(header.message);
      ws._hsBuf = [];
      this.handleTCPOutBound(remoteSocketWrapper, header.addressRemote, header.portRemote,
        header.rawClientData, ws, null, prxIP, null, () => {
          const pend = ws._hsBuf || []; ws._hsBuf = null;
          const s = remoteSocketWrapper.value;
          if (s) for (const c of pend) if (s.writable) s.write(c);
        });
    } catch (err) {
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, err.message);
    }
  }

  // Teruskan 1 pesan WS ke target (dekripsi dulu utk VMess)
  forwardToTarget(ws, sock, chunk) {
    const vmess = ws._vmess;
    if (!vmess) { if (sock.writable) sock.write(chunk); return; }
    let r;
    try { r = vmess.dec.push(chunk); }
    catch (e) { if (ws.readyState === WebSocket.OPEN) ws.close(1011, "VMess: " + e.message); return; }
    for (const p of r.plains) if (sock.writable) sock.write(p);
    if (r.done && sock.writable) { try { sock.end(); } catch (_) {} }
  }

  async websocketHandler(ws, prxIP) {
    let remoteSocketWrapper = { value: null };
    ws._udp = null; // state UDP per-koneksi
    ws._vmess = null; // sesi body AEAD VMess (TCP)
    ws._hsBuf = null; // buffer pesan WS selama TCP connect berjalan
    ws._preHs = null; // akumulasi bytes handshake (tahan fragmentasi frame)
    ws._preTimer = null;

    ws.on('message', async (message) => {
      try {
        const chunk = Buffer.from(message);
        // Paket UDP lanjutan (sesi sudah terbentuk)
        if (ws._udp) {
          await this.handleUDPPackets(ws, chunk);
          return;
        }
        // TCP sudah konek: teruskan (dekripsi utk VMess)
        if (remoteSocketWrapper.value) {
          this.forwardToTarget(ws, remoteSocketWrapper.value, chunk);
          return;
        }
        // Handshake selesai, masih connecting: buffer dulu (hindari race)
        if (ws._hsBuf) { ws._hsBuf.push(chunk); return; }

        // Fase handshake: akumulasi sampai protokol teridentifikasi
        ws._preHs = ws._preHs ? Buffer.concat([ws._preHs, chunk]) : chunk;
        const protocol = this.protocolSniffer(ws._preHs);
        if (!protocol) {
          // Belum teridentifikasi: tunggu frame berikutnya.
          // Fallback SS bila buffer besar atau timeout (SS tak punya handshake).
          if (ws._preHs.length >= 2048) {
            const b = ws._preHs; ws._preHs = null;
            return this._ssFallback(ws, remoteSocketWrapper, prxIP, b);
          }
          if (!ws._preTimer) {
            ws._preTimer = setTimeout(() => {
              ws._preTimer = null;
              if (ws._preHs && !remoteSocketWrapper.value && !ws._udp && ws.readyState === WebSocket.OPEN) {
                const b = ws._preHs; ws._preHs = null;
                this._ssFallback(ws, remoteSocketWrapper, prxIP, b);
              }
            }, 1500);
          }
          return;
        }
        if (ws._preTimer) { clearTimeout(ws._preTimer); ws._preTimer = null; }
        const hsBuf = ws._preHs; ws._preHs = null;

        let header;
        if (protocol === "vless") header = readVlessHeader(hsBuf);
        else if (protocol === horse) header = this.readHorseHeader(hsBuf);
        else header = vmessExtract(hsBuf, SYSTEM_UUID);

        if (header.hasError) throw new Error(header.message);

        if (header.isUdp) {
          const isVmess = protocol === flash;
          let dec = null, enc = null;
          if (isVmess) {
            if (![VMESS_SEC_AES128_GCM, VMESS_SEC_CHACHA20_POLY1305].includes(header.vmessSec))
              throw new Error("Security VMess UDP tidak didukung: " + header.vmessSec);
            dec = new VmessChunkDecoder(header.reqKey, header.reqIv, header.vmessOpt, header.vmessSec);
            enc = new VmessChunkEncoder(header.respBodyKey, header.respBodyIV, header.vmessOpt, header.vmessSec);
          }
          ws._udp = {
            proto: protocol === "vless" ? "vless" : protocol === horse ? "trojan" : protocol === flash ? "vmess" : "ss",
            target: { host: header.addressRemote, port: header.portRemote },
            replyHead: header.replyHead || null,
            prefixSent: false,
            socks: new Map(),
            timers: new Map(),
            dec, enc,
          };
          const dgs = isVmess ? dec.push(header.rawClientData).plains : [header.rawClientData];
          for (const dg of dgs) await this.routeUDP(ws, ws._udp.target.host, ws._udp.target.port, dg);
          return;
        }

        // TCP: siapkan sesi VMess (dekripsi request, enkripsi response)
        ws._hsBuf = [];
        let vmess = null, initData = header.rawClientData;
        if (protocol === flash) {
          if (![VMESS_SEC_AES128_GCM, VMESS_SEC_CHACHA20_POLY1305].includes(header.vmessSec))
            throw new Error("Security VMess tidak didukung: " + header.vmessSec);
          const dec = new VmessChunkDecoder(header.reqKey, header.reqIv, header.vmessOpt, header.vmessSec);
          const enc = new VmessChunkEncoder(header.respBodyKey, header.respBodyIV, header.vmessOpt, header.vmessSec);
          vmess = { dec, enc };
          ws._vmess = vmess;
          initData = Buffer.concat(dec.push(header.rawClientData).plains);
        }
        this.handleTCPOutBound(remoteSocketWrapper, header.addressRemote, header.portRemote, initData, ws, header.replyHead, prxIP, vmess, () => {
          // flush buffer handshake setelah target konek
          const pend = ws._hsBuf || []; ws._hsBuf = null;
          const s = remoteSocketWrapper.value;
          if (!s) return;
          for (const c of pend) this.forwardToTarget(ws, s, c);
        });
      } catch (err) {
        if (ws.readyState === WebSocket.OPEN) ws.close(1011, err.message);
      }
    });

    ws.on('close', () => {
      if (ws._preTimer) { clearTimeout(ws._preTimer); ws._preTimer = null; }
      if (remoteSocketWrapper.value) remoteSocketWrapper.value.end();
      this.cleanupUDP(ws);
    });

    ws.on('error', () => this.cleanupUDP(ws));
  }

  // Paket UDP lanjutan setelah handshake (framing per protokol)
  async handleUDPPackets(ws, chunk) {
    const st = ws._udp;
    if (st.proto === "vmess") {
      // Tiap datagram VMess = 1 chunk AEAD (transferType packet)
      const { plains } = st.dec.push(chunk);
      for (const dg of plains) await this.routeUDP(ws, st.target.host, st.target.port, dg);
    } else if (st.proto === "trojan") {
      // Tiap datagram Trojan punya header SOCKS5 UDP sendiri
      const { host, port, data } = parseSocks5Udp(chunk);
      await this.routeUDP(ws, host, port, data);
    } else {
      // vless: tiap WS message = satu datagram
      await this.routeUDP(ws, st.target.host, st.target.port, chunk);
    }
  }

  // Route satu datagram UDP: port 53 -> DoH, lainnya -> relay UDP mentah
  async routeUDP(ws, targetAddress, targetPort, datagram) {
    const st = ws._udp;
    if (!datagram || !datagram.length) return;
    try {
      if (targetPort === 53) {
        const ans = await dohQuery(datagram);
        if (ws.readyState !== WebSocket.OPEN) return;
        if (st.proto === "vmess") {
          const sealed = st.enc.sealPacket(ans);
          if (!st.prefixSent && st.replyHead) { ws.send(Buffer.concat([st.replyHead, sealed])); st.prefixSent = true; }
          else ws.send(sealed);
        } else if (st.proto === "vless") {
          if (!st.prefixSent && st.replyHead) { ws.send(Buffer.concat([st.replyHead, ans])); st.prefixSent = true; }
          else ws.send(ans);
        } else {
          // trojan: respons dibungkus SOCKS5 UDP
          ws.send(wrapSocks5Udp(ans));
        }
        return;
      }
      // UDP non-DNS: relay via socket dgram per target (dipakai ulang)
      const key = `${targetAddress}:${targetPort}`;
      let entry = st.socks.get(key);
      if (!entry) {
        const sock = dgram.createSocket('udp4');
        entry = { sock };
        st.socks.set(key, entry);
        sock.on('message', (msg) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (st.proto === "vmess") {
            const sealed = st.enc.sealPacket(msg);
            if (!st.prefixSent && st.replyHead) { ws.send(Buffer.concat([st.replyHead, sealed])); st.prefixSent = true; }
            else ws.send(sealed);
          } else if (st.proto === "vless") {
            if (!st.prefixSent && st.replyHead) { ws.send(Buffer.concat([st.replyHead, msg])); st.prefixSent = true; }
            else ws.send(msg);
          } else {
            ws.send(wrapSocks5Udp(msg));
          }
        });
        sock.on('error', () => { try { sock.close(); } catch (_) {} st.socks.delete(key); });
        const timer = setTimeout(() => { try { sock.close(); } catch (_) {} st.socks.delete(key); st.timers.delete(key); }, 60000);
        st.timers.set(key, timer);
      } else {
        // refresh idle timer
        clearTimeout(st.timers.get(key));
        st.timers.set(key, setTimeout(() => { try { entry.sock.close(); } catch (_) {} st.socks.delete(key); st.timers.delete(key); }, 60000));
      }
      entry.sock.send(datagram, targetPort, targetAddress, () => {});
    } catch (e) { /* abaikan datagram gagal */ }
  }

  cleanupUDP(ws) {
    const st = ws._udp;
    if (!st) return;
    for (const [, t] of st.timers) clearTimeout(t);
    for (const [, e] of st.socks) { try { e.sock.close(); } catch (_) {} }
    st.socks.clear();
    ws._udp = null;
  }

  async handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader, prxIP, vmess, onReady) {
    let headerSent = false;
    const sendHeaderOnce = () => {
      // Kirim response header LANGSUNG saat target konek (jangan tunggu data pertama)
      if (!headerSent && responseHeader && webSocket.readyState === WebSocket.OPEN) {
        headerSent = true;
        webSocket.send(Buffer.from(responseHeader));
      }
    };
    const connectAndWrite = (address, port) => new Promise((resolve, reject) => {
      const s = net.createConnection({ host: address, port }, () => {
        if (rawClientData && rawClientData.length) s.write(rawClientData);
        resolve(s);
      });
      s.on('error', reject);
    });
    const hookSocket = (s, retry) => {
      remoteSocket.value = s;
      s.on('close', () => { if (webSocket.readyState === WebSocket.OPEN) webSocket.close(); });
      s.on('error', () => { if (webSocket.readyState === WebSocket.OPEN) webSocket.close(); });
      sendHeaderOnce();
      if (onReady) { const cb = onReady; onReady = null; cb(s); }
      this.remoteSocketToWS(s, webSocket, vmess, retry);
    };

    const retry = async () => {
      try {
        const parts = prxIP.split(":");
        const s = await connectAndWrite(parts[0], parseInt(parts[1], 10) || 443);
        hookSocket(s, null);
      } catch (e) {
        if (webSocket.readyState === WebSocket.OPEN) webSocket.close();
      }
    };

    try {
      const s = await connectAndWrite(addressRemote, portRemote);
      hookSocket(s, retry);
    } catch (e) {
      await retry();
    }
  }

  readSsHeader(buf) {
    const at = buf[0]; let al = 0, avi = 1, av = "";
    if (at === 1) { al = 4; av = Array.from(buf.slice(avi, avi+al)).join("."); }
    else if (at === 3) { al = buf[avi]; avi += 1; av = buf.slice(avi, avi+al).toString(); }
    else if (at === 4) { al = 16; const ip = []; for(let i=0;i<8;i++) ip.push(buf.readUInt16BE(avi+i*2).toString(16)); av = ip.join(":"); }
    else return { hasError: true, message: `Invalid addr type: ${at}` };
    const pi = avi + al;
    const pr = buf.readUInt16BE(pi);
    // FIX: SS di gateway ini hanya TCP. (Dulu: pr > 1024 dianggap UDP -> semua TCP rusak.)
    return { hasError: false, addressRemote: av, portRemote: pr, rawDataIndex: pi+2, rawClientData: buf.slice(pi+2), replyHead: null, isUdp: false };
  }

  readHorseHeader(buf) {
    // Verifikasi password trojan: SHA224(SYSTEM_UUID) hex 56 char
    const want = crypto.createHash("sha224").update(SYSTEM_UUID).digest("hex");
    if (buf.length < 62) return { hasError: true, message: "Trojan truncated" };
    if (buf.slice(0, 56).toString() !== want) return { hasError: true, message: "Trojan password salah" };
    const db = buf.slice(58);
    if (db.length < 6) return { hasError: true, message: "Invalid data" };
    let udp = db[0] === 3;
    let at = db[1]; let al = 0, avi = 2, av = "";
    if (at === 1) al = 4;
    else if (at === 3) al = db[avi];
    else if (at === 4) al = 16;
    else return { hasError: true, message: "ATYP trojan invalid: " + at };
    const addrLen = at === 3 ? al + 1 : al; // domain: +1 byte panjang
    if (db.length < avi + addrLen + 2 + 2) return { hasError: true, message: "Trojan addr truncated" };
    if (at === 1) av = Array.from(db.slice(avi, avi + al)).join(".");
    else if (at === 3) av = db.slice(avi + 1, avi + 1 + al).toString();
    else if (at === 4) { const ip = []; for (let i = 0; i < 8; i++) ip.push(db.readUInt16BE(avi + i * 2).toString(16)); av = ip.join(":"); }
    const pi = avi + addrLen;
    const pr = db.readUInt16BE(pi);
    return { hasError: false, addressRemote: av, portRemote: pr, rawDataIndex: pi + 4, rawClientData: db.slice(pi + 4), replyHead: null, isUdp: udp };
  }

  remoteSocketToWS(remoteSocket, webSocket, vmess, retry) {
    let hasData = false;
    remoteSocket.on('data', (chunk) => {
      hasData = true;
      if (webSocket.readyState !== WebSocket.OPEN) { remoteSocket.destroy(); return; }
      try {
        // Response body VMess dienkripsi chunk-AEAD; protokol lain raw
        webSocket.send(vmess ? vmess.enc.sealStream(chunk) : chunk);
      } catch (e) { /* abaikan chunk gagal */ }
    });
    remoteSocket.on('end', () => {
      // Sinyal terminasi chunk VMess (TCP) saat target selesai
      if (vmess && webSocket.readyState === WebSocket.OPEN) {
        try { webSocket.send(vmess.enc.sealEmpty()); } catch (_) {}
      }
    });
    remoteSocket.on('close', () => { if (!hasData && retry) retry(); });
  }

  start(port = PORT) {
    const server = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    this.wss = new WebSocketServer({ server, perMessageDeflate: false });
    this.wss.on('connection', (ws, req) => {
      this.handleWebSocketConnection(ws, req);
    });

    server.listen(port, '0.0.0.0', () => {
      console.log(`Server running on port ${port}`);
    });
  }
}

if (require.main === module) {
  const server = new GatewayServer();
  server.start();
  // jalankan tunnel di background (jangan blokir server)
  (async () => {
    try {
      await ensureCloudflared();
      await startTunnel(PORT);
    } catch (e) { console.log('[tunnel] gagal: ' + e.message); tunnelStatus = 'error: ' + e.message; }
  })();
}

module.exports = { GatewayServer, vmessExtract, readVlessHeader, dohQuery, splitVmessDatagrams, parseSocks5Udp, wrapSocks5Udp, VmessChunkDecoder, VmessChunkEncoder, makeShake128, makeChunkNonce, vmessKDF, vmessKDF16, SYSTEM_UUID, DOH_ENDPOINT };
