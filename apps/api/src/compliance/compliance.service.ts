import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

@Injectable()
export class ComplianceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  listRecords(take = 100) {
    return this.prisma.complianceRecord.findMany({
      orderBy: { createdAt: "desc" },
      take,
    });
  }

}
