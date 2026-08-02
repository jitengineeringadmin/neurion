import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";
import { join } from "node:path";
import { createSocket, Socket } from "node:dgram";
import { networkInterfaces } from "node:os";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { CATALOG } from "./llama-catalog";
import { openPort, type Mapping } from "./port-mapping";
import {
  Kad,
  computeKeyFor,
  isId,
  keyFor,
  type Contact,
  type KadRequest,
  type KadResponse,
} from "./kad";

/**
 * Model weights, passed directly between machines.
 *
 * The point is survivability, not speed. Everything else in this app still has
 * a single place it can be cut off from — the catalogue points at HuggingFace,
 * updates come from one domain. This does not: if every server on the internet
 * went dark, a machine that already has gemma-2-2b could still hand it to the
 * one next to it, and that one to the next.
 *
 * Three deliberate limits, because each removes a way this could hurt someone:
 *
 *  - ONLY CATALOGUE MODELS ARE OFFERED. Their hashes are known and their
 *    contents are public anyway. A model the user pointed us at from their own
 *    disk is never announced and never served: it could be a private fine-tune,
 *    and it is not ours to give away.
 *  - THE HASH DECIDES, NOT THE PEER. Nothing arriving here is trusted. A
 *    transfer is accepted only if it hashes to the model that was asked for, so
 *    a hostile peer can waste bandwidth and nothing else.
 *  - THE LOCAL NETWORK IS ONLY THE START. A machine is found four ways, in
 *    order of how little each costs somebody else: a UDP announcement on the
 *    local segment, a knock on the addresses we met before, the addresses a
 *    user typed in, and — when none of those hold the model — a distributed
 *    index that can name a machine on the other side of the world. See kad.ts.
 */

/** What a peer says about itself, several times a minute. */
interface Announcement {
  v: 1;
  peerId: string;
  port: number;
  /** sha256 of every catalogue model this machine can serve. */
  has: string[];
}

export interface KnownPeer {
  peerId: string;
  address: string;
  port: number;
  has: string[];
  lastSeen: number;
  /** Whether this peer will run a prompt for others. */
  compute?: boolean;
  /** The model it currently has loaded, if it says. */
  running?: string | null;
}

const GROUP = "239.192.71.1"; // administratively scoped, local segment only
const DISCOVERY_PORT = 48071;
const ANNOUNCE_EVERY_MS = 20_000;
/** A peer unheard from for this long is dropped: laptops close mid-transfer. */
const PEER_TTL_MS = 70_000;

@Injectable()
export class PeerService implements OnModuleDestroy {
  private readonly logger = new Logger(PeerService.name);
  private ident: { peerId: string; publicKey: string; privateKey: string } | null = null;
  /** Fingerprint of this machine's public key; empty only if it cannot be created. */
  private get peerId(): string {
    return this.identity()?.peerId ?? "";
  }
  private readonly peers = new Map<string, KnownPeer>();
  private sock: Socket | null = null;
  private http: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private sweeping = false;
  /** How many times this machine has handed a model to somebody else. */
  private served = 0;
  private sweepTimer: NodeJS.Timeout | null = null;
  /** Hash of the model this machine currently has loaded, if any. */
  private runningModel: string | null = null;
  /** One borrowed computation at a time. */
  private busy = false;
  /** How many prompts this machine has answered for other people. */
  private computed = 0;
  private ledgerCache: Record<string, { given: number; received: number }> | null = null;
  /** Set when the router agreed to let the outside in. */
  private mapping: Mapping | null = null;
  private mapTimer: NodeJS.Timeout | null = null;
  /** The distributed index. Created once the identity exists, since it is the id. */
  private kadNode: Kad | null = null;
  private kadTimer: NodeJS.Timeout | null = null;
  private kadJoined = false;
  private kadRounds = 0;
  /** Transfers in flight, and the machines they are going to. */
  private uploads = 0;
  private uploadingTo = new Set<string>();
  /** Token bucket for the shared upload ceiling. */
  private bucket = 0;
  private lastRefill = Date.now();

  constructor(private readonly config: ConfigService) {}

  /** Where downloaded models live. Set by the desktop shell. */
  private dir(): string | null {
    return (
      this.config.get<string>("NEURION_TEXT_DIR") ||
      process.env.NEURION_TEXT_DIR ||
      null
    );
  }

  private sharePort(): number {
    return Number(this.config.get<string>("NEURION_PEER_PORT") ?? 8097);
  }

  private sharingPath(dir: string): string {
    return join(dir, "peer-sharing.json");
  }

  /**
   * Sharing is on unless switched off. It costs the sharer nothing — the file is
   * already on the disk, and serving it is a read — which is exactly the
   * property that made Napster and eMule work and that donated-compute networks
   * never had.
   *
   * It has to be reachable from the interface, not only from an environment
   * variable, and that became true the day the index went global: leaving it on
   * now means this machine's address is listed where people look, not merely
   * reachable if somebody already knows it. A default that publishes something
   * about you is only defensible if turning it off takes one click.
   */
  enabled(): boolean {
    // An explicit environment setting wins, so a deployment can force it.
    const v =
      this.config.get<string>("NEURION_PEER_SHARING") ??
      process.env.NEURION_PEER_SHARING;
    if (v === "false" || v === "0") return false;
    if (v === "true" || v === "1") return true;
    const dir = this.dir();
    if (!dir) return true;
    try {
      const saved = JSON.parse(readFileSync(this.sharingPath(dir), "utf8")) as {
        enabled?: boolean;
      };
      return saved.enabled !== false;
    } catch {
      return true; // never chosen: on, which is what the app is for
    }
  }

  /**
   * Turn sharing on or off, now rather than at the next start.
   *
   * Off means: no model is served, nothing is announced, and this machine holds
   * no part of the index for anybody. It can still FIND things — asking is not
   * publishing, and somebody who cannot spare the upstream should not be cut off
   * from the network they are helping to justify.
   */
  setSharingEnabled(on: boolean): boolean {
    const dir = this.dir();
    if (!dir) throw new Error("no engine directory configured");
    writeFileSync(this.sharingPath(dir), JSON.stringify({ enabled: on }));
    if (on) {
      this.started = false;
      this.start();
      this.logger.log("sharing is on: this machine is reachable and listed");
    } else {
      this.stopServing();
      this.logger.log(
        "sharing is off: nothing is served, nothing is announced, and this machine is no longer part of the index",
      );
    }
    return this.enabled();
  }

  /** Close everything that makes this machine visible, leaving lookups working. */
  private stopServing(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    // Including the router renewal: without this, switching sharing off and on
    // again left the old one running and asked the router twice, forever.
    if (this.mapTimer) clearInterval(this.mapTimer);
    this.mapTimer = null;
    if (this.kadTimer) {
      clearTimeout(this.kadTimer);
      clearInterval(this.kadTimer);
    }
    this.timer = null;
    this.sweepTimer = null;
    this.kadTimer = null;
    try {
      this.sock?.close();
    } catch {
      /* already closed */
    }
    this.sock = null;
    try {
      // close() alone only stops NEW connections; a peer already talking to us
      // would keep being served, which is not what "off" means to the person
      // who just clicked it.
      this.http?.closeAllConnections?.();
      this.http?.close();
    } catch {
      /* already closed */
    }
    this.http = null;
    this.started = false;
  }

  /** Catalogue models present on this machine, by hash. */
  private localHashes(): Map<string, { path: string; size: number }> {
    const out = new Map<string, { path: string; size: number }>();
    const dir = this.dir();
    if (!dir) return out;
    for (const m of CATALOG) {
      if (!m.sha256) continue;
      const p = join(dir, "models", m.file);
      try {
        if (!existsSync(p)) continue;
        const st = statSync(p);
        // Size is not a security check — the hash is — but it cheaply skips a
        // half-finished file that would only fail on the other end.
        if (st.size !== m.sizeBytes) continue;
        out.set(m.sha256, { path: p, size: st.size });
      } catch {
        /* unreadable: simply not offered */
      }
    }
    return out;
  }

  start(): void {
    if (this.started || !this.enabled()) return;
    this.started = true;
    this.serve();
    this.discover();
    // Only if the person said yes. Opening a port on somebody's router is a
    // change to their home network, not an implementation detail.
    if (this.reachability() === "on") void this.becomeReachable();
    // Not immediately: there is nobody to ask until discovery has found at
    // least one machine, and asking nobody teaches us nothing.
    this.kadTimer = setTimeout(() => {
      void this.joinNetwork();
      this.kadTimer = setInterval(() => void this.joinNetwork(), 10 * 60_000);
    }, 20_000);
  }

