import { Injectable, Logger } from "@nestjs/common";
import { JobPrivacyLevel } from "@prisma/client";
import { maxPrivacy } from "./privacy.util";

export interface ClassificationResult {
  category: "NONE" | "PII" | "SENSITIVE" | "FAILSAFE";
  flags: string[];
  escalateTo: JobPrivacyLevel;
  hardTrustedOnly: boolean;
  failedSafe: boolean;
}

const FAILSAFE: ClassificationResult = {
  category: "FAILSAFE",
  flags: ["CLASSIFIER_FAILSAFE"],
  escalateTo: "VERIFIED_ONLY",
  hardTrustedOnly: true,
  failedSafe: true,
};

/** G2 — advisory, fail-safe-up classifier. Can only RAISE the privacy floor. */
@Injectable()
export class PrivacyClassifierService {
  private readonly logger = new Logger(PrivacyClassifierService.name);
  private static readonly MAX_LEN = 16_000;

  private static readonly SECRET = [
    /sk-[A-Za-z0-9]{20,64}/,
    /(?:AKIA|ASIA)[0-9A-Z]{16}/,
    /gh[pousr]_[A-Za-z0-9]{30,80}/,
    /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
    /eyJ[A-Za-z0-9_-]{8,256}\.[A-Za-z0-9_-]{8,256}\.[A-Za-z0-9_-]{8,256}/,
    /password\s{0,4}[:=]\s{0,4}\S{1,128}/i,
  ];
  private static readonly ART9 = [
    /(diagnos|prescrib|psychiatr|HIV|cancer|pregnan|disab)/i,
    /(IBAN|swift|card\s{0,2}number|cvv|ssn|social security)/i,
  ];
  private static readonly PII = [
    /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/,
    /\+?\d[\d ().-]{6,18}\d/,
  ];

  classify(textRaw: string): ClassificationResult {
    try {
      const text = (textRaw ?? "").slice(0, PrivacyClassifierService.MAX_LEN);
      const flags: string[] = [];
      let escalateTo: JobPrivacyLevel = "PUBLIC";
      let hardTrustedOnly = false;
      let category: ClassificationResult["category"] = "NONE";

      if (PrivacyClassifierService.SECRET.some((r) => r.test(text))) {
        flags.push("SECRET");
        hardTrustedOnly = true;
        category = "SENSITIVE";
        escalateTo = maxPrivacy(escalateTo, "VERIFIED_ONLY");
      }
      if (PrivacyClassifierService.ART9.some((r) => r.test(text))) {
        flags.push("ART9");
        hardTrustedOnly = true;
        category = "SENSITIVE";
        escalateTo = maxPrivacy(escalateTo, "VERIFIED_ONLY");
      }
      if (PrivacyClassifierService.PII.some((r) => r.test(text))) {
        flags.push("PII");
        if (category === "NONE") category = "PII";
        escalateTo = maxPrivacy(escalateTo, "VERIFIED_ONLY");
      }
      return {
        category,
        flags,
        escalateTo,
        hardTrustedOnly,
        failedSafe: false,
      };
    } catch (err) {
      this.logger.error(`classifier failed -> failing safe UP: ${String(err)}`);
      return FAILSAFE;
    }
  }
}
