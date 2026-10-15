/** SSH to bastion and probe Mongo ports (no secrets printed). */
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');
const { Client } = require('ssh2');

function loadEnv() {
  const text = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
}

function envSuffix() {
  const e = (process.env.ENVIRONMENT || 'DEV').replace(/^["']|["']$/g, '').toUpperCase();
  return e.charAt(0) + e.slice(1).toLowerCase();
}

function resolveKey(secret, base, env) {
  for (const key of [`${base}${env}`, `${base}${env.toUpperCase()}`, base]) {
    const v = secret[key];
    if (v != null && String(v).trim()) return String(v);
  }
}

function mongoTunnelTarget(secret, env) {
  const direct = resolveKey(secret, 'mongoDB', env);
  const parse = (segment) => {
    const stripped = String(segment).replace(/^mongodb:\/\//, '');
    const afterAt = stripped.includes('@') ? stripped.split('@').pop() : stripped;
    const hostPort = afterAt.split('/')[0]?.trim();
    if (!hostPort) return null;
    const [host, portStr] = hostPort.split(':');
    if (!host?.trim()) return null;
    const port = portStr ? Number(portStr) : 27017;
    return { host: host.trim(), port: Number.isFinite(port) ? port : 27017 };
  };
  if (direct) {
    const t = parse(direct);
    if (t) return t;
  }
  const domain = resolveKey(secret, 'mongoDBDomain', env);
  if (domain) {
    const t = parse(domain.includes(':') ? `x@${domain}` : domain);
    if (t) return t;
  }
  return null;
}

async function fetchMerged(sm) {
  const merge = (a, b) => {
    const m = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (v != null && String(v).trim()) m[k] = v;
    }
    return m;
  };
  let s = JSON.parse(
    (await sm.getSecretValue({ SecretId: process.env.AWS_SECRET_ID || 'BrandOps' }).promise())
      .SecretString,
  );
  try {
    const fb = JSON.parse(
      (await sm.getSecretValue({ SecretId: process.env.AWS_SECRET_FALLBACK || 'JWKSUri' }).promise())
        .SecretString,
    );
    s = merge(fb, s);
  } catch {}
  return { secret: s, env: envSuffix() };
}

function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('data', (d) => (out += d.toString()));
      stream.stderr.on('data', (d) => (out += d.toString()));
      stream.on('close', (code) => resolve({ code, out: out.trim() }));
    });
  });
}

async function main() {
  loadEnv();
  const sm = new AWS.SecretsManager({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID_CS,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY_CS,
    },
  });
  const { secret, env } = await fetchMerged(sm);
  const domainHost = resolveKey(secret, 'mongoDBDomain', env);
  const target = mongoTunnelTarget(secret, env);

  const sshCfg = {
    host: resolveKey(secret, 'bastionHost', env),
    port: 22,
    username: resolveKey(secret, 'bastionUserName', env),
    privateKey: resolveKey(secret, 'mongoPem', env).replace(/\\n/g, '\n'),
    readyTimeout: 20000,
  };

  const probes = [
    { host: '127.0.0.1', port: 27017 },
    { host: 'localhost', port: 27017 },
  ];
  if (domainHost) probes.push({ host: domainHost.split(':')[0], port: 27017 });
  if (target) probes.push(target);
  const seen = new Set();
  const unique = probes.filter((p) => {
    const k = `${p.host}:${p.port}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log('Probing from bastion', sshCfg.host, 'targets:', unique.map((p) => `${p.host}:${p.port}`).join(', '));

  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject).connect(sshCfg);
  });
  console.log('SSH ready');

  for (const { host, port } of unique) {
    const cmd = ` (command -v nc >/dev/null && nc -z -w3 ${host} ${port} && echo OPEN) || (timeout 3 bash -c 'echo >/dev/tcp/${host}/${port}' && echo OPEN) || echo CLOSED `;
    const r = await exec(conn, cmd);
    console.log(`${host}:${port} =>`, r.out.split('\n').pop() || r.out, `(exit ${r.code})`);
  }

  conn.end();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
