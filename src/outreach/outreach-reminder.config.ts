import { ConfigService } from '@nestjs/config';

function envFlagEnabled(config: ConfigService, key: string, defaultEnabled = true): boolean {
  const raw = (config.get<string>(key) ?? (defaultEnabled ? 'true' : 'false')).trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

/** When false, no reminder WhatsApps are scheduled or sent. */
export function outreachSendRemindersEnabled(config: ConfigService): boolean {
  return envFlagEnabled(config, 'OUTREACH_SEND_REMINDERS');
}

/** When false, no thank-you WhatsApps are scheduled or sent (review detection may still run). */
export function outreachSendThankYousEnabled(config: ConfigService): boolean {
  return envFlagEnabled(config, 'OUTREACH_SEND_THANK_YOUS');
}