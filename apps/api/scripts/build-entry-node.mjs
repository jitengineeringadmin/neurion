/**
 * Bundle the entry node into one file that plain `node` can run.
 *
 * A way into the network should be trivial to run, and "clone a monorepo,
 * install a package manager, install two thousand packages" is not trivial.
 * One file and a node binary is. It also keeps a public node completely
 * separate from anything else on the machine it runs on — nothing shared, no
 * install step to get wrong, and removing it is deleting a file.
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["scripts/entry-node.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "dist/entry-node.cjs",
  // Nest pulls these in behind optional requires it never reaches on this
  // path; bundling them would drag in half a framework for a Logger.
  external: [
    "class-transformer",
    "class-validator",
    "@nestjs/microservices",
    "@nestjs/websockets",
    "@nestjs/core",
    "cache-manager",
  ],
  logLevel: "info",
});