  /**
   * Ask the router to open our port, and keep asking before the lease expires.
   *
   * Without this the network stops at the front door: two people behind
   * different routers can never reach each other, however well discovery works.
   * With it, someone can hand out a real address and be found from anywhere —
   * and no third party was needed to arrange it.
   */
  private async becomeReachable(): Promise<void> {
    const port = this.sharePort();
    const renew = async (): Promise<void> => {
      const m = await openPort(port, 3600);
      if (m) {
        if (!this.mapping) {
          this.logger.log(
            `the router opened port ${m.externalPort} via ${m.how}` +
              (m.externalAddress
                ? ` — others can reach this machine at ${m.externalAddress}:${m.externalPort}`
                : ""),
          );
        }
        this.mapping = m;
      } else if (!this.mapping) {
        // Common and not a fault: plenty of routers have this switched off, and
        // carrier-grade NAT cannot be opened from the inside at all.
        this.logger.log(
          "the router would not open a port — sharing still works on this network, and with peers that can already reach you",
        );
      }
    };
    await renew();
    // Well inside the hour we asked for, so the door never closes between renewals.
    this.mapTimer = setInterval(() => void renew(), 25 * 60_000);
  }

  /** The address to give somebody who is not on this network, if we have one. */
  publicAddress(): string | null {
    if (!this.mapping?.externalAddress) return null;
    return `${this.mapping.externalAddress}:${this.mapping.externalPort}`;
  }

  // --- being a good guest in somebody's house -----------------------------
  //
  // Everything above is about what the network can do. This is about what it
  // costs the person whose machine it runs on, which is a different question
  // and the one that decides whether they keep it installed.
  //
  // A sharing client with no upload limit is not generous, it is rude: one peer
  // pulling a five gigabyte model can take a whole household's upstream, and
  // the family blames the app, correctly. eMule had upload slots in its first
  // version and not for elegance. So: a few transfers at a time, one per
  // machine so nobody can hold every slot, and a ceiling on the rate.
  //
  // The defaults are deliberately timid. Somebody on fibre can lift them in a
  // second; somebody on a thin line should never have to discover this setting
  // by noticing their connection has gone.

  private limitsPath(dir: string): string {
    return join(dir, "peer-limits.json");
  }

  /** How much of this machine the owner is lending out. */
  limits(): { slots: number; kbPerSecond: number } {
    const dir = this.dir();
    const fallback = { slots: 3, kbPerSecond: 1024 };
    if (!dir) return fallback;
    try {
      const raw = JSON.parse(readFileSync(this.limitsPath(dir), "utf8")) as {
        slots?: unknown;
        kbPerSecond?: unknown;
      };
      return {
        slots:
          Number.isInteger(raw.slots) && (raw.slots as number) > 0
            ? Math.min(raw.slots as number, 50)
            : fallback.slots,
        // Zero means no ceiling, which is a legitimate choice, not a mistake.
        kbPerSecond:
          Number.isInteger(raw.kbPerSecond) && (raw.kbPerSecond as number) >= 0
            ? (raw.kbPerSecond as number)
            : fallback.kbPerSecond,
      };
    } catch {
      return fallback;
    }
  }

  setLimits(next: { slots?: number; kbPerSecond?: number }): {
    slots: number;
    kbPerSecond: number;
  } {
    const dir = this.dir();
    if (!dir) throw new Error("no engine directory configured");
    const now = this.limits();
    const merged = {
      slots:
        Number.isInteger(next.slots) && (next.slots as number) > 0
          ? Math.min(next.slots as number, 50)
          : now.slots,
      kbPerSecond:
        Number.isInteger(next.kbPerSecond) && (next.kbPerSecond as number) >= 0
          ? (next.kbPerSecond as number)
          : now.kbPerSecond,
    };
    writeFileSync(this.limitsPath(dir), JSON.stringify(merged));
    this.logger.log(
      `upload limits: ${merged.slots} at a time, ` +
        (merged.kbPerSecond === 0
          ? "no rate ceiling"
          : `${merged.kbPerSecond} KB/s in total`),
    );
    return merged;
  }

  /** Hold the caller back so the total rate stays under the ceiling. */
  private async throttle(bytes: number): Promise<void> {
    const cap = this.limits().kbPerSecond * 1024;
    if (cap <= 0) return;
    for (;;) {
      const now = Date.now();
      this.bucket = Math.min(
        cap,
        this.bucket + ((now - this.lastRefill) / 1000) * cap,
      );
      this.lastRefill = now;
      if (this.bucket >= bytes) {
        this.bucket -= bytes;
        return;
      }
      const waitMs = ((bytes - this.bucket) / cap) * 1000;
      await new Promise((r) =>
        setTimeout(r, Math.min(500, Math.max(5, waitMs))),
      );
    }
  }

  /**
   * Hand over a model, slowly enough that the owner keeps their connection.
   *
   * A refusal here is a plain 503 with a Retry-After rather than a queue. A
   * queue would hold the door open and quietly turn somebody's laptop into a
   * server; being told "not now, try again or try somebody else" is honest, and
   * where a model has more than one copy it is also faster.
   */
  private async sendBlob(
    res: ServerResponse,
    hit: { path: string; size: number },
    who: string,
  ): Promise<void> {
    const { slots } = this.limits();
    if (this.uploads >= slots || this.uploadingTo.has(who)) {
      res.statusCode = 503;
      res.setHeader("retry-after", "30");
      res.removeHeader("content-length");
      res.end();
      return;
    }
    this.uploads += 1;
    this.uploadingTo.add(who);
    // Logged on purpose. Seeing that you handed a model to somebody is the only
    // thing a volunteer gets back, and it has to stand where a payment would.
    const name = hit.path.split(/[\\/]/).pop();
    const startedAt = Date.now();
    this.served += 1;
    this.logger.log(`sending ${name} to ${who}`);
    try {
      for await (const chunk of createReadStream(hit.path, {
        highWaterMark: 64 * 1024,
      })) {
        if (res.destroyed) break;
        await this.throttle((chunk as Buffer).length);
        if (!res.write(chunk)) {
          await new Promise<void>((r) => res.once("drain", () => r()));
        }
      }
      if (!res.destroyed) res.end();
      const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      const mbps = Math.round(hit.size / secs / 125_000);
      this.logger.log(
        `sent ${name} to ${who} — ${Math.round(hit.size / 1e6)} MB in ${secs}s (~${mbps} Mbit/s)`,
      );
    } catch {
      res.destroy();
    } finally {
      this.uploads -= 1;
      this.uploadingTo.delete(who);
    }
  }

  // --- refusing one machine instead of all of them ------------------------
  //
  // Until now the only answer to a peer behaving badly was to switch sharing
  // off entirely, which punishes everybody else for what one machine did. A
  // list of addresses to ignore is the smallest thing that gives the owner a
  // proportionate reply.

  private blockedPath(dir: string): string {
    return join(dir, "peer-blocked.json");
  }

  blocked(): string[] {
    const dir = this.dir();
    if (!dir) return [];
    try {
      const raw = JSON.parse(readFileSync(this.blockedPath(dir), "utf8"));
      return Array.isArray(raw)
        ? raw.filter((x): x is string => typeof x === "string")
        : [];
    } catch {
      return [];
    }
  }

  private isBlocked(address: string): boolean {
    return this.blocked().includes(address);
  }

  block(address: string): string[] {
    const dir = this.dir();
    if (!dir) throw new Error("no engine directory configured");
    const clean = address.trim();
    if (!/^[A-Za-z0-9._:-]+$/.test(clean)) {
      throw new Error(`not an address: ${address}`);
    }
    const list = this.blocked();
    if (!list.includes(clean)) list.push(clean);
    writeFileSync(this.blockedPath(dir), JSON.stringify(list, null, 2));
    // Drop it from the live picture too, so it stops being chosen at once.
    for (const [id, p] of this.peers) {
      if (p.address === clean) this.peers.delete(id);
    }
    this.logger.log(`ignoring ${clean} from now on`);
    return list;
  }

  unblock(address: string): string[] {
    const dir = this.dir();
    if (!dir) throw new Error("no engine directory configured");
    const list = this.blocked().filter((a) => a !== address.trim());
    writeFileSync(this.blockedPath(dir), JSON.stringify(list, null, 2));
    return list;
  }

  // --- asking before opening the front door -------------------------------
  //
  // Making a machine reachable from the internet is a real change to somebody's
  // home network, and it used to happen on first launch without a word. That is
  // defensible for a torrent client somebody went looking for; it is not
  // defensible for a stranger who installed an AI app. Until they answer, the
  // door stays shut — sharing still works on the local network and with peers
  // that can already reach them.

  private reachPath(dir: string): string {
    return join(dir, "peer-reachable.json");
  }

