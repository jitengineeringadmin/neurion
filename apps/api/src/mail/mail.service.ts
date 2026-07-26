import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { Mail } from "./templates";

/**
 * Transactional email via SMTP (e.g. Aruba: smtps.aruba.it:465).
 * If SMTP is not configured the service no-ops (logs a warning) so the rest of
 * auth keeps working in dev / before credentials are provisioned.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>("SMTP_HOST");
    const user = this.config.get<string>("SMTP_USER");
    const pass = this.config.get<string>("SMTP_PASS");
    if (host && user && pass) {
      const port = Number(this.config.get<string>("SMTP_PORT") ?? 465);
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure:
          this.config.get<string>("SMTP_SECURE") !== "false" && port === 465,
        auth: { user, pass },
      });
      this.logger.log(`SMTP configured: ${host}:${port} as ${user}`);
    } else {
      this.logger.warn(
        "SMTP not configured (SMTP_HOST/USER/PASS) — emails are disabled.",
      );
    }
  }

  get enabled(): boolean {
    return this.transporter !== null;
  }

  appUrl(): string {
    return (
      this.config.get<string>("APP_PUBLIC_URL") ?? "https://neurionproject.org"
    );
  }

  private from(): string {
    return (
      this.config.get<string>("SMTP_FROM") ??
      `Neurion <noreply@neurionproject.org>`
    );
  }

  /** Send an email; never throws (logs + returns false on failure). */
  async send(to: string, mail: Mail): Promise<boolean> {
    if (!this.transporter) {
      this.logger.warn(`email skipped (SMTP off): "${mail.subject}" -> ${to}`);
      return false;
    }
    try {
      await this.transporter.sendMail({
        from: this.from(),
        to,
        subject: mail.subject,
        html: mail.html,
      });
      return true;
    } catch (e) {
      this.logger.error(`email failed -> ${to}: ${(e as Error).message}`);
      return false;
    }
  }
}
