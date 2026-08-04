/**
 * A distributed hash table, so a model can be found without asking anybody in
 * particular.
 *
 * This is the piece eMule got last and needed most. Before Kad it had servers:
 * hundreds of them, run by volunteers, which is far better than one — but a
 * server was still a thing that had to exist, be maintained, and could be
 * pressured. Kad removed them. The index stopped living anywhere and started
 * living in the space between everyone.
 *
 * Neurion already had the "many servers" part: peers are remembered on disk and
 * their addresses travel between machines. What it did not have is this — and
 * the difference is not bootstrapping, it is REACH. Until now, finding a model
 * meant asking the machines you happen to know, so you could only ever find
 * what your own neighbourhood held. With a DHT you find the model on a machine
 * you have never met, in about log(n) hops, and nothing in the middle had to
 * be a server.
 *
 * What is stored is deliberately tiny: "peer P has model with hash H". Never
 * the weights, never a prompt, never anything a user wrote. The value of a key
 * is a short list of addresses, it expires by itself, and nothing about it is
 * worth lying about — because the hash still decides whether a download is
 * genuine, so a poisoned index costs the asker one wasted connection.
 *
 * Design notes that are security decisions rather than taste:
 *
 *  - THE NODE ID IS THE FINGERPRINT OF THE PUBLIC KEY. It is not chosen. To sit
 *    next to a particular key in the space — the position from which you could
 *    censor a lookup — you would have to grind keypairs until one hashes where
 *    you want it. That is the cheapest sybil defence that costs honest users
 *    nothing.
 *  - ONLY NODES THAT ANSWERED US ENTER THE ROUTING TABLE. A peer can name any
 *    contacts it likes in a reply; they are candidates to be probed, never
 *    entries. Without this rule one machine could fill everyone's routing table
 *    with addresses of its choosing, which is how you eclipse a network.
 *  - A FULL BUCKET KEEPS THE OLD NODE. Long-lived nodes are the ones that have
 *    proven they stay, and preferring them is what stops a flood of fresh
 *    identities from displacing a working table.
 *  - AN ANNOUNCER'S ADDRESS IS OBSERVED, NOT CLAIMED. Otherwise the index would
 *    happily point a crowd at any address an attacker typed, and a lookup
 *    service that can be aimed is a weapon.
 *  - EVERYTHING IS BOUNDED. Providers per key, keys in total, contacts in a
 *    reply, hops in a lookup. Every one of those is a place where "as many as
 *    they send" would mean somebody else decides how much memory we use.
 *
 * The one honest cost, which the interface should say out loud: announcing that
 * you hold a model publishes your address and that fact to anyone who asks for
 * that key. That is inherent — it is how BitTorrent works too — and it is why
 * announcing is tied to the sharing switch and never covers models the user
 * pointed at on their own disk.
 *
 * Transport is injected. This file knows nothing about HTTP or UDP, which is
 * what lets sixty of these run in one test process and answer each other.
 */

import { createHash } from "node:crypto";

/** A node in the network: who, where. */
export interface Contact {
  id: string;
  address: string;
  port: number;
}

/** Somebody who says they hold a particular model. */
export interface Provider {
  id: string;
  address: string;
  port: number;
  /**
   * Set when this peer cannot be reached directly and answers through another
   * one. The address is then the RELAY's, and this is the peer being relayed
   * for — the arrangement eMule called a LowID, and the reason half the world
   * could still take part from behind a router that opened nothing.
   *
   * A peer naming a relay it has no arrangement with achieves nothing: the
   * relay refuses a name it has not registered, so the record is a dead end
   * rather than a way to aim traffic at somebody.
   */
  via?: string;
}

export type KadRequest =
  | { t: "ping" }
  | { t: "find_node"; target: string }
  | { t: "find_value"; key: string }
  | { t: "announce"; key: string };

export type KadResponse =
  | { t: "pong"; id: string }
  | { t: "contacts"; id: string; contacts: Contact[] }
  | { t: "providers"; id: string; providers: Provider[] }
  | { t: "stored"; id: string; ok: boolean };

/** How the messages actually travel. Null means the node did not answer. */
export interface KadTransport {
  send(to: Contact, req: KadRequest): Promise<KadResponse | null>;
}

/** Contacts per bucket. Eight is Kademlia's number and there is no reason to differ. */
export const K = 8;
/** Lookups in flight at once. Three, likewise. */
export const ALPHA = 3;
/** Ids are the 128-bit fingerprints the rest of the app already uses. */
const ID_HEX = 32;
const ID_BITS = ID_HEX * 4;

