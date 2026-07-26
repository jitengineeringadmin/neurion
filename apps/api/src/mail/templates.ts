// Branded transactional email templates (inline styles for mail-client compat).
// Matrix theme: near-black bg, Neurion green accent.

const BG = "#04070a";
const SURFACE = "#0a1410";
const LINE = "#16321f";
const ACCENT = "#00ff70";
const TEXT = "#dff6e6";
const MUTED = "#7fa890";

function layout(opts: {
  appUrl: string;
  title: string;
  intro: string;
  bodyHtml: string;
  footer?: string;
}): string {
  const logo = `${opts.appUrl}/favicon.png`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:${BG};color:${TEXT};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${SURFACE};border:1px solid ${LINE};border-radius:16px;overflow:hidden;">
        <tr><td style="padding:28px 32px 8px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle;"><img src="${logo}" width="34" height="34" alt="Neurion" style="display:block;border-radius:8px;"></td>
            <td style="vertical-align:middle;padding-left:12px;font-size:20px;font-weight:700;letter-spacing:.12em;color:${ACCENT};">NEURION</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:16px 32px 0;">
          <h1 style="margin:0 0 6px;font-size:22px;color:${TEXT};">${opts.title}</h1>
          <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:${MUTED};">${opts.intro}</p>
          ${opts.bodyHtml}
        </td></tr>
        <tr><td style="padding:24px 32px 28px;">
          <hr style="border:none;border-top:1px solid ${LINE};margin:0 0 14px;">
          <p style="margin:0;font-size:12px;line-height:1.6;color:${MUTED};">${opts.footer ?? "Neurion — distributed AI compute network. If you did not request this, you can ignore this email."}</p>
          <p style="margin:8px 0 0;font-size:12px;color:${MUTED};"><a href="${opts.appUrl}" style="color:${ACCENT};text-decoration:none;">neurionproject.org</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;"><tr>
    <td style="border-radius:10px;background:${ACCENT};">
      <a href="${href}" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:700;color:${BG};text-decoration:none;border-radius:10px;">${label}</a>
    </td></tr></table>
  <p style="margin:0 0 4px;font-size:12px;color:${MUTED};">Or paste this link in your browser:</p>
  <p style="margin:0;font-size:12px;word-break:break-all;"><a href="${href}" style="color:${ACCENT};">${href}</a></p>`;
}

export interface Mail {
  subject: string;
  html: string;
}

export function welcomeEmail(appUrl: string, verifyUrl: string | null): Mail {
  const verifyBlock = verifyUrl
    ? `<p style="margin:0 0 6px;font-size:14px;color:${TEXT};">Confirm your email to secure your account:</p>${button(verifyUrl, "Verify email")}`
    : `${button(`${appUrl}/login`, "Open Neurion")}`;
  return {
    subject: "Welcome to Neurion",
    html: layout({
      appUrl,
      title: "Welcome to Neurion",
      intro:
        "Your account is ready. Run AI privately, or share your compute and earn NRN — a network where only verified work gets paid.",
      bodyHtml: verifyBlock,
    }),
  };
}

export function verifyEmail(appUrl: string, verifyUrl: string): Mail {
  return {
    subject: "Verify your Neurion email",
    html: layout({
      appUrl,
      title: "Verify your email",
      intro:
        "Confirm this address belongs to you. The link expires in 24 hours.",
      bodyHtml: button(verifyUrl, "Verify email"),
    }),
  };
}

export function resetPasswordEmail(appUrl: string, resetUrl: string): Mail {
  return {
    subject: "Reset your Neurion password",
    html: layout({
      appUrl,
      title: "Reset your password",
      intro:
        "We received a request to reset your password. The link expires in 1 hour. If it wasn’t you, ignore this email — your password stays unchanged.",
      bodyHtml: button(resetUrl, "Reset password"),
    }),
  };
}

export function passwordChangedEmail(appUrl: string): Mail {
  return {
    subject: "Your Neurion password was changed",
    html: layout({
      appUrl,
      title: "Password changed",
      intro:
        "Your password was just changed. If this was you, no action is needed. If not, reset it immediately and contact support.",
      bodyHtml: button(`${appUrl}/forgot`, "Reset password"),
      footer: "Neurion security notice.",
    }),
  };
}
