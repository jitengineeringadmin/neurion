// Offline GeoIP: geoip-lite bundles its own dataset, so the node's IP is resolved
// to a country entirely server-side — no external call, the IP is never exposed
// to the client and only the 2-letter country code is stored.
//
// Loaded on first use, never at import time. Importing geoip-lite reads its three
// .dat files SYNCHRONOUSLY as a side effect — 108,864,488 bytes — which every API
// start paid in full, before Nest even existed, for a lookup that only happens
// when a node registers. Measured on the slow test machine: 2.3 seconds of the
// cold start, for a feature most launches never touch.
//
// require() rather than await import() on purpose: this module compiles to
// CommonJS, so the lazy load stays synchronous and countryFromIp keeps its
// signature. Making it async would push a promise up through nodes.service for
// no benefit.
type GeoipLite = { lookup(ip: string): { country?: string } | null };

let cached: GeoipLite | null = null;
let unavailable = false;

function geoip(): GeoipLite | null {
  if (cached) return cached;
  if (unavailable) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cached = require("geoip-lite") as GeoipLite;
    return cached;
  } catch {
    // Kept outside the bundle; if it is genuinely missing, the region stays
    // unknown rather than taking the request down with it.
    unavailable = true;
    return null;
  }
}

const PRIVATE =
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|::ffff:(127|10|192\.168)\.)/i;

export function countryFromIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const clean = ip.replace(/^::ffff:/, "");
  if (PRIVATE.test(ip) || PRIVATE.test(clean)) return null;
  try {
    const geo = geoip()?.lookup(clean);
    return geo?.country ?? null;
  } catch {
    return null;
  }
}
