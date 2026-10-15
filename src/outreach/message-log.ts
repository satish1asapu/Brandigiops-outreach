import { MessageKind } from './outreach.enums';
import { MessageLogEntry } from './schemas/outreach-link.schema';
import { SendBusinessReviewWhatsAppResult } from './whatsapp.service';

export function buildMessageLog(
  kind: MessageKind,
  result?: SendBusinessReviewWhatsAppResult,
  error?: any,
): MessageLogEntry {
  if (!result) {
    const detail = error?.response ?? error?.message ?? error;
    return {
      kind,
      accepted: false,
      delivered: false,
      error: typeof detail === 'string' ? detail : JSON.stringify(detail),
      at: new Date(),
    };
  }

  return {
    kind,
    templateName: result.templateName,
    phone: result.phone,
    messageId: result.messageId,
    accepted: true,
    delivered: result.delivered,
    metaErrorCode: result.metaErrorCode,
    metaErrorMessage: result.metaErrorMessage,
    at: new Date(),
  };
}
