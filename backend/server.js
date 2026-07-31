const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const readline = require('readline');
const chokidar = require('chokidar');
const geoip = require('geoip-lite');
const cors = require('cors');
const { exec } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const LOG_FILE = process.env.CADDY_LOG_FILE || '/logs/access.log';
const PORT = process.env.PORT || 3001;
const SERVER_LAT = parseFloat(process.env.SERVER_LAT || '51.5074');
const SERVER_LON = parseFloat(process.env.SERVER_LON || '-0.1278');
const SERVER_CITY = process.env.SERVER_CITY || 'My Server';
const GDPR_MODE = (process.env.GDPR_MODE || 'true').toLowerCase() !== 'false';
const MAX_HISTORY = 200;

console.log(`GDPR mode: ${GDPR_MODE ? 'ON (IPs hidden)' : 'OFF (IPs visible)'}`);

let recentEvents = [];
const stats = {
  totalRequests: 0,
  uniqueIPs: new Set(),
  countryCount: {},
  startTime: Date.now(),
};

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

function parseLine(line) {
  line = line.trim();
  if (!line) return null;
  try {
    const entry = JSON.parse(line);
    const ip = (entry.request?.remote_ip || entry.request?.client_ip || '').split(':')[0];
    if (!ip || ip === '127.0.0.1' || ip === '::1') return null;
    if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.')) return null;
    if (entry.request?.headers?.["X-Netwatch-Client"]) return null;

    const geo = geoip.lookup(ip);
    if (!geo || !geo.ll) return null;

    return {
      id: Math.random().toString(36).slice(2),
      ts: Date.now(),
      ip,
      lat: geo.ll[0],
      lon: geo.ll[1],
      city: geo.city || geo.region || '',
      country: geo.country,
      method: entry.request?.method || 'GET',
      uri: entry.request?.uri || '/',
      status: entry.status || 200,
      host: entry.request?.host || '',
      serverLat: SERVER_LAT,
      serverLon: SERVER_LON,
    };
  } catch {
    return null;
  }
}

function recordEvent(evt) {
  if (!evt) return;
  stats.totalRequests++;
  stats.uniqueIPs.add(evt.ip);
  stats.countryCount[evt.country] = (stats.countryCount[evt.country] || 0) + 1;
  recentEvents.unshift(evt);
  if (recentEvents.length > MAX_HISTORY) recentEvents.pop();
  broadcast({ type: 'hit', event: evt });
}

function readExistingLog(file) {
  if (!fs.existsSync(file)) {
    console.log(`Log file not found: ${file} - waiting...`);
    return;
  }
  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream });
  rl.on('line', line => {
    const evt = parseLine(line);
    if (evt) {
      stats.totalRequests++;
      stats.uniqueIPs.add(evt.ip);
      stats.countryCount[evt.country] = (stats.countryCount[evt.country] || 0) + 1;
      recentEvents.unshift(evt);
    }
  });
  rl.on('close', () => {
    if (recentEvents.length > MAX_HISTORY) recentEvents.length = MAX_HISTORY;
    console.log(`Loaded ${recentEvents.length} historical events`);
  });
}

function tailLog(file) {
  let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  chokidar.watch(file, { persistent: true, ignoreInitial: true, usePolling: true, interval: 500 }).on('change', () => {
    try {
      const newSize = fs.statSync(file).size;
      if (newSize < size) { size = 0; }
      if (newSize === size) return;
      const stream = fs.createReadStream(file, { start: size, end: newSize });
      size = newSize;
      const rl = readline.createInterface({ input: stream });
      rl.on('line', line => recordEvent(parseLine(line)));
    } catch (e) {
      console.error('Tail error:', e.message);
    }
  });
  console.log(`Tailing ${file}`);
}

// Fail2Ban status endpoint
// Requires fail2ban.sock to be mounted into the container
// See docker-compose.yml volumes section
app.get('/api/fail2ban', (req, res) => {
  exec('fail2ban-client -s /run/fail2ban/fail2ban.sock status', (err, stdout) => {
    if (err) return res.status(500).json({ error: 'fail2ban-client not available: ' + err.message });

    const jailLine = stdout.match(/Jail list:\s*(.+)/);
    if (!jailLine) return res.json({ jails: [], gdprMode: GDPR_MODE });

    const jails = jailLine[1].split(',').map(j => j.trim()).filter(Boolean);
    const results = [];
    let completed = 0;

    if (jails.length === 0) return res.json({ jails: [], gdprMode: GDPR_MODE });

    jails.forEach(jail => {
      exec(`fail2ban-client -s /run/fail2ban/fail2ban.sock status ${jail}`, (err2, out2) => {
        if (!err2) {
          const get = (label) => {
            const m = out2.match(new RegExp(label + ':\\s*(\\d+)'));
            return m ? parseInt(m[1]) : 0;
          };
          const ipLine = out2.match(/Banned IP list:\s*(.+)/);
          const bannedIPs = ipLine ? ipLine[1].trim().split(/\s+/).filter(Boolean) : [];
          results.push({
            name: jail,
            currentlyFailed: get('Currently failed'),
            totalFailed: get('Total failed'),
            currentlyBanned: get('Currently banned'),
            totalBanned: get('Total banned'),
            bannedIPs,
          });
        }
        completed++;
        if (completed === jails.length) {
          res.json({ jails: results.sort((a, b) => b.currentlyBanned - a.currentlyBanned), gdprMode: GDPR_MODE });
        }
      });
    });
  });
});

app.get('/api/stats', (req, res) => {
  res.json({
    totalRequests: stats.totalRequests,
    uniqueIPs: stats.uniqueIPs.size,
    topCountries: Object.entries(stats.countryCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([country, count]) => ({ country, count })),
    uptime: Math.floor((Date.now() - stats.startTime) / 1000),
    recentEvents: recentEvents.slice(0, 50),
    server: { lat: SERVER_LAT, lon: SERVER_LON, city: SERVER_CITY },
    gdprMode: GDPR_MODE,
  });
});

wss.on('connection', ws => {
  ws.send(JSON.stringify({
    type: 'init',
    recentEvents: recentEvents.slice(0, 50),
    server: { lat: SERVER_LAT, lon: SERVER_LON, city: SERVER_CITY },
    gdprMode: GDPR_MODE,
    stats: {
      totalRequests: stats.totalRequests,
      uniqueIPs: stats.uniqueIPs.size,
    }
  }));
});

readExistingLog(LOG_FILE);
tailLog(LOG_FILE);

server.listen(PORT, () => {
  console.log(`HawkEYE backend running on :${PORT}`);
});
