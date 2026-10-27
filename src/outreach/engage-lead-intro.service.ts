import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type EngageLeadIntroEvent = {
  id: string;
  created_at?: string;
  sender_phone?: string | null;
  recipient_phone?: string | null;
  fields?: Record<string, unknown> | null;
  sent?: boolean | null;
  reason?: string | null;
  message_id?: string | null;
  message?: { status?: string | null } | { status?: string | null }[] | null;
};

export type EngageLeadIntroRow = {
  engageLeadIntroEventId: string;
  name: string;
  phoneNumber: string;
  senderPhoneNumber?: string;
  engageReason?: string;
  engageSent?: boolean;
  engageMessageStatus?: string;
  engageCreatedAt?: Date;
};

@Injectable()
export class EngageLeadIntroService {
  private readonly logger = new Logger(EngageLeadIntroService.name);

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return !!(
      this.restBase() &&
      this.organizationId() &&
      this.publishableKey() &&
      (this.serverApiKey() || this.restBearer())
    );
  }

  async fetchRecentEvents(limit = 100, senderPhone?: string): Promise<EngageLeadIntroEvent[]> {
    if (!this.restBase() || !this.organizationId() || !this.publishableKey()) {
      throw new BadRequestException(
        'Engage lead intro sync requires ENGAGE_ORGANIZATION_ID and ENGAGE_PUBLISHABLE_KEY in .env',
      );
    }
    const headers = this.restAuthHeaders();
    if (!headers) {
      throw new BadRequestException(
        'Set ENGAGE_API_KEY (OpenBSP Settings → API Keys, api-key header) or ENGAGE_REST_BEARER_TOKEN (user JWT) for lead_intro_events',
      );
    }

    const params = new URLSearchParams({
      organization_id: `eq.${this.organizationId()}`,
      select:
        'id,created_at,sender_phone,recipient_phone,fields,sent,reason,message_id,message:messages(status)',
      order: 'created_at.desc',
      limit: String(Math.min(Math.max(limit, 1), 500)),
    });
    const sender = this.normalizeSenderPhone(senderPhone);
    if (sender) {
      params.set('sender_phone', `eq.${sender}`);
    }

    const url = `${this.restBase()}/lead_intro_events?${params}`;
    const response = await fetch(url, { headers });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      const msg =
        (json && typeof json === 'object' && 'message' in json
          ? String((json as { message: unknown }).message)
          : null) || response.statusText;
      throw new BadRequestException(`Engage lead_intro_events failed: ${msg}`);
    }
    if (!Array.isArray(json)) {
      this.logger.warn('Engage lead_intro_events returned non-array');
      return [];
    }
    return json as EngageLeadIntroEvent[];
  }

  mapEventToRow(event: EngageLeadIntroEvent): EngageLeadIntroRow | undefined {
    const fields = (event.fields && typeof event.fields === 'object'
      ? event.fields
      : {}) as Record<string, unknown>;

    // Engage lead_intro stores parsed words under fields.values (see engage-api lead_intro.ts)
    const values = this.leadIntroFieldValues(fields);

    const name = this.pickPersonName(values);
    const mobileFromFields = this.pickMobileFromValues(values);
    const phoneRaw =
      (event.recipient_phone || '').trim() ||
      mobileFromFields ||
      this.pickString(values, ['recipient_phone']) ||
      this.pickString(fields, ['recipient_phone']);

    if (!phoneRaw) return undefined;

    const resolvedName = name || 'Unknown';
    const messageStatus = this.messageStatus(event.message);

    return {
      engageLeadIntroEventId: String(event.id),
      name: resolvedName,
      phoneNumber: phoneRaw,
      senderPhoneNumber: (event.sender_phone || '').trim() || undefined,
      engageReason: (event.reason || '').trim() || undefined,
      engageSent: event.sent === true,
      engageMessageStatus: messageStatus,
      engageCreatedAt: event.created_at ? new Date(event.created_at) : undefined,
    };
  }

  private messageStatus(
    message: EngageLeadIntroEvent['message'],
  ): string | undefined {
    if (!message) return undefined;
    const row = Array.isArray(message) ? message[0] : message;
    return this.stringifyStatus(row?.status);
  }

  private stringifyStatus(status: unknown): string | undefined {
    if (status == null) return undefined;
    if (typeof status === 'string') {
      const s = status.trim();
      return s || undefined;
    }
    if (typeof status === 'object') {
      try {
        return JSON.stringify(status);
      } catch {
        return undefined;
      }
    }
    return String(status);
  }

  private leadIntroFieldValues(fields: Record<string, unknown>): Record<string, unknown> {
    const nested = fields.values;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
    return fields;
  }

  private pickPersonName(values: Record<string, unknown>): string {
    const preferred = [
      'name',
      'full name',
      'full_name',
      'customer name',
      'customer_name',
      'contact name',
      'contact_name',
      'client name',
    ];
    for (const key of preferred) {
      const v = this.valueByKeyIgnoreCase(values, key);
      if (v) return v;
    }
    for (const [key, raw] of Object.entries(values)) {
      const k = key.toLowerCase();
      if (!k.includes('name') || k.includes('company') || k.includes('business')) continue;
      const v = this.asTrimmedString(raw);
      if (v) return v;
    }
    return '';
  }

  private pickMobileFromValues(values: Record<string, unknown>): string {
    const preferred = [
      'mobile number',
      'mobile_number',
      'mobilenumber',
      'phone number',
      'phone_number',
      'phone',
      'whatsapp',
      'contact number',
    ];
    for (const key of preferred) {
      const v = this.valueByKeyIgnoreCase(values, key);
      if (v) return v;
    }
    for (const [key, raw] of Object.entries(values)) {
      const k = key.toLowerCase();
      if (!k.includes('mobile') && !k.includes('phone') && !k.includes('whatsapp')) continue;
      const v = this.asTrimmedString(raw);
      if (v) return v;
    }
    return '';
  }

  private valueByKeyIgnoreCase(obj: Record<string, unknown>, wanted: string): string {
    const target = wanted.trim().toLowerCase();
    for (const [key, raw] of Object.entries(obj)) {
      if (key.trim().toLowerCase() === target) {
        return this.asTrimmedString(raw);
      }
    }
    return '';
  }

  private asTrimmedString(raw: unknown): string {
    if (typeof raw === 'string') return raw.trim();
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    return '';
  }

  private pickString(obj: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
      const v = this.valueByKeyIgnoreCase(obj, key) || this.asTrimmedString(obj[key]);
      if (v) return v;
    }
    return '';
  }

  private restBase(): string {
    const explicit = (this.configService.get<string>('ENGAGE_REST_BASE') || '').trim();
    if (explicit) return explicit.replace(/\/$/, '');
    const messagesUrl = (
      this.configService.get<string>('ENGAGE_API_URL') ||
      'https://api.engage.brandigiops.com/rest/v1/messages'
    ).trim();
    return messagesUrl.replace(/\/messages\/?$/, '');
  }

  private organizationId(): string {
    return (this.configService.get<string>('ENGAGE_ORGANIZATION_ID') || '').trim();
  }

  private publishableKey(): string {
    return (this.configService.get<string>('ENGAGE_PUBLISHABLE_KEY') || '').trim();
  }

  private restBearer(): string {
    return (this.configService.get<string>('ENGAGE_REST_BEARER_TOKEN') || '').trim();
  }

  /** OpenBSP org API key (sk_…) — does not expire like a user JWT. */
  private serverApiKey(): string {
    return (this.configService.get<string>('ENGAGE_API_KEY') || '').trim();
  }

  /** Prefer long-lived api-key (engage-api README); fallback to user Bearer JWT. */
  private normalizeSenderPhone(raw?: string): string {
    const digits = (raw || '').replace(/\D/g, '');
    if (!digits) return '';
    return digits.startsWith('91') ? digits : `91${digits}`;
  }

  private restAuthHeaders(): Record<string, string> | undefined {
    const apikey = this.publishableKey();
    const secret = this.serverApiKey();
    if (secret) {
      return {
        apikey,
        'api-key': secret,
        Accept: 'application/json',
      };
    }
    const bearer = this.restBearer();
    if (bearer) {
      return {
        apikey,
        Authorization: `Bearer ${bearer}`,
        Accept: 'application/json',
      };
    }
    return undefined;
  }
}
