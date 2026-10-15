import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type SendBusinessReviewWhatsAppInput = {
  toPhone: string;
  recipientName: string;
  engageLink: string;
  businessName?: string;
};

export type SendTemplateInput = {
  toPhone: string;
  templateName: string;
  // Positional body parameters {{1}}, {{2}}, ... — must match the approved Meta template
  bodyParams: string[];
  fallbackText: string;
};

export type SendBusinessReviewWhatsAppResult = {
  ok: boolean;
  delivered: boolean;
  phone: string;
  templateName: string;
  messageId?: string;
  metaErrorCode?: number;
  metaErrorMessage?: string;
  result?: unknown;
  deliveryStatus?: unknown;
};

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(private readonly configService: ConfigService) {}

  async sendBusinessReviewLink(
    input: SendBusinessReviewWhatsAppInput,
  ): Promise<SendBusinessReviewWhatsAppResult> {
    const name = this.sanitizeTemplateText(input.recipientName || 'there', 60);
    const link = this.sanitizeTemplateText(input.engageLink, 1024);

    // Template body:
    // Hello {{1}},
    // A review link has been generated...
    // {{2}}
    return this.sendTemplate({
      toPhone: input.toPhone,
      templateName: this.templateName('GMB_WHATSAPP_TEMPLATE', 'business_review_link'),
      bodyParams: [name, link],
      fallbackText: `GMB review link for ${name}: ${link}`,
    });
  }

  // Template body expected: {{1}} = name, {{2}} = business name, {{3}} = engage link
  async sendReviewReminder(
    input: SendBusinessReviewWhatsAppInput,
  ): Promise<SendBusinessReviewWhatsAppResult> {
    const name = this.sanitizeTemplateText(input.recipientName || 'there', 60);
    const business = this.sanitizeTemplateText(input.businessName || 'our business', 60);
    const link = this.sanitizeTemplateText(input.engageLink, 1024);

    return this.sendTemplate({
      toPhone: input.toPhone,
      templateName: this.templateName('GMB_REMINDER_TEMPLATE', 'business_review_reminder'),
      bodyParams: [name, business, link],
      fallbackText: `Reminder for ${name} to leave a Google review for ${business}: ${link}`,
    });
  }

  // Template customer_review_request: {{1}} name, {{2}} business, {{3}} engage (trackable) link
  async sendCustomerReviewRequest(input: {
    toPhone: string;
    customerName: string;
    businessName: string;
    engageLink: string;
  }): Promise<SendBusinessReviewWhatsAppResult> {
    const name = this.sanitizeTemplateText(input.customerName || 'there', 60);
    const business = this.sanitizeTemplateText(input.businessName || 'our business', 60);
    const link = this.sanitizeTemplateText(input.engageLink, 1024);

    return this.sendTemplate({
      toPhone: input.toPhone,
      templateName: this.templateName(
        'GMB_CUSTOMER_REVIEW_TEMPLATE',
        'customer_review_request',
      ),
      bodyParams: [name, business, link],
      fallbackText: `Hi ${name}, please leave a Google review for ${business}: ${link}`,
    });
  }

  // Template body expected: {{1}} = name, {{2}} = business name
  async sendReviewThankYou(input: {
    toPhone: string;
    recipientName: string;
    businessName: string;
  }): Promise<SendBusinessReviewWhatsAppResult> {
    const name = this.sanitizeTemplateText(input.recipientName || 'there', 60);
    const business = this.sanitizeTemplateText(input.businessName || 'our business', 60);

    return this.sendTemplate({
      toPhone: input.toPhone,
      templateName: this.templateName('GMB_THANK_YOU_TEMPLATE', 'business_review_thank_you'),
      bodyParams: [name, business],
      fallbackText: `Thank you ${name} for your Google review for ${business}`,
    });
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendBusinessReviewWhatsAppResult> {
    const phone = this.toWhatsAppContactAddress(input.toPhone);
    if (!phone) {
      throw new BadRequestException('phoneNumber is empty or invalid');
    }

    const apiKey = (this.configService.get<string>('ENGAGE_API_KEY') || '').trim();
    const publishableKey = (this.configService.get<string>('ENGAGE_PUBLISHABLE_KEY') || '').trim();
    if (!apiKey || !publishableKey) {
      throw new BadRequestException(
        'Engage WhatsApp keys missing. Set ENGAGE_API_KEY and ENGAGE_PUBLISHABLE_KEY in .env',
      );
    }

    const templateName = input.templateName;
    const apiUrl =
      (this.configService.get<string>('ENGAGE_API_URL') ||
        'https://api.engage.brandigiops.com/rest/v1/messages').trim();
    const organizationId =
      (this.configService.get<string>('ENGAGE_ORGANIZATION_ID') ||
        '7d86919c-9323-4100-bd3e-0937527c1f80').trim();
    const organizationAddress =
      (this.configService.get<string>('ENGAGE_ORGANIZATION_ADDRESS') ||
        '1254120681107680').trim();

    const payload = {
      organization_id: organizationId,
      organization_address: organizationAddress,
      contact_address: phone,
      service: 'whatsapp',
      direction: 'outgoing',
      content: {
        version: '1',
        type: 'data',
        kind: 'template',
        data: {
          name: templateName,
          language: { code: 'en', policy: 'deterministic' },
          components: [
            {
              type: 'body',
              parameters: input.bodyParams.map((text) => ({ type: 'text', text })),
            },
          ],
        },
        text: input.fallbackText,
      },
    };

    const headers = {
      apikey: publishableKey,
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const bodyText = await response.text();
    let result: any = bodyText;
    try {
      result = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      // keep raw text
    }

    if (!response.ok) {
      this.logger.error(
        `Engage WhatsApp failed status=${response.status} phone=${phone} detail=${bodyText}`,
      );
      throw new BadRequestException({
        message: 'Failed to send WhatsApp template via Engage',
        status: response.status,
        detail: result,
      });
    }

    const messageId = Array.isArray(result) ? result[0]?.id : result?.id;
    const delivery = messageId
      ? await this.waitForDelivery(apiUrl, headers, String(messageId), phone)
      : { delivered: false, metaErrorCode: undefined, metaErrorMessage: 'No message id from Engage', status: null };

    if (delivery.delivered) {
      this.logger.log(`WhatsApp delivered phone=${phone} template=${templateName} id=${messageId}`);
    } else {
      this.logger.warn(
        `WhatsApp NOT delivered phone=${phone} template=${templateName} code=${delivery.metaErrorCode} msg=${delivery.metaErrorMessage}`,
      );
    }

    return {
      ok: true,
      delivered: delivery.delivered,
      phone,
      templateName,
      messageId: messageId ? String(messageId) : undefined,
      metaErrorCode: delivery.metaErrorCode,
      metaErrorMessage: delivery.metaErrorMessage,
      result,
      deliveryStatus: delivery.status,
    };
  }

  private async waitForDelivery(
    apiUrl: string,
    headers: Record<string, string>,
    messageId: string,
    phone: string,
  ): Promise<{
    delivered: boolean;
    metaErrorCode?: number;
    metaErrorMessage?: string;
    status: unknown;
  }> {
    let lastStatus: any = null;

    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        const check = await fetch(
          `${apiUrl}?id=eq.${encodeURIComponent(messageId)}&select=id,status,external_id`,
          { method: 'GET', headers },
        );
        const text = await check.text();
        const rows = text ? JSON.parse(text) : [];
        lastStatus = Array.isArray(rows) ? rows[0]?.status : rows?.status;
        if (!lastStatus) continue;

        if (lastStatus.failed || lastStatus.errors?.length) {
          const err = lastStatus.errors?.[0] || {};
          return {
            delivered: false,
            metaErrorCode: err.code,
            metaErrorMessage: err.message || err.title || 'Meta delivery failed',
            status: lastStatus,
          };
        }

        if (lastStatus.delivered || lastStatus.read || lastStatus.played) {
          return { delivered: true, status: lastStatus };
        }

        // accepted/sent without failed — keep polling briefly
        if (lastStatus.sent && !lastStatus.failed) {
          // not final yet; continue unless last attempt
        }
      } catch (e: any) {
        this.logger.warn(`Delivery poll failed phone=${phone} id=${messageId}: ${e?.message || e}`);
      }
    }

    // Accepted by Meta but no delivered webhook yet — treat as not confirmed
    if (lastStatus?.accepted && !lastStatus?.failed) {
      return {
        delivered: false,
        metaErrorMessage:
          'Engage accepted message but Meta delivery not confirmed yet (often Marketing limit 131049 on this number)',
        status: lastStatus,
      };
    }

    return {
      delivered: false,
      metaErrorMessage: 'Delivery status unknown after polling',
      status: lastStatus,
    };
  }

  toWhatsAppContactAddress(rawPhone: string): string {
    const digits = (rawPhone || '').replace(/\D/g, '');
    if (!digits) return '';
    return digits.startsWith('91') ? digits : `91${digits}`;
  }

  private templateName(envKey: string, fallback: string): string {
    return (this.configService.get<string>(envKey) || fallback).trim();
  }

  private sanitizeTemplateText(value: string, max: number): string {
    const cleaned = (value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return (cleaned || '-').slice(0, max);
  }
}
