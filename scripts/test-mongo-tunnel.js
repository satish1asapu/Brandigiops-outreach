/**
 * Quick check: SSH tunnel + Mongo ping (same secrets as the app).
 * Run: node scripts/test-mongo-tunnel.js
 */
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');
const mongoose = require('mongoose');

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
  return undefined;
}

function mergeSecrets(fallback, primary) {
  const merged = { ...fallback };
  for (const [k, v] of Object.entries(primary)) {
    if (v != null && String(v).trim() !== '') merged[k] = v;
  }
  return merged;
}

async function main() {
  loadEnv();
  const env = envSuffix();
  const sm = new AWS.SecretsManager({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID_CS,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY_CS,
    },
  });

  const fetch = async (id) =>
    JSON.parse((await sm.getSecretValue({ SecretId: id }).promise()).SecretString);

  let secret = await fetch(process.env.AWS_SECRET_ID || 'BrandOps');
  if (process.env.AWS_SECRET_FALLBACK) {
    try {
      secret = mergeSecrets(await fetch(process.env.AWS_SECRET_FALLBACK), secret);
    } catch {
      /* ignore */
    }
  }

  const { SshTunnelManager } = require('../dist/utils/SshTunnel.manager');
  const tunnelMgr = new SshTunnelManager(
    async () => ({
      ssh: {
        host: resolveKey(secret, 'bastionHost', env),
        port: 22,
        username: resolveKey(secret, 'bastionUserName', env),
        privateKey: resolveKey(secret, 'mongoPem', env).replace(/\\n/g, '\n'),
      },
      dstHost: resolveKey(secret, 'mongoDBDomain', env),
      dstPort: 27017,
    }),
    { preferredPort: Number(process.env.TUNNEL_LOCAL_PORT) || 21210 },
  );

  const tunnel = await tunnelMgr.start();
  console.log('Tunnel:', tunnel);

  const user = resolveKey(secret, 'mongoDBUserName', env);
  const pass = resolveKey(secret, 'mongoDBPassword', env);
  const db = process.env.DB_NAME || 'marketOps';

  const uriRaw = `mongodb://${user}:${pass}@${tunnel.localHost}:${tunnel.localPort}/${db}?authSource=admin&directConnection=true`;
  const uriEnc = `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${tunnel.localHost}:${tunnel.localPort}/${db}?authSource=admin&directConnection=true`;

  const tries = [
    ['auth-raw', uriRaw],
    ['auth-encoded', uriEnc],
    ['no-auth', `mongodb://${tunnel.localHost}:${tunnel.localPort}/${db}?directConnection=true`],
  ];

  for (const [label, uri] of tries) {
    console.log(`\nTrying ${label}...`);
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
      await mongoose.connection.db.admin().command({ ping: 1 });
      console.log(`SUCCESS with ${label}`);
      await mongoose.disconnect();
      tunnelMgr.stop();
      process.exit(0);
    } catch (e) {
      console.error(`FAIL ${label}:`, e.message);
      await mongoose.disconnect().catch(() => {});
    }
  }

  console.log('\nResolved dstHost:', resolveKey(secret, 'mongoDBDomain', env));
  console.log('Resolved bastion:', resolveKey(secret, 'bastionHost', env));
  console.log('Mongo user:', user);

  tunnelMgr.stop();
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