const MAX_PROVIDERS_PER_KEY = 64;
const MAX_KEYS = 4096;
/** A provider record dies on its own; nothing has to clean up after a peer that vanished. */
const PROVIDER_TTL_MS = 30 * 60_000;
/** A bucket entry older than this may be pushed out by a newcomer. */
const STALE_MS = 15 * 60_000;
/** Hard stops, so a lookup always ends even against a network built to trap it. */
const MAX_ROUNDS = 12;
const MAX_QUERIES = 60;

export function isId(x: unknown): x is string {
  return typeof x === "string" && new RegExp(`^[0-9a-f]{${ID_HEX}}$`).test(x);
}

/**
 * Turn a model's sha256 into a key in this space.
 *
 * Node ids are the 128-bit fingerprints the app already uses, and a key has to
 * live in the same space as the ids or "closest node to this key" means
 * nothing. Model hashes are 256-bit, so the first half is taken.
 *
 * Losing half the bits sounds alarming and is not: this key only decides WHERE
 * an "X has Y" note is filed. Whether a download is genuine is still settled by
 * the full sha256 when the bytes arrive, so the worst a collision could do —
 * and at 128 bits it will not happen — is send somebody one wasted request.
 */
export function keyFor(sha256: string): string | null {
  const k = sha256.trim().toLowerCase().slice(0, ID_HEX);
  return isId(k) ? k : null;
}

/**
 * The key under which "I will RUN this model for you" is filed.
 *
 * Deliberately a different place in the space from the weights of the same
 * model. Holding a file and lending a processor are different offers with
 * different costs, and somebody looking for one must not be handed the other:
 * a machine that will happily pass you 900 MB may have no intention of running
 * your prompt, and answering as if it had would waste both their time.
 *
 * Hashed rather than perturbed by hand so the two keys land nowhere near each
 * other, which means the two kinds of record are kept by different nodes and a
 * busy key does not drag its twin along with it.
 */
