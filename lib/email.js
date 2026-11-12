'use strict';

const {
  appendJsonLine,
  escapeHtml,
  isValidEmail,
  readJson
} = require('./util');

function resolveProvider(config) {
  const email = config.email;

  if (email.provider === 'none') return null;

  if (email.provider === 'resend') {
    return email.resendApiKey ? 'resend' : null;
  }

  if (email.provider === 'webhook') {
    return email.webhookUrl ? 'webhook' : null;
  }

  if (email.provider === 'formspree') {
    return email.formEndpoint ? 'formspree' : null;
  }

  if (email.resendApiKey) return 'resend';
  if (email.webhookUrl) return 'webhook';
  if (email.formEndpoint) return 'formspree';
  return null;
}

async function loadAdminEmails(config) {
  if (config.email.adminEmails.length) return config.email.adminEmails;

  try {
    const data = config.database
      ? await config.database.readAdmins()
      : await readJson(config.adminsFile, { admins: [] });
    const list = Array.isArray(data) ? data : data.admins;
    if (!Array.isArray(list)) return [];

    return [...new Set(
      list
        .map((admin) => String(admin?.email || '').trim().toLowerCase())
        .filter((email) => isValidEmail(email))
    )];
  } catch {
    return [];
  }
}

function buildMessage({ moment, contributor, dashboardUrl }) {
  const caption = moment.caption || 'A new lab moment';
  const sharedBy = contributor || 'Anonymous contributor';
  const uploadedAt = moment.uploadedAt
    ? new Date(moment.uploadedAt).toUTCString()
    : new Date().toUTCString();

  const subject = `LabRoute moment awaiting review: “${caption}”`;

  const text = [
    'A new lab moment is waiting for an admin decision on LabRoute.',
    '',
    `Caption: ${caption}`,
    `Shared by: ${sharedBy}`,
    `Received: ${uploadedAt}`,
    `Review it: ${dashboardUrl}`,
    '',
    'The photo is in the pending folder. Approve it to make it image 1 of the',
    'homepage gallery, or decline it to remove it.'
  ].join('\n');

  const html = `
  <div style="margin:0;padding:24px;background:#f3f3fc;font-family:Arial,Helvetica,sans-serif;color:#1a1b22;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e2e2eb;border-radius:14px;overflow:hidden;">
      <tr>
        <td style="background:#002147;padding:22px 28px;">
          <p style="margin:0 0 6px;color:#d4af37;font-size:11px;letter-spacing:1.6px;text-transform:uppercase;">LabRoute · Community gallery</p>
          <h1 style="margin:0;color:#ffffff;font-size:22px;line-height:1.3;">A lab moment needs your review</h1>
        </td>
      </tr>
      <tr>
        <td style="padding:26px 28px;">
          <p style="margin:0 0 16px;font-size:18px;line-height:1.45;font-family:Georgia,serif;color:#002147;">${escapeHtml(
            caption
          )}</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;line-height:1.7;color:#535665;">
            <tr><td style="width:110px;color:#7a7f93;">Shared by</td><td>${escapeHtml(sharedBy)}</td></tr>
            <tr><td style="color:#7a7f93;">Received</td><td>${escapeHtml(uploadedAt)}</td></tr>
            <tr><td style="color:#7a7f93;">Status</td><td>Pending approval</td></tr>
          </table>
          <p style="margin:22px 0 8px;">
            <a href="${escapeHtml(
              dashboardUrl
            )}" style="display:inline-block;background:#d4af37;color:#002147;text-decoration:none;font-weight:bold;padding:11px 18px;border-radius:999px;">Review in the dashboard</a>
          </p>
          <p style="margin:20px 0 0;padding-top:16px;border-top:1px solid #e2e2eb;font-size:12px;line-height:1.6;color:#7a7f93;">
            Nothing is published yet. Approving the photo places it first in the homepage gallery and moves every existing photo one place to the right.
          </p>
        </td>
      </tr>
    </table>
  </div>`;

  return { subject, text, html };
}

async function postJson(url, payload, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const raw = await response.text();
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }

    if (!response.ok) {
      const detail =
        (body && (body.error || body.message)) ||
        raw.replace(/\s+/g, ' ').trim().slice(0, 260) ||
        `HTTP ${response.status}`;
      throw new Error(`Provider responded with HTTP ${response.status}: ${detail}`);
    }

    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function sendWithResend(config, message, recipients) {
  const payload = {
    from: config.email.resendFrom,
    to: recipients,
    subject: message.subject,
    text: message.text,
    html: message.html
  };

  await postJson(
    'https://api.resend.com/emails',
    payload,
    { Authorization: `Bearer ${config.email.resendApiKey}` },
    config.email.timeoutMs
  );
}

async function sendWithFormspree(config, message, recipients, moment, contributor, links) {
  await postJson(
    config.email.formEndpoint,
    {
      _subject: message.subject,
      event: 'lab_moment.pending',
      momentId: moment.id,
      caption: moment.caption,
      contributor,
      adminEmails: recipients.join(', '),
      dashboardUrl: links.dashboardUrl,
      message: message.text
    },
    {},
    config.email.timeoutMs
  );
}

async function sendWithWebhook(config, message, recipients, moment, contributor, links) {
  await postJson(
    config.email.webhookUrl,
    {
      event: 'lab_moment.pending',
      sentAt: new Date().toISOString(),
      administrators: recipients,
      moment,
      contributor,
      links,
      subject: message.subject,
      text: message.text
    },
    {},
    config.email.timeoutMs
  );
}

async function notifyMomentUpload({ config, moment, contributor, links }) {
  const provider = resolveProvider(config);
  const recipients = await loadAdminEmails(config);

  if (!provider) {
    return {
      provider: 'none',
      status: 'skipped',
      recipients,
      reason: 'Email notifications are not configured.'
    };
  }

  if (!recipients.length) {
    return {
      provider,
      status: 'skipped',
      recipients,
      reason: 'No administrator email addresses were found.'
    };
  }

  const message = buildMessage({ moment, contributor, ...links });

  try {
    if (provider === 'resend') {
      await sendWithResend(config, message, recipients);
    } else if (provider === 'formspree') {
      await sendWithFormspree(config, message, recipients, moment, contributor, links);
    } else if (provider === 'webhook') {
      await sendWithWebhook(config, message, recipients, moment, contributor, links);
    }

    return { provider, status: 'sent', recipients };
  } catch (error) {
    return {
      provider,
      status: 'failed',
      recipients,
      error: String(error.message || error).slice(0, 400)
    };
  }
}

async function logNotification(config, entry) {
  try {
    const record = { at: new Date().toISOString(), ...entry };
    if (config.database) await config.database.logNotification(record);
    else await appendJsonLine(config.notificationsFile, record);
  } catch (error) {
    console.warn(`[labroute] Could not write the notification log: ${error.message}`);
  }
}

module.exports = {
  loadAdminEmails,
  logNotification,
  notifyMomentUpload,
  resolveProvider
};
