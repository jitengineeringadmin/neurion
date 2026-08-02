/**
 * Sixty machines that have never met, in one process.
 *
 * The claim a DHT makes is a big one — "you can find a model on a machine you
 * have never heard of, without any index existing anywhere" — so it is tested
 * as a claim, not as a set of functions. The headline case is deliberately the
 * meanest version of it: a brand-new node that knows exactly ONE address must
 * end up talking to a node it was never told about, holding a model it was
 * never told existed.
 *
 * The rest is mostly about what the network must REFUSE. A routing table is the
 * one part of a peer-to-peer system where believing what you are told is fatal:
 * fill somebody's table with addresses you control and you decide what they can
 * find. So there are tests for a peer that invents contacts, a peer that
 * answers in another peer's name, a peer that announces on behalf of a victim's
 * address, and a network built specifically to keep a lookup walking forever.
 */
import { createHash } from "node:crypto";
import {
  Kad,
  K,
  isId,
  keyFor,
  computeKeyFor,
  distance,
  type Contact,
  type KadRequest,
  type KadResponse,
  type KadTransport,
} from "../src/ai/engine/kad";

let passed = 0;
let failed = 0;
function ok(name: string): void {
  passed += 1;
  console.log(`  ok   ${name}`);
}
function bad(name: string, err: unknown): void {
  failed += 1;
  console.log(`  FAIL ${name}`);
  console.log(`       ${(err as Error)?.message ?? String(err)}`);
}
async function check(name: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    ok(name);
  } catch (e) {
    bad(name, e);
  }
}
function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error(message);
}

const idOf = (seed: string): string =>
  createHash("sha256").update(seed).digest("hex").slice(0, 32);

/**
 * A network in memory. Every node is a real Kad with a real routing table; the
 * only thing faked is the wire, which is what lets sixty of them talk in a test
 * that finishes in milliseconds.
 */
class Net implements KadTransport {
  readonly nodes = new Map<string, { kad: Kad; contact: Contact }>();
  queries = 0;
  /** Addresses that answer nothing, to model a peer that has gone away. */
  readonly dead = new Set<string>();
  /** Nodes whose replies are hostile, keyed by address:port. */
  readonly liars = new Map<
    string,
    (req: KadRequest, from: Contact) => KadResponse | null
  >();

  private key(c: { address: string; port: number }): string {
    return `${c.address}:${c.port}`;
  }

  add(seed: string, opts: { holds?: (k: string) => boolean } = {}): {
    kad: Kad;
    contact: Contact;
  } {
    const id = idOf(seed);
    const n = this.nodes.size + 1;
    const contact: Contact = {
      id,
      address: `10.0.${Math.floor(n / 250)}.${(n % 250) + 1}`,
      port: 8097,
    };
    const kad = new Kad(id, this, { holds: opts.holds });
    const entry = { kad, contact };
    this.nodes.set(this.key(contact), entry);
    return entry;
  }

  /** Every send is made on behalf of somebody; the receiver observes who. */
  from: Contact | null = null;

  async send(to: Contact, req: KadRequest): Promise<KadResponse | null> {
    this.queries += 1;
    await Promise.resolve();
    const k = this.key(to);
    if (this.dead.has(k)) return null;
    const liar = this.liars.get(k);
    const sender = this.from;
    if (!sender) throw new Error("test bug: no sender set");
    if (liar) return liar(req, sender);
    const node = this.nodes.get(k);
    if (!node) return null;
    // The receiver is handed the address it OBSERVED, never one the caller
    // claimed — the same rule the HTTP layer enforces in the real thing.
    return node.kad.handle(req, { ...sender, address: sender.address });
  }

  /** Run something as a particular node, so `send` knows who is calling. */
  async as<T>(who: Contact, fn: () => Promise<T>): Promise<T> {
    const before = this.from;
    this.from = who;
    try {
      return await fn();
    } finally {
      this.from = before;
    }
  }
}

