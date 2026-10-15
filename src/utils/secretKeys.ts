/** Resolve BrandOps / JWKSUri JSON keys (Dev vs DEV vs unsuffixed). */
export function resolveSecretKey(
  secret: Record<string, unknown> | undefined,
  base: string,
  env: string,
): string | undefined {
  if (!secret) return undefined;

  const envUpper = env.toUpperCase();
  const envLower = env.toLowerCase();
  const candidates = [
    `${base}${env}`,
    `${base}${envUpper}`,
    `${base}${envLower}`,
    base,
  ];

  for (const key of candidates) {
    const value = secret[key];
    if (value != null && String(value).trim() !== '') {
      return String(value);
    }
  }

  const baseLower = base.toLowerCase();
  for (const [key, value] of Object.entries(secret)) {
    if (
      key.toLowerCase().startsWith(baseLower) &&
      key.toLowerCase().includes(envLower) &&
      value != null &&
      String(value).trim() !== ''
    ) {
      return String(value);
    }
  }

  return undefined;
}

export interface MongoTunnelTarget {
  host: string;
  port: number;
}

function parseHostPortFromMongoSegment(segment: string): MongoTunnelTarget | undefined {
  const stripped = segment.replace(/^mongodb:\/\//, '');
  const afterAt = stripped.includes('@') ? stripped.split('@').pop()! : stripped;
  const hostPort = afterAt.split('/')[0]?.trim();
  if (!hostPort) return undefined;
  const [host, portStr] = hostPort.split(':');
  if (!host?.trim()) return undefined;
  const port = portStr ? Number(portStr) : 27017;
  return { host: host.trim(), port: Number.isFinite(port) && port > 0 ? port : 27017 };
}

/** Mongo endpoint for SSH forward (prefer host/port from mongoDBDev URI). */
export function mongoTunnelTarget(
  secret: Record<string, unknown>,
  env: string,
): MongoTunnelTarget | undefined {
  const direct = resolveSecretKey(secret, 'mongoDB', env);
  if (direct) {
    const parsed = parseHostPortFromMongoSegment(direct);
    if (parsed) return parsed;
  }
  const domain = resolveSecretKey(secret, 'mongoDBDomain', env);
  if (domain) {
    const parsed = parseHostPortFromMongoSegment(domain.includes(':') ? `x@${domain}` : domain);
    if (parsed) return parsed;
  }
  return undefined;
}

/** @deprecated use mongoTunnelTarget */
export function mongoTunnelDestination(
  secret: Record<string, unknown>,
  env: string,
): string | undefined {
  return mongoTunnelTarget(secret, env)?.host;
}
