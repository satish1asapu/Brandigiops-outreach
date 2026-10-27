import { EngageLeadIntroEvent } from './engage-lead-intro.service';

export function engageEventWasSent(data: Record<string, unknown>): boolean {
  return data.sent === true && String(data.reason || '').trim().toLowerCase() === 'sent';
}

export function recipientPhoneFromEngageData(data: Record<string, unknown>): string {
  const top = String(data.recipient_phone || '').trim();
  if (top) return top;
  const fields = (data.fields || {}) as Record<string, unknown>;
  const values = (fields.values && typeof fields.values === 'object'
    ? fields.values
    : fields) as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    const k = key.toLowerCase();
    if (k.includes('mobile') || k.includes('phone') || k.includes('whatsapp')) {
      const v = values[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return '';
}

export function recipientNameFromEngageData(data: Record<string, unknown>): string {
  const fields = (data.fields || {}) as Record<string, unknown>;
  const values = (fields.values && typeof fields.values === 'object'
    ? fields.values
    : fields) as Record<string, unknown>;
  for (const key of ['name', 'full name', 'customer name', 'contact name']) {
    for (const [k, v] of Object.entries(values)) {
      if (k.trim().toLowerCase() === key && typeof v === 'string' && v.trim()) {
        return v.trim();
      }
    }
  }
  for (const [k, v] of Object.entries(values)) {
    if (k.toLowerCase().includes('name') && typeof v === 'string' && v.trim()) {
      return v.trim();
    }
  }
  return 'there';
}

export function engageCreatedAt(data: Record<string, unknown>): Date | undefined {
  const raw = data.created_at;
  if (!raw) return undefined;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function asEngageEvent(data: Record<string, unknown>): EngageLeadIntroEvent {
  return data as EngageLeadIntroEvent;
}