async function main(): Promise<void> {
  console.log("\nkad — finding a model on a machine you have never met\n");

  // --- the arithmetic underneath ------------------------------------------

  await check("distance is symmetric, and zero to oneself", () => {
    const a = idOf("a");
    const b = idOf("b");
    const ab = Buffer.from(distance(a, b)).toString("hex");
    const ba = Buffer.from(distance(b, a)).toString("hex");
    assert(ab === ba, "XOR distance should not depend on direction");
    assert(
      Buffer.from(distance(a, a)).every((x) => x === 0),
      "a node should be at distance zero from itself",
    );
  });

  await check("only real node ids are accepted", () => {
    assert(isId(idOf("x")), "a fingerprint should be a valid id");
    assert(!isId("nope"), "short strings are not ids");
    assert(!isId(idOf("x").toUpperCase()), "ids are lower-case hex");
    assert(!isId(idOf("x") + "0"), "over-long strings are not ids");
    assert(!isId(null), "null is not an id");
  });

  await check("lending and holding are filed in different places", () => {
    const sha = createHash("sha256").update("un modello").digest("hex");
    const weights = keyFor(sha);
    const processor = computeKeyFor(sha);
    assert(weights && processor, "both keys should exist for a real hash");
    assert(isId(weights!) && isId(processor!), "both must live in the id space");
    assert(
      weights !== processor,
      "holding a file and lending a processor must not share a key",
    );
    // Far apart, not adjacent: different nodes keep them, so a popular model's
    // weight record does not drag its compute record along with it.
    const d = distance(weights!, processor!);
    assert(d[0] !== 0 || d[1] !== 0, "the two keys landed in the same corner");
    assert(computeKeyFor("not a hash") === null, "junk should not make a key");
  });

  // --- the routing table, which is where trust is decided -----------------

  await check("a node never records itself", () => {
    const net = new Net();
    const me = net.add("self");
    me.kad.seen(me.contact);
    assert(me.kad.size() === 0, "a node should not be its own neighbour");
  });

  await check("a full bucket keeps the node that has proven it stays", () => {
    const net = new Net();
    const me = net.add("keeper");
    // Fill one bucket: ids sharing a prefix with us land together. Simplest way
    // to guarantee a collision is to add many and watch a bucket saturate.
    const made: Contact[] = [];
    for (let i = 0; i < 400; i++) {
      const c = { id: idOf(`fill-${i}`), address: `10.9.0.${i % 250}`, port: 8097 };
      made.push(c);
      me.kad.seen(c);
    }
    // With K per bucket and 128 buckets, a table can never hold everything;
    // what matters is that adding more never displaces live entries.
    const before = me.kad.closest(me.contact.id, K).map((c) => c.id);
    for (let i = 0; i < 400; i++) {
      me.kad.seen({ id: idOf(`flood-${i}`), address: `10.8.0.${i % 250}`, port: 8097 });
    }
    const after = me.kad.closest(me.contact.id, K).map((c) => c.id);
    assert(
      before.every((id) => after.includes(id)),
      "a flood of new identities displaced nodes that were still alive",
    );
  });

  await check("a contact with no address or a nonsense id is not recorded", () => {
    const net = new Net();
    const me = net.add("picky");
    me.kad.seen({ id: "not-an-id", address: "10.0.0.9", port: 8097 });
    me.kad.seen({ id: idOf("ok"), address: "", port: 8097 });
    me.kad.seen({ id: idOf("ok"), address: "10.0.0.9", port: 0 });
    assert(me.kad.size() === 0, "junk contacts entered the routing table");
  });

  // --- the network as a whole ---------------------------------------------

  /** Build a network where everybody bootstraps from one node, as in real life. */
  async function bootstrapped(
    count: number,
    holds: Map<string, string[]> = new Map(),
  ): Promise<{ net: Net; all: Array<{ kad: Kad; contact: Contact }> }> {
    const net = new Net();
    const all = [];
    for (let i = 0; i < count; i++) {
      const seed = `node-${i}`;
      const mine = holds.get(seed) ?? [];
      all.push(net.add(seed, { holds: (k) => mine.includes(k) }));
    }
    const first = all[0]!;
    // Two rounds of self-lookup, which is exactly what a real client does on
    // start: know one address, then ask the network about yourself.
    for (const round of [0, 1]) {
      for (const n of all) {
        if (n === first) continue;
        if (round === 0) n.kad.seen(first.contact);
        await net.as(n.contact, () => n.kad.lookup(n.contact.id));
      }
    }
    return { net, all };
  }

  await check("sixty nodes that started from one address know the network", async () => {
    const { net, all } = await bootstrapped(60);
    const seeker = all[41]!;
    const target = all[7]!;
    const found = await net.as(seeker.contact, () =>
      seeker.kad.lookup(target.contact.id),
    );
    assert(
      found.some((c) => c.id === target.contact.id),
      "a lookup for a node that exists did not reach it",
    );
    const avg =
      all.reduce((sum, n) => sum + n.kad.size(), 0) / all.length;
    assert(avg > 5, `routing tables barely filled: ${avg.toFixed(1)} contacts on average`);
  });

  await check(
    "a machine knowing ONE address finds a model held by a stranger",
    async () => {
      const key = idOf("gemma-weights");
      const holder = "node-33";
      const { net, all } = await bootstrapped(
        60,
        new Map([[holder, [key]]]),
      );
      const holderNode = all[33]!;
      await net.as(holderNode.contact, () => holderNode.kad.announce(key));

      // A brand-new machine. It knows one address, picked at random, and that
      // address is NOT the holder.
      const newcomer = net.add("fresh-install");
      const introduction = all[12]!;
      assert(
        introduction.contact.id !== holderNode.contact.id,
        "test bug: the introduction is the holder",
      );
      newcomer.kad.seen(introduction.contact);
      assert(
        newcomer.kad.size() === 1,
        "test bug: the newcomer knows more than one address",
      );
      await net.as(newcomer.contact, () =>
        newcomer.kad.lookup(newcomer.contact.id),
      );
      assert(
        newcomer.kad.size() > 1,
        "one introduction taught the newcomer nothing about the network",
      );

      net.queries = 0;
      const providers = await net.as(newcomer.contact, () =>
        newcomer.kad.findProviders(key),
      );
      // Proof the answer was walked to rather than already sitting there: it
      // took real requests, and it took far fewer than asking everybody.
      assert(net.queries > 0, "the lookup made no requests at all");
      assert(
        net.queries < all.length,
        `${net.queries} requests to find one model among ${all.length} nodes — that is asking everybody, not a lookup`,
      );
      assert(providers.length > 0, "nobody was found holding the model");
      assert(
        providers.some((p) => p.id === holderNode.contact.id),
        `found ${providers.length} providers, none of them the real holder`,
      );
      const real = providers.find((p) => p.id === holderNode.contact.id)!;
      assert(
        real.address === holderNode.contact.address &&
          real.port === holderNode.contact.port,
        "the provider's address came back wrong, so it could not be reached",
      );
    },
  );

  await check("the holder itself answers, even before anyone announced", async () => {
    const key = idOf("never-announced");
    const { net, all } = await bootstrapped(30, new Map([["node-8", [key]]]));
    // No announce() at all — but a node walking past the holder still learns
    // it, because a node always answers for what it actually has.
    const seeker = all[21]!;
    const providers = await net.as(seeker.contact, () =>
      seeker.kad.findProviders(key),
    );
    assert(
      providers.some((p) => p.id === all[8]!.contact.id),
      "a node that holds a model did not say so when asked directly",
    );
  });

  await check("a lookup ends when nobody at all is home", async () => {
    const net = new Net();
    const me = net.add("alone");
    for (let i = 0; i < 20; i++) {
      const ghost = net.add(`ghost-${i}`);
      net.dead.add(`${ghost.contact.address}:${ghost.contact.port}`);
      me.kad.seen(ghost.contact);
    }
    net.queries = 0;
    const found = await net.as(me.contact, () => me.kad.lookup(idOf("anything")));
    assert(found.length === 0, "dead nodes were reported as reachable");
    assert(net.queries <= 60, `a dead network cost ${net.queries} requests`);
  });

  // --- what a hostile peer can and cannot do ------------------------------

  await check(
    "contacts a peer invents never enter the routing table",
    async () => {
      const net = new Net();
      const me = net.add("victim");
      const liar = net.add("liar");
      const fakes: Contact[] = [];
      for (let i = 0; i < 200; i++) {
        fakes.push({ id: idOf(`fake-${i}`), address: "203.0.113.9", port: 8097 });
      }
      net.liars.set(`${liar.contact.address}:${liar.contact.port}`, () => ({
        t: "contacts",
        id: liar.contact.id,
        contacts: fakes,
      }));
      me.kad.seen(liar.contact);
      await net.as(me.contact, () => me.kad.lookup(idOf("somewhere")));
      const table = me.kad.closest(idOf("somewhere"), 200);
      const invented = table.filter((c) =>
        fakes.some((f) => f.id === c.id),
      );
      assert(
        invented.length === 0,
        `${invented.length} invented contacts were believed without ever answering`,
      );
      assert(
        table.some((c) => c.id === liar.contact.id),
        "the peer that did answer should still be known",
      );
    },
  );

  await check("a reply in somebody else's name is thrown away", async () => {
    const net = new Net();
    const me = net.add("careful");
    const impostor = net.add("impostor");
    const stolen = idOf("node-i-want-to-be");
    net.liars.set(`${impostor.contact.address}:${impostor.contact.port}`, () => ({
      t: "contacts",
      id: stolen, // signed by them, claiming to be someone else
      contacts: [],
    }));
    me.kad.seen(impostor.contact);
    await net.as(me.contact, () => me.kad.lookup(idOf("target")));
    const table = me.kad.closest(idOf("target"), 50);
    assert(
      !table.some((c) => c.id === stolen),
      "a node was recorded under a name it merely claimed",
    );
  });

  await check(
    "a walk through a network built to trap it still stops",
    async () => {
      const net = new Net();
      const me = net.add("walker");
      // Every node in this network answers with three brand-new ones, forever,
      // and each of those answers the same way. A walk with no bound would keep
      // finding somewhere new to go and never come back.
      let made = 0;
      const nameOf = (n: number): Contact => ({
        id: idOf(`trap-${n}`),
        address: `198.51.100.${n % 250}`,
        port: 9000 + Math.floor(n / 250),
      });
      // Each one answers honestly in its own name, so nothing here is discarded
      // for lying about identity — this test is purely about termination.
      function trap(self: Contact): (req: KadRequest, from: Contact) => KadResponse {
        return (req, from) => {
          void req;
          void from;
          const contacts: Contact[] = [];
          for (let i = 0; i < 3; i++) {
            made += 1;
            const c = nameOf(made);
            contacts.push(c);
            net.liars.set(`${c.address}:${c.port}`, trap(c));
          }
          return { t: "contacts", id: self.id, contacts };
        };
      }
      const entry = nameOf(0);
      net.liars.set(`${entry.address}:${entry.port}`, trap(entry));
      me.kad.seen(entry);
      net.queries = 0;
      await net.as(me.contact, () => me.kad.lookup(idOf("bait")));
      assert(net.queries > 1, "test bug: the trap never sprang");
      assert(
        net.queries <= 60,
        `the walk made ${net.queries} requests; it is supposed to be bounded`,
      );
    },
  );

  await check("an announcement records the address we saw, not the one we were told", () => {
    const net = new Net();
    const keeper = net.add("index");
    const key = idOf("a-model");
    const attacker: Contact = {
      id: idOf("attacker"),
      address: "192.0.2.44", // where they really are
      port: 8097,
    };
    keeper.kad.handle({ t: "announce", key }, attacker);
    const providers = keeper.kad.providersFor(key);
    assert(providers.length === 1, "the announcement was not stored");
    assert(
      providers[0]!.address === "192.0.2.44",
      `the index can be aimed at a third party: ${providers[0]!.address}`,
    );
  });

  await check("provider records are capped per key", () => {
    const net = new Net();
    const keeper = net.add("bounded");
    const key = idOf("popular");
    for (let i = 0; i < 500; i++) {
      keeper.kad.handle(
        { t: "announce", key },
        { id: idOf(`crowd-${i}`), address: `10.5.${i % 250}.2`, port: 8097 },
      );
    }
    assert(
      keeper.kad.stored() <= 64,
      `one key holds ${keeper.kad.stored()} records; memory is somebody else's to decide`,
    );
  });

  await check("the number of keys is capped too", () => {
    const net = new Net();
    const keeper = net.add("bounded-keys");
    const who = { id: idOf("spammer"), address: "10.6.0.2", port: 8097 };
    let refused = 0;
    for (let i = 0; i < 5000; i++) {
      const res = keeper.kad.handle({ t: "announce", key: idOf(`k-${i}`) }, who);
      if (res.t === "stored" && !res.ok) refused += 1;
    }
    assert(refused > 0, "a single peer could add unlimited keys");
    assert(
      keeper.kad.stored() <= 4096,
      `${keeper.kad.stored()} records held for one peer`,
    );
  });

  await check("a record for a key that was never announced is not invented", () => {
    const net = new Net();
    const keeper = net.add("honest");
    const res = keeper.kad.handle(
      { t: "find_value", key: idOf("unknown") },
      { id: idOf("asker"), address: "10.7.0.2", port: 8097 },
    );
    assert(res.t === "contacts", "an empty key should send the asker onwards, not fake an answer");
  });

  await check("provider records expire on their own", async () => {
    const net = new Net();
    const keeper = new Kad(idOf("expiring"), net, { providerTtlMs: 40 });
    const key = idOf("temporary");
    keeper.handle(
      { t: "announce", key },
      { id: idOf("visitor"), address: "10.4.0.2", port: 8097 },
    );
    assert(keeper.providersFor(key).length === 1, "not stored to begin with");
    await new Promise((r) => setTimeout(r, 80));
    assert(
      keeper.providersFor(key).length === 0,
      "a peer that vanished is still being recommended to others",
    );
  });

  await check("malformed requests are answered, not crashed on", () => {
    const net = new Net();
    const keeper = net.add("robust");
    const who = { id: idOf("weird"), address: "10.3.0.2", port: 8097 };
    const bogus = [
      { t: "find_node", target: "short" },
      { t: "find_value", key: "" },
      { t: "announce", key: "../../etc/passwd" },
      { t: "nonsense" },
    ] as unknown as KadRequest[];
    for (const req of bogus) {
      const res = keeper.kad.handle(req, who);
      assert(res != null && typeof res.t === "string", `no reply to ${JSON.stringify(req)}`);
    }
    assert(keeper.kad.stored() === 0, "a malformed key was stored anyway");
  });

  await check("announcing to an empty network is zero, not a crash", async () => {
    const net = new Net();
    const me = net.add("first-ever");
    const acks = await net.as(me.contact, () => me.kad.announce(idOf("lonely")));
    assert(acks === 0, `claimed ${acks} nodes accepted it with nobody around`);
  });

  await check("an announcement reaches the nodes nearest the key", async () => {
    const key = idOf("widely-held");
    const { net, all } = await bootstrapped(40, new Map([["node-3", [key]]]));
    const holder = all[3]!;
    const acks = await net.as(holder.contact, () => holder.kad.announce(key));
    assert(acks > 0, "no node accepted the announcement");
    const keepers = all.filter((n) => n.kad.providersFor(key).length > 0);
    assert(
      keepers.length >= 2,
      `only ${keepers.length} node holds the record; one machine leaving would erase it`,
    );
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

void main();
