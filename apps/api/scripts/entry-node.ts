/**
 * A public way in. Nothing else.
 *
 * The network needs one thing that a brand-new install can knock on, and that
 * thing does not have to be special: no models, no database, no account system,
 * no privileged position. It answers "who else is around", it holds a few
 * "X has Y" notes for other people, and it forwards lookups. That is all a Kad
 * node is, and it is why anybody can run one.
 *
 * Deliberately the SAME code the desktop app runs, not a reimplementation. A
 * separate server implementation would drift, and the first thing to drift
 * would be some rule about what to refuse — which is exactly the part that must
 * not differ between a machine in somebody's kitchen and a machine in a rack.
 *
 * Run it anywhere:
 *
 *   NEURION_NODE_DIR=/var/lib/neurion-node npx tsx scripts/entry-node.ts
 *
 * The one thing to get right is the port: TCP 8097 has to be reachable from the
 * internet, or this is a node that nobody can use as a way in.
 *
 * What it deliberately does NOT do:
 *
 *  - it never scans the network it is attached to. On a rented machine that
 *    would mean probing a stranger's datacentre, which is rude at best;
 *  - it never lends compute. It has no models to run and no business running
 *    anybody's prompts;
 *  - it holds no user data of any kind. What it keeps is a key pair, a list of
 *    addresses, and notes that expire by themselves within the hour.
 */
import { ConfigService } from "@nestjs/config";
import { mkdirSync } from "node:fs";
import { PeerService } from "../src/ai/engine/peer.service";

const dir = process.env.NEURION_NODE_DIR || "./neurion-node";
const port = process.env.NEURION_PEER_PORT || "8097";
mkdirSync(dir, { recursive: true });

const config = {
  get: (k: string) =>
    (
      ({
        NEURION_TEXT_DIR: dir,
        NEURION_PEER_PORT: port,
        // Never scan the network this machine sits on.
        NEURION_PEER_SWEEP: "false",
        NEURION_PEER_SHARING: "true",
      }) as Record<string, string>
    )[k],
} as unknown as ConfigService;

const peer = new PeerService(config);
peer.start();

console.log(
  [
    ``,
    `Neurion entry node`,
    `  identity   ${peer.myPeerId() || "(could not be created)"}`,
    `  port       ${port}  — must be reachable from outside for this to be of any use`,
    `  state in   ${dir}`,
    ``,
    `Holding no models and serving no prompts: this is a way in and an index,`,
    `nothing more. Anyone can run one of these, and the network is healthier`,
    `the more people do.`,
    ``,
  ].join("\n"),
);

// Say what is going on now and then, because a node that prints nothing is a
// node whose owner cannot tell whether it is doing anything.
setInterval(() => {
  const idx = peer.indexStatus();
  const known = peer.known().length;
  console.log(
    `[${new Date().toISOString()}] peers ${known} · index ${idx.nodes} nodes · ` +
      `${idx.records} records held for others · ${peer.savedNodes().length} remembered`,
  );
}, 300_000);

const bye = (): void => {
  peer.onModuleDestroy();
  process.exit(0);
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
