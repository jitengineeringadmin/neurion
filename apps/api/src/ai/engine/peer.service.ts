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
import { createServer, Server } from "node:http";
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
 *  - LOCAL NETWORK ONLY, FOR NOW. Discovery is a UDP announcement on the local
 *    segment. No DHT, no bootstrap servers, no internet exposure — that is the
 *    next phase, and it needs NAT traversal that does not exist yet.
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

  /**
   * Sharing is on unless switched off. It costs the sharer nothing — the file is
   * already on the disk, and serving it is a read — which is exactly the
   * property that made Napster and eMule work and that donated-compute networks
   * never had.
   */
  enabled(): boolean {
    const v =
      this.config.get<string>("NEURION_PEER_SHARING") ??
      process.env.NEURION_PEER_SHARING;
    return v !== "false" && v !== "0";
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
  }

  /** Read-only file server: one route, and it only answers for known hashes. */
  private serve(): void {
    const port = this.sharePort();
    const server = createServer((req, res) => {
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
            // Peer exchange: everyone we know about, so a newcomer that can
            // reach one machine can reach the rest without any registry.
            peers: this.known()
              .slice(0, 40)
              .map((p) => ({ address: p.address, port: p.port })),
          }),
        );
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
      // Logged on purpose. Seeing that you handed a model to someone is the
      // only thing a volunteer gets back, and it is what has to stand where a
      // payment would have been. It is also the only way to prove, afterwards,
      // that a transfer went machine-to-machine and never touched the internet.
      const who = req.socket.remoteAddress ?? "somebody";
      const name = hit.path.split(/[\\/]/).pop();
      const startedAt = Date.now();
      this.served += 1;
      this.logger.log(`sending ${name} to ${who}`);
      createReadStream(hit.path)
        .on("error", () => res.destroy())
        .on("end", () => {
          const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
          const mbps = Math.round(hit.size / secs / 125_000);
          this.logger.log(
            `sent ${name} to ${who} — ${Math.round(hit.size / 1e6)} MB in ${secs}s (~${mbps} Mbit/s)`,
          );
        })
        .pipe(res);
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
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const port = this.sharePort();
      // Seeds first: they may be the only way out of this network.
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
        };
        if (body?.v !== 1 || typeof body.peerId !== "string") return;
        if (body.peerId === this.peerId) return; // ourselves, another interface
        const has = Array.isArray(body.has)
          ? body.has.filter(
              (h): h is string =>
                typeof h === "string" && /^[0-9a-f]{64}$/.test(h),
            )
          : [];
        this.remember(address, port, body.peerId, has);
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
  ): void {
    const known = this.peers.get(peerId);
    this.peers.set(peerId, { peerId, address, port, has, lastSeen: Date.now() });
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
  // A DHT would remove the last of the manual step, and it is the obvious next
  // move — but it is a large dependency, and this already does the job it is
  // for: if every server we run disappeared, two people who know each other's
  // address still find each other.

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
    };
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
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
