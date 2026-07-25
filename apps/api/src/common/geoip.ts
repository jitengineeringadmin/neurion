import * as geoip from 'geoip-lite';

// Offline GeoIP: geoip-lite bundles its own dataset, so the node's IP is resolved
// to a country entirely server-side — no external call, the IP is never exposed
// to the client and only the 2-letter country code is stored.
const PRIVATE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|::ffff:(127|10|192\.168)\.)/i;

export function countryFromIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const clean = ip.replace(/^::ffff:/, '');
  if (PRIVATE.test(ip) || PRIVATE.test(clean)) return null;
  try {
    const geo = geoip.lookup(clean);
    return geo?.country ?? null;
  } catch {
    return null;
  }
}
