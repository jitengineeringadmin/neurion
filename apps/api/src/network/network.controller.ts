import { Controller, Get, Header } from "@nestjs/common";
import { Public } from "../common/decorators/public.decorator";
import { NetworkService } from "./network.service";

// Public, read-only network status. Returns ONLY network-wide aggregates —
// never per-node identity, IP, owner, fingerprint or key.
@Public()
@Controller("network")
export class NetworkController {
  constructor(private readonly network: NetworkService) {}

  @Get("stats")
  @Header("Cache-Control", "public, max-age=5")
  stats() {
    return this.network.stats();
  }

  @Get("history")
  @Header("Cache-Control", "public, max-age=30")
  history() {
    return this.network.getHistory();
  }
}
