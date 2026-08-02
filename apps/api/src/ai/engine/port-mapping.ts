import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";

/**
 * Ask the router to let the outside world in, so two people behind different
 * routers can reach each other.
 *
 * This is the piece that decides whether the network stops at your own house.
 * Every other way of solving it reintroduces exactly what the project exists to
 * remove: hole punching needs a rendezvous server that both sides trust, and a
 * relay needs somebody to carry the traffic. Asking your own router to open a
 * port needs nobody — it is what BitTorrent clients have done for twenty years,
 * and the only party involved is a box in your own home.
 *
 * Two protocols, tried in order, because home routers support one or the other:
 *
 *  - NAT-PMP / PCP: a few bytes of UDP to the gateway. Simple and exact.
 *  - UPnP IGD: SSDP discovery followed by a SOAP call. Uglier, far more common.
 *
 * Both are implemented here rather than pulled in as a dependency: between them
 * they are about two hundred lines, and a supply chain is a dependency of its
 * own kind for software whose whole point is not depending on anyone.
 *
 * Failure is normal and not an error. Plenty of routers have this switched off,
 * and carrier-grade NAT cannot be opened at all from inside. When it does not
 * work the network still runs on the local segment and through peers that are
 * directly reachable — it simply does not grow past the front door by itself.
 */

export interface Mapping {
  how: "nat-pmp" | "upnp";
  externalPort: number;
  externalAddress?: string;
  lifetimeSeconds: number;
}

/** The default gateway, guessed from our own address. Good enough for home networks. */
function likelyGateways(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      const parts = ni.address.split(".");
      if (parts.length !== 4) continue;
      // .1 and .254 cover essentially every consumer router.
      out.add(`${parts[0]}.${parts[1]}.${parts[2]}.1`);
      out.add(`${parts[0]}.${parts[1]}.${parts[2]}.254`);
    }
  }
  return [...out];
}

function firstPrivateAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return null;
}

// --- NAT-PMP (RFC 6886) ---------------------------------------------------

function natpmp(
  gateway: string,
  op: Buffer,
  timeoutMs: number,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const sock = createSocket("udp4");
    let settled = false;
    const done = (v: Buffer | null): void => {
      if (settled) return;
      settled = true;
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(v);
    };
    sock.on("message", (msg) => done(msg));
    sock.on("error", () => done(null));
    sock.send(op, 5351, gateway, (err) => {
      if (err) done(null);
    });
    setTimeout(() => done(null), timeoutMs);
  });
}

async function tryNatPmp(port: number, lifetime: number): Promise<Mapping | null> {
  for (const gateway of likelyGateways()) {
    // opcode 1 = map TCP. version 0, reserved 0, internal port, suggested
    // external port (same), lifetime in seconds.
    const req = Buffer.alloc(12);
    req.writeUInt8(0, 0);
    req.writeUInt8(1, 1);
    req.writeUInt16BE(0, 2);
    req.writeUInt16BE(port, 4);
    req.writeUInt16BE(port, 6);
    req.writeUInt32BE(lifetime, 8);

    const res = await natpmp(gateway, req, 1200);
    // 16 bytes, opcode 129 (128 + 1), result code 0 means it worked.
    if (!res || res.length < 16) continue;
    if (res.readUInt8(1) !== 129 || res.readUInt16BE(2) !== 0) continue;
    const externalPort = res.readUInt16BE(10);
    const granted = res.readUInt32BE(12);

    // Ask separately for the public address (opcode 0).
    let externalAddress: string | undefined;
    const addrReq = Buffer.alloc(2);
    const addrRes = await natpmp(gateway, addrReq, 1200);
    if (addrRes && addrRes.length >= 12 && addrRes.readUInt16BE(2) === 0) {
      externalAddress = `${addrRes.readUInt8(8)}.${addrRes.readUInt8(9)}.${addrRes.readUInt8(10)}.${addrRes.readUInt8(11)}`;
    }
    return {
      how: "nat-pmp",
      externalPort,
      externalAddress,
      lifetimeSeconds: granted || lifetime,
    };
  }
  return null;
}