export function computeKeyFor(sha256: string): string | null {
  const base = keyFor(sha256);
  if (!base) return null;
  return createHash("sha256")
    .update(`compute:${sha256.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, ID_HEX);
}

function bytes(id: string): Uint8Array {
  const out = new Uint8Array(ID_HEX / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(id.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * How far apart two ids are: XOR, read as one big number.
 *
 * XOR is what makes Kademlia work — distance is symmetric, so a node learns
 * about the neighbours it is useful to know simply by being asked.
 */
export function distance(a: string, b: string): Uint8Array {
  const x = bytes(a);
  const y = bytes(b);
  const out = new Uint8Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i]! ^ y[i]!;
  return out;
}

function compareDistance(target: string, a: string, b: string): number {
  const da = distance(target, a);
  const db = distance(target, b);
  for (let i = 0; i < da.length; i++) {
    if (da[i] !== db[i]) return da[i]! - db[i]!;
  }
  return 0;
}

/** Which bucket a node belongs in: how many leading bits it shares with us. */
function bucketIndex(self: string, other: string): number {
  const d = distance(self, other);
  for (let i = 0; i < d.length; i++) {
    const byte = d[i]!;
    if (byte === 0) continue;
    let bit = 0;
    for (let m = 0x80; m > 0; m >>= 1, bit++) {
      if (byte & m) return i * 8 + bit;
    }
  }
  return -1; // identical to us
}

interface Entry extends Contact {
  lastSeen: number;
}

export interface KadOptions {
  /** Say whether this machine itself holds a key, so it can answer for itself. */
  holds?: (key: string) => boolean;
  /** Overridable for tests that need records to expire in milliseconds. */
  providerTtlMs?: number;
}

export class Kad {
  private readonly buckets: Entry[][] = Array.from(
    { length: ID_BITS },
    () => [],
  );
  private readonly store = new Map<
    string,
    Map<string, Provider & { expires: number }>
  >();
  private readonly ttl: number;

  constructor(
    readonly selfId: string,
    private readonly transport: KadTransport,
    private readonly opts: KadOptions = {},
  ) {
    if (!isId(selfId)) throw new Error(`not a node id: ${selfId}`);
    this.ttl = opts.providerTtlMs ?? PROVIDER_TTL_MS;
  }

  // --- the routing table ---------------------------------------------------

  /**
   * Record a node we have heard from OURSELVES.
   *
   * Never call this for a contact somebody merely told us about. That
   * distinction is the whole defence against a peer choosing what our routing
   * table contains.
   */
  seen(c: Contact): void {
    if (!isId(c.id) || c.id === this.selfId) return;
    if (!c.address || !Number.isInteger(c.port) || c.port <= 0) return;
    const idx = bucketIndex(this.selfId, c.id);
    if (idx < 0) return;
    const bucket = this.buckets[idx]!;
    const at = bucket.findIndex((e) => e.id === c.id);
    if (at >= 0) {
      // Known and still alive: refresh it and move it to the back, so the
      // front of the bucket is always the least recently heard from.
      bucket.splice(at, 1);
      bucket.push({ ...c, lastSeen: Date.now() });
      return;
    }
    if (bucket.length < K) {
      bucket.push({ ...c, lastSeen: Date.now() });
      return;
    }
    // Full. The oldest entry only loses its place if it has gone quiet for a
    // long time; a node that is still around outranks a stranger.
    const oldest = bucket[0]!;
    if (Date.now() - oldest.lastSeen > STALE_MS) {
      bucket.shift();
      bucket.push({ ...c, lastSeen: Date.now() });
    }
  }

  /** The nodes we know that sit closest to a target. */
  closest(target: string, n: number = K): Contact[] {
    const all: Entry[] = [];
    for (const b of this.buckets) all.push(...b);
    all.sort((a, b) => compareDistance(target, a.id, b.id));
    return all.slice(0, n).map(({ id, address, port }) => ({ id, address, port }));
  }

  size(): number {
    let n = 0;
    for (const b of this.buckets) n += b.length;
    return n;
  }

  // --- answering other people ---------------------------------------------

  /**
   * Handle a request from a peer whose identity has ALREADY been proven by the
   * layer above, and whose address we observed rather than were told.
   */
  handle(req: KadRequest, from: Contact): KadResponse {
    this.seen(from);
    switch (req.t) {
      case "ping":
        return { t: "pong", id: this.selfId };
      case "find_node":
        return {
          t: "contacts",
          id: this.selfId,
          contacts: isId(req.target) ? this.closest(req.target) : [],
        };
      case "find_value": {
        if (!isId(req.key)) {
          return { t: "contacts", id: this.selfId, contacts: [] };
        }
        const providers = this.providersFor(req.key);
        if (providers.length > 0) {
          return { t: "providers", id: this.selfId, providers };
        }
        return { t: "contacts", id: this.selfId, contacts: this.closest(req.key) };
      }
      case "announce": {
        if (!isId(req.key)) return { t: "stored", id: this.selfId, ok: false };
        const ok = this.storeProvider(req.key, from);
        return { t: "stored", id: this.selfId, ok };
      }
      default:
        return { t: "pong", id: this.selfId };
    }
  }

  /**
   * Who we believe holds this key.
   *
   * If this machine holds it too, it says so with an empty address: the asker
   * knows perfectly well what address it dialled, and it is the only one that
   * can know what our address looks like from outside a router.
   */
  providersFor(key: string): Provider[] {
    const out: Provider[] = [];
    if (this.opts.holds?.(key)) {
      out.push({ id: this.selfId, address: "", port: 0 });
    }
    const rows = this.store.get(key);
    if (rows) {
      const now = Date.now();
      for (const [id, row] of rows) {
        if (row.expires <= now) {
          rows.delete(id);
          continue;
        }
        out.push({ id: row.id, address: row.address, port: row.port });
      }
      if (rows.size === 0) this.store.delete(key);
    }
    return out.slice(0, MAX_PROVIDERS_PER_KEY);
  }

  private storeProvider(key: string, who: Contact): boolean {
    this.prune();
    let rows = this.store.get(key);
    if (!rows) {
      if (this.store.size >= MAX_KEYS) return false; // bounded, and honest about it
      rows = new Map();
      this.store.set(key, rows);
    }
    if (!rows.has(who.id) && rows.size >= MAX_PROVIDERS_PER_KEY) return false;
    rows.set(who.id, {
      id: who.id,
      address: who.address,
      port: who.port,
      expires: Date.now() + this.ttl,
    });
    return true;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, rows] of this.store) {
      for (const [id, row] of rows) if (row.expires <= now) rows.delete(id);
      if (rows.size === 0) this.store.delete(key);
    }
  }

  /** How many provider records this node is holding for others. */
  stored(): number {
    this.prune();
    let n = 0;
    for (const rows of this.store.values()) n += rows.size;
    return n;
  }

  // --- asking everybody else ----------------------------------------------

  /**
   * Walk towards a target, getting closer every round.
   *
   * The mechanism, in one sentence: ask the closest nodes you know for the
   * closest nodes THEY know, and repeat until nobody can improve on what you
   * have. That is how a machine reaches a corner of the network it has never
   * seen without any index existing anywhere.
   */
  async lookup(target: string): Promise<Contact[]> {
    const found = await this.walk(target, "find_node", 0);
    return found.contacts;
  }

  /**
   * Find machines that hold a model, wherever they are.
   *
   * Stops as soon as enough providers have been collected — a lookup that keeps
   * going after it has the answer is just noise on somebody else's network.
   */
  async findProviders(key: string, want = 4): Promise<Provider[]> {
    const mine = this.providersFor(key).filter((p) => p.address !== "");
    if (mine.length >= want) return mine.slice(0, want);
    const found = await this.walk(key, "find_value", want - mine.length);
    const seen = new Set(mine.map((p) => p.id));
    const out = [...mine];
    for (const p of found.providers) {
      if (seen.has(p.id) || p.id === this.selfId) continue;
      seen.add(p.id);
      out.push(p);
    }
    return out.slice(0, want);
  }

  /**
   * Tell the network this machine holds a model.
   *
   * Sent to the nodes closest to the key, because that is where anybody looking
   * for it will arrive. Returns how many accepted it — zero is not an error, it
   * means we have not met enough of the network yet.
   */
  async announce(key: string): Promise<number> {
    if (!isId(key)) return 0;
    const targets = await this.lookup(key);
    const acks = await Promise.all(
      targets.slice(0, K).map(async (c) => {
        const res = await this.transport.send(c, { t: "announce", key });
        if (res && res.t === "stored" && res.id === c.id) {
          this.seen(c);
          return res.ok ? 1 : 0;
        }
        return 0;
      }),
    );
    return acks.reduce<number>((a, b) => a + b, 0);
  }

  /**
   * The iterative walk, shared by both kinds of lookup.
   *
   * `wantProviders` of zero means "just find nodes"; anything else stops the
   * walk once that many providers have been gathered.
   */
  private async walk(
    target: string,
    kind: "find_node" | "find_value",
    wantProviders: number,
  ): Promise<{ contacts: Contact[]; providers: Provider[] }> {
    const shortlist = new Map<string, Contact>();
    for (const c of this.closest(target, K)) shortlist.set(c.id, c);
    const queried = new Set<string>([this.selfId]);
    const providers = new Map<string, Provider>();
    let queries = 0;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const batch = [...shortlist.values()]
        .filter((c) => !queried.has(c.id))
        .sort((a, b) => compareDistance(target, a.id, b.id))
        .slice(0, ALPHA);
      if (batch.length === 0) break;
      if (queries + batch.length > MAX_QUERIES) break;
      queries += batch.length;

      const replies = await Promise.all(
        batch.map(async (c) => {
          queried.add(c.id);
          const req: KadRequest =
            kind === "find_node"
              ? { t: "find_node", target }
              : { t: "find_value", key: target };
          const res = await this.transport.send(c, req);
          return { c, res };
        }),
      );

      let improved = false;
      for (const { c, res } of replies) {
        if (!res) {
          // It did not answer. Drop it from consideration; the bucket entry
          // ages out on its own rather than being removed on one timeout,
          // because a single lost packet is not proof a node is gone.
          shortlist.delete(c.id);
          continue;
        }
        // The reply is signed by whoever we dialled, so this node has proven
        // itself and may enter the routing table.
        if (res.id !== c.id) continue; // answered in somebody else's name
        this.seen(c);

        if (res.t === "providers") {
          for (const p of res.providers.slice(0, MAX_PROVIDERS_PER_KEY)) {
            if (!isId(p.id)) continue;
            // "" means the answering node holds it itself; we know its address
            // because we just contacted it.
            const address = p.address === "" ? c.address : p.address;
            const port = p.address === "" ? c.port : p.port;
            if (!address || !Number.isInteger(port) || port <= 0) continue;
            if (p.id === this.selfId) continue;
            if (!providers.has(p.id)) providers.set(p.id, { id: p.id, address, port });
          }
        } else if (res.t === "contacts") {
          for (const n of res.contacts.slice(0, K)) {
            if (!isId(n.id) || n.id === this.selfId) continue;
            if (typeof n.address !== "string" || !n.address) continue;
            if (!Number.isInteger(n.port) || n.port <= 0) continue;
            if (shortlist.has(n.id) || queried.has(n.id)) continue;
            // A candidate only. It gets into the routing table if and when it
            // answers us in a later round.
            shortlist.set(n.id, { id: n.id, address: n.address, port: n.port });
            improved = true;
          }
        }
      }

      if (wantProviders > 0 && providers.size >= wantProviders) break;
      // Keep the shortlist to the K best, or a walk across a large network
      // turns into a walk across all of it.
      if (shortlist.size > K * 2) {
        const trimmed = [...shortlist.values()]
          .sort((a, b) => compareDistance(target, a.id, b.id))
          .slice(0, K * 2);
        shortlist.clear();
        for (const c of trimmed) shortlist.set(c.id, c);
      }
      if (!improved && batch.length < ALPHA) break;
    }

    return {
      contacts: [...shortlist.values()]
        .filter((c) => queried.has(c.id))
        .sort((a, b) => compareDistance(target, a.id, b.id))
        .slice(0, K),
      providers: [...providers.values()],
    };
  }
}