  /** "unset" until the person has actually been asked. */
  reachability(): "unset" | "on" | "off" {
    const forced =
      this.config.get<string>("NEURION_PEER_OPEN_PORT") ??
      process.env.NEURION_PEER_OPEN_PORT;
    if (forced === "true" || forced === "1") return "on";
    if (forced === "false" || forced === "0") return "off";
    const dir = this.dir();
    if (!dir) return "unset";
    try {
      const raw = JSON.parse(readFileSync(this.reachPath(dir), "utf8")) as {
        allowed?: unknown;
      };
      if (raw.allowed === true) return "on";
      if (raw.allowed === false) return "off";
      return "unset";
    } catch {
      return "unset";
    }
  }

  setReachable(allowed: boolean): "on" | "off" {
    const dir = this.dir();
    if (!dir) throw new Error("no engine directory configured");
    writeFileSync(this.reachPath(dir), JSON.stringify({ allowed }));
    if (allowed) {
      void this.becomeReachable();
    } else if (this.mapTimer) {
      clearInterval(this.mapTimer);
      this.mapTimer = null;
      // Whatever the router already granted expires by itself; we stop renewing
      // it rather than pretending we can reliably close it.
      this.logger.log(
        "no longer asking the router to keep this machine reachable — a mapping already granted will lapse on its own",
      );
    }
    return allowed ? "on" : "off";
  }