// --- UPnP IGD -------------------------------------------------------------

/** SSDP: shout on the local segment and see which box answers as a gateway. */
function findIgd(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = createSocket({ type: "udp4", reuseAddr: true });
    let settled = false;
    const done = (v: string | null): void => {
      if (settled) return;
      settled = true;
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(v);
    };
    sock.on("error", () => done(null));
    sock.on("message", (msg) => {
      const text = msg.toString("utf8");
      const m = /^location:\s*(\S+)/im.exec(text);
      if (m?.[1]) done(m[1]);
    });
    const search = Buffer.from(
      "M-SEARCH * HTTP/1.1\r\n" +
        "HOST: 239.255.255.250:1900\r\n" +
        'MAN: "ssdp:discover"\r\n' +
        "MX: 2\r\n" +
        "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n",
    );
    sock.bind(0, () => {
      sock.send(search, 1900, "239.255.255.250", (err) => {
        if (err) done(null);
      });
    });
    setTimeout(() => done(null), timeoutMs);
  });
}

/** Read the device description and find the service that maps ports. */
async function igdControlUrl(
  location: string,
): Promise<{ controlUrl: string; serviceType: string } | null> {
  try {
    const res = await fetch(location, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const xml = await res.text();
    // WANIPConnection or WANPPPConnection, whichever this router exposes.
    const svc =
      /<serviceType>(urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:\d)<\/serviceType>[\s\S]*?<controlURL>([^<]+)<\/controlURL>/i.exec(
        xml,
      );
    if (!svc?.[1] || !svc[2]) return null;
    const base = new URL(location);
    return {
      serviceType: svc[1],
      controlUrl: new URL(svc[2], `${base.protocol}//${base.host}`).toString(),
    };
  } catch {
    return null;
  }
}

async function soap(
  controlUrl: string,
  serviceType: string,
  action: string,
  body: string,
): Promise<string | null> {
  try {
    const res = await fetch(controlUrl, {
      method: "POST",
      headers: {
        "Content-Type": 'text/xml; charset="utf-8"',
        SOAPAction: `"${serviceType}#${action}"`,
      },
      body:
        '<?xml version="1.0"?>' +
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
        `<u:${action} xmlns:u="${serviceType}">${body}</u:${action}>` +
        "</s:Body></s:Envelope>",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function tryUpnp(port: number, lifetime: number): Promise<Mapping | null> {
  const location = await findIgd(2500);
  if (!location) return null;
  const svc = await igdControlUrl(location);
  if (!svc) return null;
  const me = firstPrivateAddress();
  if (!me) return null;

  const ok = await soap(
    svc.controlUrl,
    svc.serviceType,
    "AddPortMapping",
    "<NewRemoteHost></NewRemoteHost>" +
      `<NewExternalPort>${port}</NewExternalPort>` +
      "<NewProtocol>TCP</NewProtocol>" +
      `<NewInternalPort>${port}</NewInternalPort>` +
      `<NewInternalClient>${me}</NewInternalClient>` +
      "<NewEnabled>1</NewEnabled>" +
      "<NewPortMappingDescription>Neurion model sharing</NewPortMappingDescription>" +
      `<NewLeaseDuration>${lifetime}</NewLeaseDuration>`,
  );
  if (ok === null) return null;

  let externalAddress: string | undefined;
  const addr = await soap(
    svc.controlUrl,
    svc.serviceType,
    "GetExternalIPAddress",
    "",
  );
  const m = addr ? /<NewExternalIPAddress>([^<]+)</i.exec(addr) : null;
  if (m?.[1]) externalAddress = m[1];

  return { how: "upnp", externalPort: port, externalAddress, lifetimeSeconds: lifetime };
}

/**
 * Try to become reachable from outside. Returns null when the router will not
 * cooperate, which is a normal outcome and not a failure worth shouting about.
 */
export async function openPort(
  port: number,
  lifetimeSeconds = 3600,
): Promise<Mapping | null> {
  return (
    (await tryNatPmp(port, lifetimeSeconds)) ??
    (await tryUpnp(port, lifetimeSeconds))
  );
}
