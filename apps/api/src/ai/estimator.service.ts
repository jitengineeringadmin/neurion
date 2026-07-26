import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface Estimate {
  isHeavy: boolean;
  estInputTokens: number;
  estCredits: number;
  estSeconds: number;
  reasons: string[];
}

/** G8 — cheap pre-pass: no model run. chars/4 token heuristic + byte threshold. */
@Injectable()
export class EstimatorService {
  constructor(private readonly config: ConfigService) {}

  estimate(message: string, attachmentBytes = 0): Estimate {
    const reasons: string[] = [];
    const estInputTokens = Math.ceil((message?.length ?? 0) / 4);
    const tokenThreshold = Number(
      this.config.get("AI_GRID_JOB_THRESHOLD_TOKENS") ?? 6000,
    );
    const fileThresholdMb = Number(
      this.config.get("AI_GRID_FILE_THRESHOLD_MB") ?? 5,
    );
    const attachmentMb = attachmentBytes / (1024 * 1024);

    let isHeavy = false;
    if (estInputTokens > tokenThreshold) {
      isHeavy = true;
      reasons.push(`tokens ${estInputTokens} > ${tokenThreshold}`);
    }
    if (attachmentMb > fileThresholdMb) {
      isHeavy = true;
      reasons.push(
        `attachments ${attachmentMb.toFixed(1)}MB > ${fileThresholdMb}MB`,
      );
    }

    const estCredits = isHeavy ? 10 : estInputTokens > 1500 ? 5 : 2;
    const estSeconds = isHeavy ? 120 : 6;
    return { isHeavy, estInputTokens, estCredits, estSeconds, reasons };
  }
}