  /** Read-only file server: one route, and it only answers for known hashes. */
  private serve(): void {
    const port = this.sharePort();
    const server = createServer((req, res) => {
      // Somebody the owner has told us to ignore gets nothing, on any route.
      // First, because a machine you have refused should not even learn what
      // you hold.
      const from = PeerService.plainAddress(req.socket.remoteAddress);
      if (from && this.isBlocked(from)) {
        res.statusCode = 403;
        res.end();
        return;
      }
      // What this machine has. Needed because multicast does not survive a lot
      // of consumer Wi-Fi — measured on a real network: the file server was
      // reachable between two machines while not a single announcement got
      // through — so peers are also found by asking directly.
      if (req.url === "/peer/have") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            v: 1,
            peerId: this.peerId,
            publicKey: this.identity()?.publicKey ?? null,
            has: [...this.localHashes().keys()],
            compute: this.computeEnabled(),
            running: this.runningModel,
            // Peer exchange: everyone we know about, so a newcomer that can
            // reach one machine can reach the rest without any registry.
            peers: this.known()
              .slice(0, 40)
              .map((p) => ({ address: p.address, port: p.port })),
          }),
        );
        return;
      }
      if (req.url === "/peer/infer" && req.method === "POST") {
        void this.lendCompute(req, res);
        return;
      }
      if (req.url === "/peer/kad" && req.method === "POST") {
        void this.answerKad(req, res);
        return;
      }
      const m = /^\/peer\/blob\/([0-9a-f]{64})$/.exec(req.url ?? "");
      const wanted = m?.[1];
      if (!wanted) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const hit = this.localHashes().get(wanted);
      if (!hit) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-length", String(hit.size));
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      void this.sendBlob(res, hit, from ?? "somebody");
    });
    server.on("error", (e) => {
      this.logger.warn(`peer sharing disabled: ${e.message}`);
      this.http = null;
    });
    // Bound to every interface on purpose: a peer on the same network has to be
    // able to reach it. It serves nothing but public model weights, by hash, and
    // never anything the user supplied themselves.
    server.listen(port, "0.0.0.0", () => {
      this.logger.log(`sharing models with peers on port ${port}`);
    });
    this.http = server;
  }

  private discover(): void {
    const sock = createSocket({ type: "udp4", reuseAddr: true });
    sock.on("error", (e) => {
      this.logger.warn(`peer discovery unavailable: ${e.message}`);
      try {
        sock.close();
      } catch {
        /* already gone */
      }
      this.sock = null;
    });
    sock.on("message", (buf, rinfo) => this.onAnnounce(buf, rinfo.address));
    sock.bind(DISCOVERY_PORT, () => {
      try {
        sock.addMembership(GROUP);
        sock.setMulticastTTL(1); // never leaves the local segment
      } catch (e) {
        this.logger.warn(`multicast unavailable: ${(e as Error).message}`);
      }
      this.announce();
      this.timer = setInterval(() => this.announce(), ANNOUNCE_EVERY_MS);
      // Multicast may simply never arrive on this network. Look for neighbours
      // directly too — immediately, then every half minute while nobody has
      // answered. The sweep stops costing anything as soon as a peer is found.
      void this.sweep();
      this.sweepTimer = setInterval(() => {
        // The subnet sweep stops once somebody is around, but the seeds are
        // asked regardless: they are how this reaches beyond the local network,
        // and a friend coming online should be noticed.
        if (this.known().length === 0) void this.sweep();
        else void this.askSeeds();
      }, 30_000);
    });
    this.sock = sock;
  }

  private announce(): void {
    if (!this.sock) return;
    const id = this.identity();
    if (!id) return;
    const msg: Announcement = {
      v: 1,
      peerId: id.peerId,
      port: this.sharePort(),
      has: [...this.localHashes().keys()],
    };
    // Signed, so an announcement cannot be forged in somebody else's name. It
    // costs nothing here and it is what makes reciprocity possible later: you
    // can only remember who helped you if names cannot be borrowed.
    const wire = this.signed(msg);
    if (!wire) return;
    const buf = Buffer.from(wire);
    try {
      this.sock.send(buf, 0, buf.length, DISCOVERY_PORT, GROUP);
    } catch {
      /* the network came and went */
    }
    this.forget();
  }

  private onAnnounce(buf: Buffer, address: string): void {
    // Anything at all can be sent to a UDP port. An unsigned, malformed or
    // forged announcement is simply dropped; a signed one only proves who sent
    // it, never that what it offers is genuine — that is still the hash's job.
    const opened = this.opened(buf.toString("utf8"));
    if (!opened) return;
    const { peerId, payload } = opened;
    if (peerId === this.peerId) return; // our own announcement, echoed back
    if (payload.v !== 1 || !Number.isInteger(payload.port)) return;
    const has = Array.isArray(payload.has)
      ? (payload.has as unknown[]).filter(
          (h): h is string => typeof h === "string" && /^[0-9a-f]{64}$/.test(h),
        )
      : [];
    this.remember(address, payload.port as number, peerId, has);
  }

  private forget(): void {
    const cutoff = Date.now() - PEER_TTL_MS;
    for (const [id, p] of this.peers) {
      if (p.lastSeen < cutoff) this.peers.delete(id);
    }
  }


  /**
   * Ask every address on the local /24 whether it is running Neurion.
   *
   * Multicast is the polite way to do this and it is what runs first, but it is
   * not dependable: measured on a real home Wi-Fi, two machines could reach each
   * other's file server perfectly while not a single announcement got through —
   * consumer access points routinely drop or filter multicast between wireless
   * clients. Discovery that only works on a cooperative network is discovery
   * that fails exactly when someone first tries it.
   *
   * So: one cheap HTTP request per address, short timeout, all in parallel. On a
   * /24 that is 254 requests that either connect immediately or fail
   * immediately. Only runs while there is nobody around — once a peer answers,
   * multicast keeps the picture fresh and this stays quiet.
   */
  /**
   * Some people will not want their machine probing every address on the
   * network they are attached to — a company LAN, a shared office. Off means
   * multicast and typed-in addresses only.
   */
  private sweepAllowed(): boolean {
    const v =
      this.config.get<string>("NEURION_PEER_SWEEP") ??
      process.env.NEURION_PEER_SWEEP;
    return v !== "false" && v !== "0";
  }

  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    if (!this.sweepAllowed()) {
      // The subnet scan is off, but the remembered nodes and the typed-in
      // addresses are not a scan — they are places we were invited to.
      this.sweeping = true;
      try {
        await this.askRemembered();
        await this.askSeeds();
      } finally {
        this.sweeping = false;
      }
      return;
    }
    this.sweeping = true;
    try {
      const port = this.sharePort();
      // Everyone we have ever met first — a machine that already knows the
      // network should not rediscover its own neighbourhood every time.
      await this.askRemembered();
      // Then the addresses the user typed: they may be the only way out.
      await this.askSeeds();
      const bases = this.localSubnets();
      for (const base of bases) {
        const probes: Array<Promise<void>> = [];
        for (let i = 1; i <= 254; i++) {
          const address = `${base}.${i}`;
          probes.push(this.ask(address, port));
        }
        await Promise.all(probes);
      }
    } finally {
      this.sweeping = false;
    }
  }

  /** IPv4 /24 prefixes this machine sits on, loopback and link-local excluded. */
  private localSubnets(): string[] {
    const out = new Set<string>();
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family !== "IPv4" || ni.internal) continue;
        // Only /24s. Sweeping a /16 would be 65k requests for no good reason,
        // and home networks are /24 essentially always.
        if (ni.netmask !== "255.255.255.0") continue;
        out.add(ni.address.split(".").slice(0, 3).join("."));
      }
    }
    return [...out];
  }

  /** One probe. A peer answers with what it has; anything else is ignored. */
  private async ask(address: string, port: number): Promise<void> {
    try {
      const res = await fetch(`http://${address}:${port}/peer/have`, {
        signal: AbortSignal.timeout(1200),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          v?: number;
          peerId?: string;
          has?: unknown;
          peers?: Array<{ address?: unknown; port?: unknown }>;
          compute?: unknown;
          running?: unknown;
        };
        if (body?.v !== 1 || typeof body.peerId !== "string") return;
        if (body.peerId === this.peerId) return; // ourselves, another interface
        const has = Array.isArray(body.has)
          ? body.has.filter(
              (h): h is string =>
                typeof h === "string" && /^[0-9a-f]{64}$/.test(h),
            )
          : [];
        // It answered, so it is worth knocking on again after a restart.
        this.rememberNode(address, port);
        // And it is a proven node, so the distributed index may route through
        // it. Anything learned any other way is a candidate, never an entry.
        this.kad()?.seen({ id: body.peerId, address, port });
        this.remember(address, port, body.peerId, has, {
          compute: body.compute === true,
          running:
            typeof body.running === "string" && /^[0-9a-f]{64}$/.test(body.running)
              ? body.running
              : null,
        });
        if (Array.isArray(body.peers)) await this.followGossip(body.peers);
        return;
      }
      // An older Neurion: it serves blobs but cannot list them. It still
      // answered on this port, which is enough to know somebody is there, so
      // ask about each catalogue model instead. Fourteen cheap HEAD requests,
      // and only ever to a machine that has already replied.
      if (res.status === 404) await this.inventoryTheHardWay(address, port);
    } catch {
      /* nobody there, or not us — the normal case for 253 of 254 addresses */
    }
  }

  private remember(
    address: string,
    port: number,
    peerId: string,
    has: string[],
    extra: { compute?: boolean; running?: string | null } = {},
  ): void {
    const known = this.peers.get(peerId);
    this.peers.set(peerId, {
      peerId,
      address,
      port,
      has,
      lastSeen: Date.now(),
      // Announcements over UDP do not carry these; keep whatever a direct ask
      // established rather than blanking it on every heartbeat.
      compute: extra.compute ?? known?.compute,
      running: extra.running !== undefined ? extra.running : known?.running,
    });
    if (!known) {
      this.logger.log(`found a peer at ${address} offering ${has.length} models`);
    }
  }

  /**
   * Build a peer's inventory by asking about each model in turn.
   *
   * For versions that predate the inventory endpoint. Backwards compatibility
   * matters more here than almost anywhere else in the app: a sharing network
   * where a new release cannot see the release before it is a network that
   * starts empty every time it improves.
   */
  private async inventoryTheHardWay(
    address: string,
    port: number,
  ): Promise<void> {
    const has: string[] = [];
    for (const m of CATALOG) {
      if (!m.sha256) continue;
      try {
        const r = await fetch(`http://${address}:${port}/peer/blob/${m.sha256}`, {
          method: "HEAD",
          signal: AbortSignal.timeout(1500),
        });
        if (r.ok) has.push(m.sha256);
      } catch {
        return; // it went away mid-scan; it will be found on the next pass
      }
    }
    // No peerId to key on, so the address is the identity for these. Prefixed
    // to make it obvious in logs that this one was found the slow way.
    this.remember(address, port, `addr:${address}`, has);
  }


  // --- who this machine is ------------------------------------------------
  //
  // An Ed25519 key pair, generated once and kept next to the models. The peer
  // id is the fingerprint of the public key, so identity is something a machine
  // PROVES rather than something a server hands out. Nobody issues it, nobody
  // can revoke it, and it survives restarts — which the random id it replaces
  // did not, so a peer looked like a stranger every time it came back.
  //
  // This is what phase 3 will need: reciprocity means remembering who gave you
  // something, and you cannot remember someone whose name changes every reboot.

  private identityPath(dir: string): string {
    return join(dir, "peer-identity.json");
  }

  /** Load the key pair, creating it the first time. */
  private identity(): { peerId: string; publicKey: string; privateKey: string } | null {
    if (this.ident) return this.ident;
    const dir = this.dir();
    if (!dir) return null;
    const path = this.identityPath(dir);
    try {
      const saved = JSON.parse(readFileSync(path, "utf8")) as {
        publicKey?: string;
        privateKey?: string;
      };
      if (saved.publicKey && saved.privateKey) {
        this.ident = {
          peerId: PeerService.fingerprint(saved.publicKey),
          publicKey: saved.publicKey,
          privateKey: saved.privateKey,
        };
        return this.ident;
      }
    } catch {
      /* first run, or a file we cannot read: make a new one */
    }
    try {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const pub = publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64");
      const priv = privateKey
        .export({ type: "pkcs8", format: "der" })
        .toString("base64");
      mkdirSync(dir, { recursive: true });
      // 0600 where the platform honours it. On Windows the file sits in the
      // user's own profile, which is the same protection everything else here
      // relies on.
      writeFileSync(path, JSON.stringify({ publicKey: pub, privateKey: priv }), {
        mode: 0o600,
      });
      this.ident = { peerId: PeerService.fingerprint(pub), publicKey: pub, privateKey: priv };
      this.logger.log(`this machine is peer ${this.ident.peerId}`);
      return this.ident;
    } catch (e) {
      this.logger.warn(`could not create a peer identity: ${(e as Error).message}`);
      return null;
    }
  }

  /** Short, stable name for a public key. */
  private static fingerprint(publicKeyB64: string): string {
    return createHash("sha256")
      .update(Buffer.from(publicKeyB64, "base64"))
      .digest("hex")
      .slice(0, 32);
  }

  /** Sign a payload so a peer cannot claim to be somebody else. */
  private signed(payload: object): string | null {
    const id = this.identity();
    if (!id) return null;
    const body = JSON.stringify(payload);
    try {
      const key = createPrivateKey({
        key: Buffer.from(id.privateKey, "base64"),
        format: "der",
        type: "pkcs8",
      });
      const sig = sign(null, Buffer.from(body), key).toString("base64");
      return JSON.stringify({ body, publicKey: id.publicKey, sig });
    } catch {
      return null;
    }
  }

  /**
   * Check a signed message and return its contents, or null.
   *
   * Two things have to hold: the signature must be valid for the enclosed
   * public key, and the claimed peer id must be that key's fingerprint. Without
   * the second check a peer could sign with its own key while claiming
   * somebody else's name.
   */
  private opened(raw: string): { peerId: string; payload: Record<string, unknown> } | null {
    try {
      const outer = JSON.parse(raw) as {
        body?: string;
        publicKey?: string;
        sig?: string;
      };
      if (!outer.body || !outer.publicKey || !outer.sig) return null;
      const key = createPublicKey({
        key: Buffer.from(outer.publicKey, "base64"),
        format: "der",
        type: "spki",
      });
      const ok = verify(
        null,
        Buffer.from(outer.body),
        key,
        Buffer.from(outer.sig, "base64"),
      );
      if (!ok) return null;
      const payload = JSON.parse(outer.body) as Record<string, unknown>;
      const claimed = payload.peerId;
      const real = PeerService.fingerprint(outer.publicKey);
      if (typeof claimed !== "string" || claimed !== real) return null;
      return { peerId: real, payload };
    } catch {
      return null;
    }
  }


  // --- finding each other without a registry ------------------------------
  //
  // Two mechanisms, neither of which needs a server:
  //
  //  - PEER EXCHANGE. When we ask a machine what it has, it also tells us who
  //    else it knows. We never take its word for it — we go and ask those
  //    addresses ourselves — so a lying peer can waste a few requests and
  //    nothing more.
  //  - SEEDS. Addresses the user typed in, kept on disk. This is what makes the
  //    network work across the internet today: tell a friend your address once
  //    and neither of you ever needs neurionproject.org to find the other.
  //
  // Both are about the neighbourhood you can already reach. Reaching FURTHER —
  // a model held by somebody nobody here has ever met — is the distributed
  // index in kad.ts, and these two are how it gets started: it needs one
  // machine to ask, and this is how that machine is found.

  private seedsPath(dir: string): string {
    return join(dir, "peer-seeds.json");
  }

  /** Addresses the user added by hand. */
  seeds(): string[] {
    const dir = this.dir();
    if (!dir) return [];
    try {
      const raw = JSON.parse(readFileSync(this.seedsPath(dir), "utf8"));
      return Array.isArray(raw)
        ? raw.filter((x): x is string => typeof x === "string")
        : [];
    } catch {
      return [];
    }
  }

  addSeed(entry: string): string[] {
    const dir = this.dir();
    if (!dir) throw new Error("no engine directory configured");
    const clean = entry.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!/^[A-Za-z0-9._-]+(:\d{1,5})?$/.test(clean)) {
      throw new Error(`not a host or host:port: ${entry}`);
    }
    const list = this.seeds();
    if (!list.includes(clean)) list.push(clean);
    writeFileSync(this.seedsPath(dir), JSON.stringify(list, null, 2));
    // Try it straight away rather than waiting for the next sweep: someone who
    // just typed an address wants to know now whether it worked.
    const [host, port] = clean.split(":");
    if (host) void this.ask(host, Number(port) || this.sharePort());
    return list;
  }

  removeSeed(entry: string): string[] {
    const dir = this.dir();
    if (!dir) throw new Error("no engine directory configured");
    const list = this.seeds().filter((s) => s !== entry.trim());
    writeFileSync(this.seedsPath(dir), JSON.stringify(list, null, 2));
    return list;
  }

  /** Ask the seeds, wherever they are. Runs alongside the subnet sweep. */
  private async askSeeds(): Promise<void> {
    const port = this.sharePort();
    await Promise.all(
      this.seeds().map((s) => {
        const [host, p] = s.split(":");
        return host ? this.ask(host, Number(p) || port) : Promise.resolve();
      }),
    );
  }

  /**
   * Follow the peers a peer told us about.
   *
   * Bounded on purpose: only addresses we have not already got, only a handful
   * per round, and each one is verified by talking to it directly. Without a
   * bound, one machine advertising a long list would have us probing the world.
   */
  private async followGossip(
    told: Array<{ address?: unknown; port?: unknown }>,
  ): Promise<void> {
    const known = new Set(this.known().map((p) => `${p.address}:${p.port}`));
    const fresh: Array<[string, number]> = [];
    for (const t of told) {
      if (typeof t?.address !== "string") continue;
      const port = Number.isInteger(t.port) ? (t.port as number) : this.sharePort();
      if (!/^[0-9.]+$/.test(t.address) && !/^[A-Za-z0-9._-]+$/.test(t.address)) {
        continue;
      }
      if (known.has(`${t.address}:${port}`)) continue;
      fresh.push([t.address, port]);
      if (fresh.length >= 8) break;
    }
    await Promise.all(fresh.map(([a, p]) => this.ask(a, p)));
  }


  // --- lending the machine, not just the file -----------------------------
  //
  // Sharing weights costs the sharer nothing: the file is already on the disk
  // and serving it is a read. Sharing COMPUTE is different — it takes the
  // owner's processor and their electricity, and it makes their own machine
  // slower while it runs. So the two are not treated the same:
  //
  //  - weight sharing is on unless switched off;
  //  - compute sharing is OFF unless switched on. Donating a machine has to be
  //    a decision somebody made, not something they discover afterwards.
  //
  // Two more limits that follow from respecting whoever owns the machine:
  //
  //  - ONLY THE MODEL ALREADY LOADED. Swapping models for a stranger would
  //    interrupt the owner's own work. If the request is for something else,
  //    the answer is no, and the requester can go and fetch the weights instead.
  //  - ONE AT A TIME. A second request while one is running is refused rather
  //    than queued: a queue turns somebody's laptop into a server without ever
  //    telling them.
  //
  // And on the other side of the wire: THE PROMPT LEAVES THE MACHINE. This is
  // never chosen automatically. Local work stays local; a request only goes to
  // a peer because the user picked a model that only a peer can run.

  private computePath(dir: string): string {
    return join(dir, "peer-compute.json");
  }

  computeEnabled(): boolean {
    // An explicit environment setting wins, so a deployment can force it either
    // way; otherwise it is whatever the person at the machine chose, and off
    // until they choose.
    const v =
      this.config.get<string>("NEURION_PEER_COMPUTE") ??
      process.env.NEURION_PEER_COMPUTE;
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
    const dir = this.dir();
    if (!dir) return false;
    try {
      const saved = JSON.parse(readFileSync(this.computePath(dir), "utf8")) as {
        enabled?: boolean;
      };
      return saved.enabled === true;
    } catch {
      return false;
    }
  }

  /** Turn lending on or off, and remember it. */
  setComputeEnabled(on: boolean): boolean {
    const dir = this.dir();
    if (!dir) throw new Error("no engine directory configured");
    writeFileSync(this.computePath(dir), JSON.stringify({ enabled: on }));
    this.logger.log(
      on
        ? "this machine will now run prompts for other people"
        : "this machine will no longer run prompts for other people",
    );
    return this.computeEnabled();
  }

  /** Set by the engine so peers can be told what is loaded right now. */
  setRunningModel(sha256: string | null): void {
    this.runningModel = sha256;
  }

  /**
   * Answer somebody else's question with the model we are already running.
   *
   * Streams straight through from the local llama-server. Bounded on tokens so
   * one request cannot occupy the machine indefinitely.
   */
  private async lendCompute(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.computeEnabled()) {
      res.statusCode = 403;
      res.end("compute sharing is off on this machine");
      return;
    }
    const caller = req.socket.remoteAddress ?? "";
    const callerId = await this.whoIs(caller);
    if (this.busy) {
      // Refused, not queued — a queue quietly turns a laptop into a server.
      // The one exception is somebody we are in debt to: they helped us, so
      // they are told to come straight back rather than simply turned away.
      res.statusCode = 429;
      res.setHeader("retry-after", this.standing(callerId) > 0 ? "2" : "30");
      res.end("busy");
      return;
    }

    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 256_000) {
        res.statusCode = 413;
        res.end("too large");
        return;
      }
    }
    let ask: {
      sha256?: string;
      prompt?: string;
      maxTokens?: number;
      /** Both set when the caller intends to compare two answers. */
      temperature?: number;
      seed?: number;
    };
    try {
      ask = JSON.parse(body) as typeof ask;
    } catch {
      res.statusCode = 400;
      res.end("bad json");
      return;
    }
    if (
      typeof ask.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(ask.sha256) ||
      typeof ask.prompt !== "string" ||
      !ask.prompt.trim()
    ) {
      res.statusCode = 400;
      res.end("need sha256 and prompt");
      return;
    }
    if (ask.sha256 !== this.runningModel) {
      // Deliberately specific: the requester can then decide to fetch the
      // weights instead of guessing why they were turned away.
      res.statusCode = 409;
      res.end("that model is not the one loaded here");
      return;
    }

    const who = req.socket.remoteAddress ?? "somebody";
    this.busy = true;
    this.logger.log(`running a prompt for ${who}`);
    const startedAt = Date.now();
    try {
      const upstream = await fetch(
        `http://127.0.0.1:${this.enginePort()}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "peer",
            messages: [{ role: "user", content: ask.prompt.slice(0, 20_000) }],
            max_tokens: Math.min(Math.max(1, ask.maxTokens ?? 512), 2048),
            // Only when asked for. A model left to sample freely gives a
            // different answer every time, which is fine for one peer and
            // fatal for two: comparing two independent samples of the same
            // question tells you nothing about honesty, because they differ
            // for entirely innocent reasons. When the caller means to
            // cross-check, both peers are asked to run the same way.
            ...(typeof ask.temperature === "number" &&
            ask.temperature >= 0 &&
            ask.temperature <= 2
              ? { temperature: ask.temperature }
              : {}),
            ...(Number.isInteger(ask.seed) &&
            (ask.seed as number) >= 0 &&
            (ask.seed as number) <= 2_147_483_647
              ? { seed: ask.seed }
              : {}),
            stream: false,
          }),
          signal: AbortSignal.timeout(180_000),
        },
      );
      if (!upstream.ok) {
        res.statusCode = 502;
        res.end("the engine here refused");
        return;
      }
      const json = (await upstream.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = json.choices?.[0]?.message?.content ?? "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ v: 1, text }));
      this.computed += 1;
      if (callerId) this.note(callerId, "given");
      const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      this.logger.log(`answered ${who} in ${secs}s`);
    } catch (e) {
      res.statusCode = 504;
      res.end(`timed out: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private enginePort(): number {
    return Number(this.config.get<string>("NEURION_LLAMA_PORT") ?? 8095);
  }

  /** A peer that is running this exact model and will answer for others. */
  computeSourceFor(sha256: string): string | null {
    const peer = this.computeCandidates(sha256)[0];
    return peer ? `http://${peer.address}:${peer.port}/peer/infer` : null;
  }

  /** Record that a peer ran something for us. Called after a borrowed answer. */
  noteReceived(peerId: string): void {
    this.note(peerId, "received");
  }


  // --- reciprocity, which is what stands where the money was --------------
  //
  // eMule had credits and they were not money: uploading moved you up other
  // people's queues. That is the whole mechanism, and it works because it
  // answers the only real problem in a sharing network — people who take and
  // never give — without anybody having to be paid, counted in a currency, or
  // identified to a company.
  //
  // It needs exactly one thing that phase 2 provided: a name that cannot be
  // borrowed or reset. You cannot remember who helped you if a peer arrives
  // under a new identity every time it is inconvenient to be the old one.
  //
  // Deliberately generous: a stranger is served, just not before somebody you
  // owe. A network that turns newcomers away never gets any.

  private ledgerPath(dir: string): string {
    return join(dir, "peer-ledger.json");
  }

  /** given = we did work for them. received = they did work for us. */
  private ledger(): Record<string, { given: number; received: number }> {
    if (this.ledgerCache) return this.ledgerCache;
    const dir = this.dir();
    if (!dir) return {};
    try {
      this.ledgerCache = JSON.parse(
        readFileSync(this.ledgerPath(dir), "utf8"),
      ) as Record<string, { given: number; received: number }>;
    } catch {
      this.ledgerCache = {};
    }
    return this.ledgerCache;
  }

  private writeLedger(): void {
    const dir = this.dir();
    if (!dir || !this.ledgerCache) return;
    try {
      writeFileSync(this.ledgerPath(dir), JSON.stringify(this.ledgerCache));
    } catch {
      /* best effort: a lost ledger costs politeness, not correctness */
    }
  }

  private note(peerId: string, side: "given" | "received"): void {
    const l = this.ledger();
    const row = l[peerId] ?? { given: 0, received: 0 };
    row[side] += 1;
    l[peerId] = row;
    this.writeLedger();
  }

  /**
   * How much this peer is owed, from our point of view.
   *
   * Positive means they have done more for us than we have for them, so they
   * go first. Unknown peers sit at zero — served, but after anyone we are in
   * debt to.
   */
  private standing(peerId: string | null): number {
    if (!peerId) return 0;
    const row = this.ledger()[peerId];
    if (!row) return 0;
    return row.received - row.given;
  }

  /** What we owe and are owed, for the interface to show. */
  reciprocity(): {
    peers: number;
    given: number;
    received: number;
  } {
    const l = this.ledger();
    let given = 0;
    let received = 0;
    for (const row of Object.values(l)) {
      given += row.given;
      received += row.received;
    }
    return { peers: Object.keys(l).length, given, received };
  }

  /** Identify the caller by asking who is listening at their address. */
  private async whoIs(address: string): Promise<string | null> {
    const known = this.known().find((p) => p.address === address);
    return known?.peerId ?? null;
  }

  /**
   * Peers that can run this model, best first.
   *
   * "Best" is whoever we owe least — spreading the asking around instead of
   * leaning on the same generous machine until it gives up.
   */
  computeCandidates(sha256: string): KnownPeer[] {
    return this.known()
      .filter((p) => p.compute && p.running === sha256)
      .sort((a, b) => this.standing(a.peerId) - this.standing(b.peerId));
  }


  // --- borrowing, and checking what comes back ----------------------------
  //
  // A model's weights can be trusted absolutely: the hash either matches or it
  // does not. A model's ANSWER cannot. There is no checksum for "is this what
  // the model would really have said", and a peer that wants to mislead you can
  // return anything at all.
  //
  // What Folding@home did, and what is done here, is redundancy: give the same
  // work to more than one volunteer and compare. Be clear about what that buys
  // and what it does not:
  //
  //   IT CATCHES: a broken peer, a wrong model quietly substituted, a machine
  //   returning canned text, one participant lying on their own.
  //
  //   IT DOES NOT CATCH: two peers colluding, or a subtle change that survives
  //   a similarity comparison. And because the same model on two different
  //   machines does not produce byte-identical text — different CPU, different
  //   llama.cpp build, floating point — the comparison cannot be equality. It
  //   is word overlap, so it detects gross divergence, not delicate tampering.
  //
  // Which is why the result carries its own confidence rather than pretending:
  // "two peers agreed" and "only one peer could answer" are different things,
  // and the caller is told which one it got.

  /** Word-overlap similarity, 0..1. Cheap, and enough to spot a different answer. */
  private static similarity(a: string, b: string): number {
    const words = (t: string): Set<string> =>
      new Set(
        t
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s]/gu, " ")
          .split(/\s+/)
          .filter(Boolean),
      );
    const x = words(a);
    const y = words(b);
    if (x.size === 0 && y.size === 0) return 1;
    if (x.size === 0 || y.size === 0) return 0;
    let shared = 0;
    for (const w of x) if (y.has(w)) shared += 1;
    return shared / Math.max(x.size, y.size);
  }

  /** Ask one peer, and record the favour if it answers. */
  private async askPeerToRun(
    peer: KnownPeer,
    sha256: string,
    prompt: string,
    maxTokens: number,
    /**
     * Set when this answer is going to be compared with another one.
     *
     * Redundancy only means something if the work is reproducible. Left to
     * itself a model samples, so two honest machines return different words to
     * the same question and the comparison reports a disagreement that is not
     * one — an alarm that goes off every time is an alarm nobody reads. Asking
     * both to run the same way makes a difference in the answers mean what it
     * is supposed to mean.
     */
    reproducible = false,
  ): Promise<{ peerId: string; text: string } | null> {
    try {
      const res = await fetch(`http://${peer.address}:${peer.port}/peer/infer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sha256,
          prompt,
          maxTokens,
          ...(reproducible
            ? {
                temperature: 0,
                // The same number for both, derived from the question itself,
                // so neither peer can be handed a seed the other did not get.
                seed:
                  parseInt(
                    createHash("sha256").update(prompt).digest("hex").slice(0, 8),
                    16,
                  ) % 2_147_483_647,
              }
            : {}),
        }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { text?: unknown };
      if (typeof body.text !== "string" || !body.text.trim()) return null;
      this.note(peer.peerId, "received");
      return { peerId: peer.peerId, text: body.text };
    } catch {
      return null;
    }
  }

  /**
   * Have somebody else run this, and say how much the answer can be trusted.
   *
   * Two peers are asked when two are available. Both are recorded as having
   * done us a favour, because both did the work — paying only the one whose
   * answer we kept would make redundancy something peers learn to avoid.
   */
  async borrow(
    sha256: string,
    prompt: string,
    maxTokens = 512,
  ): Promise<{
    text: string;
    confidence: "identical" | "agreed" | "disagreed" | "single";
    askedPeers: string[];
    similarity?: number;
  } | null> {
    // Neighbours first: a machine on the same network is faster and involves
    // one fewer stranger. Then the index, which can reach somebody this
    // machine has never met — and two peers are wanted, not one, because a
    // single answer cannot be cross-checked.
    let candidates = this.computeCandidates(sha256).slice(0, 2);
    if (candidates.length < 2) {
      const far = await this.findLenders(sha256, 2 - candidates.length);
      candidates = [
        ...candidates,
        ...far.filter((f) => !candidates.some((c) => c.peerId === f.peerId)),
      ].slice(0, 2);
    }
    if (candidates.length === 0) return null;

    const answers = (
      await Promise.all(
        candidates.map((p) =>
          this.askPeerToRun(
            p,
            sha256,
            prompt,
            maxTokens,
            // Only when there is a second answer to compare it against.
            candidates.length > 1,
          ),
        ),
      )
    ).filter((a): a is { peerId: string; text: string } => a !== null);

    if (answers.length === 0) return null;
    const asked = answers.map((a) => a.peerId);
    if (answers.length === 1) {
      // Honest label. One peer is not verification, and calling it verified
      // would be the kind of lie that makes a whole system untrustworthy.
      this.logger.log(`borrowed an answer from one peer — not cross-checked`);
      return { text: answers[0]!.text, confidence: "single", askedPeers: asked };
    }

    // Measured on two real machines, three questions, different processors:
    // with both asked to run reproducibly the answers came back IDENTICAL,
    // byte for byte. That was not the expected result — floating point across
    // different CPUs was supposed to make them merely similar — and it changes
    // what a comparison is worth. If honest peers match exactly, then any
    // difference at all is worth knowing about, and calling 0.6 overlap
    // "agreed" would be throwing away the strongest signal there is.
    //
    // So three answers instead of two, because they mean different things:
    //
    //   IDENTICAL — the same text. Both ran the same way and got the same
    //     result, which is as close to verification as this can get.
    //   AGREED — close, not the same. Entirely normal between machines that
    //     are not running the same build, the same quantisation, or the same
    //     kind of processor; a network of identical machines is not a
    //     network. Worth having, weaker than the above, and labelled as such.
    //   DISAGREED — one of them is wrong, broken, or lying, and there is no
    //     way from here to tell which.
    const same = answers[0]!.text.trim() === answers[1]!.text.trim();
    const sim = same ? 1 : PeerService.similarity(answers[0]!.text, answers[1]!.text);
    const confidence = same ? "identical" : sim >= 0.6 ? "agreed" : "disagreed";
    this.logger.log(
      same
        ? `two peers returned the same answer, word for word`
        : confidence === "agreed"
          ? `two peers agreed but not exactly (overlap ${sim.toFixed(2)})`
          : `two peers DISAGREED (overlap ${sim.toFixed(2)}) — treat with suspicion`,
    );
    return {
      text: answers[0]!.text,
      confidence,
      askedPeers: asked,
      similarity: Number(sim.toFixed(3)),
    };
  }


  // --- remembering the network across restarts ----------------------------
  //
  // eMule did not have a server. It had hundreds, run by whoever felt like it,
  // in a list that travelled between users — kill any one of them and nothing
  // happened. The list was the thing that made the network survive its own
  // operators, and it was kept on disk precisely so a client that had been
  // switched off for a week could still find its way back in.
  //
  // Neurion kept its peers in memory only, which meant every restart began from
  // nothing and leaned on whatever happened to be reachable that minute. Now the
  // peers that proved reachable are written down and tried again on the next
  // start, and they travel between machines through gossip. Anybody who runs
  // Neurion with an open port becomes one of the ways in — there is no list of
  // approved ones, and nothing to apply for.
  //
  // A starter list ships with the app so a brand-new install has somewhere to
  // knock. It is a plain file, editable, and losing it costs nothing once the
  // machine has met anyone at all.
  //
  // This list is now the way IN rather than the way things are found: once a
  // machine has met anybody at all, the index in kad.ts takes over and reaches
  // the rest of the network without it. Which is the order eMule ended up in
  // too — a list to get started, Kad for everything after.

  private nodesPath(dir: string): string {
    return join(dir, "known-nodes.json");
  }

  /** Peers worth trying at the next start, newest first, bounded. */
  private rememberNode(address: string, port: number): void {
    const dir = this.dir();
    if (!dir) return;
    try {
      const list = this.savedNodes().filter(
        (n) => !(n.address === address && n.port === port),
      );
      list.unshift({ address, port, lastSeen: Date.now() });
      // 200 is generous for a home network and small enough that the file stays
      // trivial to read and to hand to somebody else.
      writeFileSync(
        this.nodesPath(dir),
        JSON.stringify(list.slice(0, 200), null, 1),
      );
    } catch {
      /* best effort: forgetting the network only costs a slower start */
    }
  }

  savedNodes(): Array<{ address: string; port: number; lastSeen: number }> {
    const dir = this.dir();
    if (!dir) return [];
    try {
      const raw = JSON.parse(readFileSync(this.nodesPath(dir), "utf8"));
      if (!Array.isArray(raw)) return [];
      return raw.filter(
        (n): n is { address: string; port: number; lastSeen: number } =>
          typeof n?.address === "string" && Number.isInteger(n?.port),
      );
    } catch {
      return [];
    }
  }

  /**
   * Knock on everyone we have ever met, plus the list the app shipped with.
   *
   * Runs before the subnet sweep: a machine that already knows the network
   * should not have to rediscover its own neighbourhood from scratch.
   */
  private async askRemembered(): Promise<void> {
    const seen = new Set<string>();
    const targets: Array<[string, number]> = [];
    for (const n of [...this.savedNodes(), ...this.starterNodes()]) {
      const key = `${n.address}:${n.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push([n.address, n.port]);
      if (targets.length >= 60) break;
    }
    await Promise.all(targets.map(([a, p]) => this.ask(a, p)));
  }

  /**
   * The list the app was installed with. One file, meant to be replaced.
   *
   * Deliberately not hard-coded in the source: somebody who distributes their
   * own build, or a community that wants its own entry points, should be able
   * to change it without touching code.
   */
  private starterNodes(): Array<{ address: string; port: number }> {
    const dir = this.dir();
    if (!dir) return [];
    try {
      const raw = JSON.parse(
        readFileSync(join(dir, "starter-nodes.json"), "utf8"),
      );
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((n): n is { address: string; port?: number } =>
          typeof n?.address === "string",
        )
        .map((n) => ({ address: n.address, port: n.port ?? this.sharePort() }));
    } catch {
      return [];
    }
  }

  // --- the distributed index, which is where the last server goes ---------
  //
  // Everything above finds models on machines you already know about: the local
  // segment, the peers you were introduced to, the addresses you kept from last
  // time. That is a neighbourhood, and a neighbourhood only holds what its
  // members happen to hold.
  //
  // The DHT is what turns a neighbourhood into a network. "Who has this model"
  // becomes a question with an answer even when nobody you know has it, and the
  // answer is assembled from a few hops through strangers rather than read out
  // of anybody's database.
  //
  // It rides on the HTTP port that is already open rather than on UDP, which is
  // where Kademlia normally lives. That is a deliberate trade. UDP would be
  // lighter per hop, but it would need a second port opened on the router, a
  // second hole in the firewall for the user to punch, and it would make every
  // address already written down useless as a way in — because those addresses
  // are all this port. A slightly heavier hop on a port that genuinely works
  // beats an elegant one that half the world's routers drop.
  //
  // What crosses the wire is signed in both directions. A reply tells us which
  // node answered, and we believe the signature rather than the body: without
  // that, a machine could answer in a well-placed node's name and quietly take
  // over the part of the index it wants to control.

  private kad(): Kad | null {
    if (this.kadNode) return this.kadNode;
    const id = this.identity();
    if (!id) return null;
    this.kadNode = new Kad(
      id.peerId,
      { send: (to, req) => this.kadSend(to, req) },
      // A node always answers honestly for what it actually has on disk, so a
      // model is findable the moment it lands — without waiting for the next
      // announcement round. Keys are the first half of a model's hash, so the
      // match is by prefix.
      {
        holds: (key) => {
          if ([...this.localHashes().keys()].some((h) => h.startsWith(key))) {
            return true;
          }
          // And for the processor, but only while that offer is actually
          // true right now: lending switched on, and this exact model loaded.
          // Saying yes to anything else would send somebody a request this
          // machine is going to refuse.
          if (!this.computeEnabled() || !this.runningModel) return false;
          return computeKeyFor(this.runningModel) === key;
        },
      },
    );
    return this.kadNode;
  }

  /** Strip the IPv4-in-IPv6 form Node hands back on dual-stack sockets. */
  private static plainAddress(a: string | undefined | null): string | null {
    if (!a) return null;
    const clean = a.startsWith("::ffff:") ? a.slice(7) : a;
    return clean || null;
  }

  /** One DHT request to one node. Null for anything that is not a clean answer. */
  private async kadSend(
    to: Contact,
    req: KadRequest,
  ): Promise<KadResponse | null> {
    const wire = this.signed({
      v: 1,
      peerId: this.peerId,
      port: this.sharePort(),
      req,
    });
    if (!wire) return null;
    try {
      const res = await fetch(`http://${to.address}:${to.port}/peer/kad`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: wire,
        // Short: a lookup is several of these in a row, and a node that is
        // slow to answer is indistinguishable from one that is gone.
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return null;
      // Read with a ceiling rather than reading and then measuring. Every
      // other bound in here protects this machine from what a peer SENDS us;
      // this one was the hole on the side where we ASK, and a hostile answer
      // of a gigabyte would have been held in memory in full before anyone
      // looked at its size.
      const text = await PeerService.readCapped(res, 64_000);
      if (!text) return null;
      const opened = this.opened(text);
      if (!opened) return null;
      const answer = (opened.payload as { res?: unknown }).res as
        | KadResponse
        | undefined;
      if (!answer || typeof answer.t !== "string") return null;
      // The signature says who answered. Whatever the body claims about its own
      // identity is not evidence of anything.
      return { ...answer, id: opened.peerId };
    } catch {
      return null;
    }
  }

  /** Read a response body up to a limit, or nothing at all. */
  private static async readCapped(
    res: Response,
    max: number,
  ): Promise<string | null> {
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > max) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        size += value.length;
        // A chunked reply declares no length, so the count is what stops it.
        if (size > max) {
          await reader.cancel();
          return null;
        }
        chunks.push(Buffer.from(value));
      }
    } catch {
      return null;
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /** Answer somebody else's DHT request. */
  private async answerKad(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const finish = (code: number, body?: string): void => {
      try {
        // The socket may already be gone: an oversized upload is cut off
        // mid-flight, and answering a corpse should not throw.
        if (res.destroyed || res.writableEnded) return;
        res.statusCode = code;
        if (body) res.setHeader("content-type", "application/json");
        res.end(body);
      } catch {
        /* the other end left */
      }
    };
    const kad = this.kad();
    if (!kad) return finish(503);

    // Bounded before a single byte is parsed: an unauthenticated endpoint that
    // reads until the sender stops is a way to fill this machine's memory.
    const chunks: Buffer[] = [];
    let size = 0;
    const body = await new Promise<string | null>((resolve) => {
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 32_000) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", () => resolve(null));
    });
    if (!body) return finish(400);

    const opened = this.opened(body);
    if (!opened) return finish(403); // unsigned, forged, or in a stolen name
    const payload = opened.payload as { req?: KadRequest; port?: unknown };
    if (!payload.req || typeof payload.req.t !== "string") return finish(400);

    const address = PeerService.plainAddress(req.socket.remoteAddress);
    if (!address) return finish(400);
    const port = Number.isInteger(payload.port)
      ? (payload.port as number)
      : this.sharePort();

    // The address is the one we observed. The caller does not get to choose it,
    // which is what stops the index from being aimed at somebody else.
    const answer = kad.handle(payload.req, { id: opened.peerId, address, port });
    const signedAnswer = this.signed({ v: 1, peerId: this.peerId, res: answer });
    if (!signedAnswer) return finish(500);
    finish(200, signedAnswer);
  }

  /**
   * Take a place in the index and say what this machine holds.
   *
   * The self-lookup is the standard way in: ask the network about your own id
   * and the answers fill your routing table with the neighbours you will need.
   * It runs only once somebody is known — there is nothing to ask otherwise.
   */
  private async joinNetwork(): Promise<void> {
    const kad = this.kad();
    if (!kad) return;
    // Every peer discovered by any other means is a way into the index.
    for (const p of this.known()) {
      if (isId(p.peerId)) kad.seen({ id: p.peerId, address: p.address, port: p.port });
    }
    if (kad.size() === 0) return;

    const before = kad.size();
    await kad.lookup(kad.selfId);
    if (!this.kadJoined && kad.size() > 0) {
      this.kadJoined = true;
      this.logger.log(
        `joined the distributed index — ${kad.size()} nodes reachable (from ${before})`,
      );
    }

    // Publishing is sharing. If the user has switched sharing off, this machine
    // stays a reader of the index and never a line in it.
    if (!this.enabled()) return;
    // Every other round, so roughly twenty minutes — comfortably inside the
    // half hour a record lives, and half the traffic of announcing every time.
    // Each announcement is a lookup of its own, and somebody holding a dozen
    // models should not be a dozen walks across the network every ten minutes.
    // Lending is announced EVERY round, unlike weights. A file on a disk is
    // still there in ten minutes; an offer to run something is only as true as
    // the model currently loaded and the switch currently set, so a stale
    // record here costs somebody a refused request rather than a slow one.
    if (this.computeEnabled() && this.runningModel) {
      const ck = computeKeyFor(this.runningModel);
      if (ck) {
        const took = await kad.announce(ck);
        if (took > 0) {
          this.logger.log(
            `offered this machine's processor for ${this.runningModel.slice(0, 12)} to ${took} nodes`,
          );
        }
      }
    }
    this.kadRounds += 1;
    if (this.kadRounds % 2 === 0) return;
    const keys = [...this.localHashes().keys()]
      .slice(0, 20)
      .map((h) => keyFor(h))
      .filter((k): k is string => k !== null);
    let placed = 0;
    for (const key of keys) placed += (await kad.announce(key)) > 0 ? 1 : 0;
    if (placed > 0) {
      this.logger.log(`announced ${placed} of ${keys.length} models to the index`);
    }
  }

  /**
   * Find somewhere to fetch a model from, anywhere in the network.
   *
   * Neighbours first, because a machine on the same network is both faster and
   * one less stranger involved. Only then the index — and whatever it names is
   * checked by asking that machine directly before the answer is believed.
   */
  async locate(sha256: string): Promise<string | null> {
    const near = this.sourceFor(sha256);
    if (near) return near;
    const kad = this.kad();
    const key = keyFor(sha256);
    if (!kad || !key) return null;
    // A deadline, because this sits in front of a download. A lookup is
    // several requests deep and each hop may be a machine that has gone to
    // sleep; without a ceiling, somebody with two slow peers would wait a
    // minute before the publisher was even tried. Fifteen seconds is long
    // enough for a healthy walk and short enough that a bad one is not felt.
    let providers: Awaited<ReturnType<Kad["findProviders"]>>;
    try {
      providers = await Promise.race([
        kad.findProviders(key, 4),
        new Promise<[]>((resolve) => setTimeout(() => resolve([]), 15_000)),
      ]);
    } catch {
      return null;
    }
    for (const p of providers) {
      try {
        const url = `http://${p.address}:${p.port}/peer/blob/${sha256}`;
        const r = await fetch(url, {
          method: "HEAD",
          signal: AbortSignal.timeout(3000),
        });
        if (!r.ok) continue;
        this.logger.log(
          `the index found ${sha256.slice(0, 12)} on ${p.address}, a machine this one had not met`,
        );
        // Now that it has answered for itself it is a real peer, worth
        // remembering and worth routing through.
        this.remember(p.address, p.port, p.id, [sha256]);
        this.rememberNode(p.address, p.port);
        kad.seen({ id: p.id, address: p.address, port: p.port });
        return url;
      } catch {
        /* named by the index, not actually reachable — try the next one */
      }
    }
    return null;
  }

  /**
   * Find machines anywhere that will run this model, and check that they will.
   *
   * The index record is a CLAIM, and a stale or hostile one is cheap to make:
   * an offer to lend a processor stops being true the moment somebody loads a
   * different model or flips the switch off. So nothing here is taken on the
   * index's word — each candidate is asked directly, and only a machine that
   * says, right now, that it lends and has this exact model loaded is used.
   *
   * That check is also what makes the reciprocity ledger possible for
   * strangers: it returns a verified peer id, and you cannot remember who
   * helped you if you never established who they were.
   */
  private async findLenders(sha256: string, want: number): Promise<KnownPeer[]> {
    const kad = this.kad();
    const key = computeKeyFor(sha256);
    if (!kad || !key || want <= 0) return [];
    let claimed;
    try {
      claimed = await Promise.race([
        kad.findProviders(key, Math.max(want * 2, 4)),
        new Promise<[]>((resolve) => setTimeout(() => resolve([]), 12_000)),
      ]);
    } catch {
      return [];
    }
    const out: KnownPeer[] = [];
    for (const c of claimed) {
      if (out.length >= want) break;
      if (c.id === this.peerId) continue;
      try {
        const res = await fetch(`http://${c.address}:${c.port}/peer/have`, {
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as {
          v?: number;
          peerId?: string;
          compute?: unknown;
          running?: unknown;
          has?: unknown;
        };
        // Three things have to hold, and the index proves none of them: it is
        // who it was said to be, it lends, and it has THIS model loaded.
        if (body.v !== 1 || body.peerId !== c.id) continue;
        if (body.compute !== true || body.running !== sha256) continue;
        const has = Array.isArray(body.has)
          ? body.has.filter(
              (h): h is string =>
                typeof h === "string" && /^[0-9a-f]{64}$/.test(h),
            )
          : [];
        this.remember(c.address, c.port, c.id, has, {
          compute: true,
          running: sha256,
        });
        this.rememberNode(c.address, c.port);
        const known = this.peers.get(c.id);
        if (known) out.push(known);
      } catch {
        /* named by the index, not reachable — the next one, then */
      }
    }
    if (out.length > 0) {
      this.logger.log(
        `the index found ${out.length} machine(s) willing to run ${sha256.slice(0, 12)}`,
      );
    }
    return out;
  }

  /** What this machine is doing in the index, for the interface to show. */
  indexStatus(): { nodes: number; records: number; joined: boolean } {
    const kad = this.kadNode;
    return {
      nodes: kad?.size() ?? 0,
      records: kad?.stored() ?? 0,
      joined: this.kadJoined,
    };
  }

  /** This machine's name on the network — the fingerprint of its public key. */
  myPeerId(): string {
    return this.peerId;
  }

  /** Peers seen recently, newest first. */
  known(): KnownPeer[] {
    this.forget();
    return [...this.peers.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** Somewhere to fetch this hash from, or null if nobody nearby has it. */
  sourceFor(sha256: string): string | null {
    const peer = this.known().find((p) => p.has.includes(sha256));
    return peer ? `http://${peer.address}:${peer.port}/peer/blob/${sha256}` : null;
  }

  status(): {
    enabled: boolean;
    sharing: number;
    peers: number;
    offeredByPeers: number;
    served: number;
    compute: boolean;
    computed: number;
  } {
    const mine = this.localHashes();
    const theirs = new Set<string>();
    for (const p of this.known()) for (const h of p.has) theirs.add(h);
    return {
      enabled: this.enabled() && this.http != null,
      sharing: mine.size,
      peers: this.peers.size,
      offeredByPeers: theirs.size,
      served: this.served,
      compute: this.computeEnabled(),
      computed: this.computed,
    };
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.mapTimer) clearInterval(this.mapTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    // One handle, used first as a delay and then as the repeat; clearing it
    // either way is correct because both are the same kind of timer.
    if (this.kadTimer) {
      clearTimeout(this.kadTimer);
      clearInterval(this.kadTimer);
    }
    try {
      this.sock?.close();
    } catch {
      /* already closed */
    }
    try {
      this.http?.close();
    } catch {
      /* already closed */
    }
  }
}
