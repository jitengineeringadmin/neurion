import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, Server } from "node:http";
import { join } from "node:path";
import { createSocket, Socket } from "node:dgram";
import { randomUUID } from "node:crypto";
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
  private readonly peerId = randomUUID();
  private readonly peers = new Map<string, KnownPeer>();
  private sock: Socket | null = null;
  private http: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private started = false;

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
      createReadStream(hit.path)
        .on("error", () => res.destroy())
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
    });
    this.sock = sock;
  }

  private announce(): void {
    if (!this.sock) return;
    const has = [...this.localHashes().keys()];
    const msg: Announcement = {
      v: 1,
      peerId: this.peerId,
      port: this.sharePort(),
      has,
    };
    const buf = Buffer.from(JSON.stringify(msg));
    try {
      this.sock.send(buf, 0, buf.length, DISCOVERY_PORT, GROUP);
    } catch {
      /* the network came and went */
    }
    this.forget();
  }

  private onAnnounce(buf: Buffer, address: string): void {
    let msg: Announcement;
    try {
      // Anything can be sent to a UDP port. Nothing here is trusted; the worst a
      // malformed or hostile announcement can do is be ignored, and the worst a
      // lying one can do is offer a file that fails its hash on arrival.
      msg = JSON.parse(buf.toString("utf8")) as Announcement;
    } catch {
      return;
    }
    if (msg?.v !== 1 || typeof msg.peerId !== "string") return;
    if (msg.peerId === this.peerId) return; // our own announcement, echoed back
    if (!Array.isArray(msg.has) || !Number.isInteger(msg.port)) return;
    const has = msg.has.filter(
      (h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h),
    );
    this.peers.set(msg.peerId, {
      peerId: msg.peerId,
      address,
      port: msg.port,
      has,
      lastSeen: Date.now(),
    });
  }

  private forget(): void {
    const cutoff = Date.now() - PEER_TTL_MS;
    for (const [id, p] of this.peers) {
      if (p.lastSeen < cutoff) this.peers.delete(id);
    }
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
  } {
    const mine = this.localHashes();
    const theirs = new Set<string>();
    for (const p of this.known()) for (const h of p.has) theirs.add(h);
    return {
      enabled: this.enabled() && this.http != null,
      sharing: mine.size,
      peers: this.peers.size,
      offeredByPeers: theirs.size,
    };
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
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
