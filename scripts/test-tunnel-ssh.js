/** Compare tunnel-ssh vs ssh2 forward for Mongo reachability */
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');
const mongoose = require('mongoose');
const { createTunnel } = require('tunnel-ssh');
const getPort = require('get-port');

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

function mongoTunnelDestination(secret, env) {
  const direct = resolveKey(secret, 'mongoDB', env);
  if (direct) {
    const afterAt = direct.includes('@') ? direct.split('@').pop() : direct;
    const host = afterAt.split(':')[0]?.split('/')[0]?.trim();
    if (host) return host;
  }
  return resolveKey(secret, 'mongoDBDomain', env);
}

async function fetchMerged(sm) {
  const env = envSuffix();
  const merge = (a, b) => {
    const m = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (v != null && String(v).trim()) m[k] = v;
    }
    return m;
  };
  let s = await JSON.parse(
    (await sm.getSecretValue({ SecretId: process.env.AWS_SECRET_ID || 'BrandOps' }).promise())
      .SecretString,
  );
  try {
    const fb = await JSON.parse(
      (await sm.getSecretValue({ SecretId: process.env.AWS_SECRET_FALLBACK || 'JWKSUri' }).promise())
        .SecretString,
    );
    s = merge(fb, s);
  } catch {}
  return { secret: s, env };
}

async function tryMongo(uri, label) {
  console.log(`\n${label}...`);
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
    await mongoose.connection.db.admin().command({ ping: 1 });
    console.log('SUCCESS', label);
    await mongoose.disconnect();
    return true;
  } catch (e) {
    console.error('FAIL', label, e.message);
    await mongoose.disconnect().catch(() => {});
    return false;
  }
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
  const dstHost = mongoTunnelDestination(secret, env);
  const localPort = await getPort();
  console.log('mongoDBDomain', domainHost, 'tunnel dstHost', dstHost, 'localPort', localPort);

  await createTunnel(
    { autoClose: false, reconnectOnError: true },
    { host: '127.0.0.1', port: localPort },
    {
      host: resolveKey(secret, 'bastionHost', env),
      port: 22,
      username: resolveKey(secret, 'bastionUserName', env),
      privateKey: resolveKey(secret, 'mongoPem', env).replace(/\\n/g, '\n'),
    },
    { srcAddr: '127.0.0.1', srcPort: localPort, dstAddr: dstHost, dstPort: 27017 },
  );
  console.log('tunnel-ssh listening', localPort);

  const db = process.env.DB_NAME || 'marketOps';
  const user = resolveKey(secret, 'mongoDBUserName', env);
  const pass = resolveKey(secret, 'mongoDBPassword', env);

  const noAuth = `mongodb://127.0.0.1:${localPort}/${db}?directConnection=true`;
  const auth = `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@127.0.0.1:${localPort}/${db}?authSource=admin&directConnection=true`;

  if (await tryMongo(noAuth, 'tunnel-ssh no-auth')) process.exit(0);
  if (await tryMongo(auth, 'tunnel-ssh auth')) process.exit(0);

  const direct = resolveKey(secret, 'mongoDB', env);
  if (direct) {
    const directUri = direct.startsWith('mongodb://')
      ? direct
      : `mongodb://${direct}/${db}?authSource=admin`;
    console.log('direct URI host snippet:', directUri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@'));
    if (await tryMongo(directUri, 'direct mongoDBDev (no tunnel)')) process.exit(0);
  }

  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
