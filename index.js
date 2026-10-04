const http = require('http');
const net = require('net');
const https = require('https');
const PORT = process.env.PORT || 3000;

function testTcp(host, port, t = 8000) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port }, () => { s.destroy(); resolve('OK'); });
    s.setTimeout(t, () => { s.destroy(); resolve('TIMEOUT'); });
    s.on('error', (e) => resolve('ERROR: ' + e.message));
  });
}
function testDoh(t = 8000) {
  return new Promise((resolve) => {
    const req = https.get('https://1.1.1.1/dns-query?name=google.com&type=A',
      { headers: { 'accept': 'application/dns-json' }, timeout: t },
      (res) => { res.resume(); res.on('end', () => resolve('OK ' + res.statusCode)); });
    req.on('timeout', () => { req.destroy(); resolve('TIMEOUT'); });
    req.on('error', (e) => resolve('ERROR: ' + e.message));
  });
}
http.createServer(async (req, res) => {
  const r = {
    'Direct google.com:443': await testTcp('google.com', 443),
    'Direct 1.1.1.1:443': await testTcp('1.1.1.1', 443),
    'prxIP 202.155.95.132:443': await testTcp('202.155.95.132', 443),
    'DoH ke 1.1.1.1': await testDoh(),
  };
  let h = '<body style="background:#111;color:#eee;font-family:monospace;padding:20px"><h2>Tes Jaringan Keluar</h2><ul>';
  for (const [k, v] of Object.entries(r))
    h += `<li>${k}: <b style="color:${v.startsWith('OK') ? '#4f4' : '#f44'}">${v}</b></li>`;
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(h + '</ul><p>Semua OK = jaringan keluar normal.<br>Ada ERROR/TIMEOUT = blitz blokir koneksi keluar.</p></body>');
}).listen(PORT, () => console.log('tes jalan di ' + PORT));
