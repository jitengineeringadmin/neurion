import { Controller, Get } from "@nestjs/common";
import { ComplianceService } from "./compliance.service";
import { Roles } from "../common/decorators/roles.decorator";

/**
 * What is left of compliance once there are no payouts to hold.
 *
 * block-payouts and unblock-payouts went with the money layer rather than being
 * left in place. The only reader of the flag they wrote lived in the payout
 * service, so kept, they would have answered 200 and written an audit record
 * while changing nothing — a moderation tool that quietly does not moderate,
 * which is worse than not having one at all.
 */
@Controller("admin/compliance")
@Roles("SUPER_ADMIN", "ADMIN", "COMPLIANCE")
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Get()
  list() {
    return this.compliance.listRecords();
  }
}
