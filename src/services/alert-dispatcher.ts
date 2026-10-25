export type AlertType = 'B2B_HOLD' | 'DLQ_FAILURE' | 'CSID_EXPIRING' | 'ZATCA_REVOKED';

export interface MerchantAlertPayload {
  merchantId: string;
  alertType: AlertType;
  title: string;
  message: string;
  orderId?: string;
  actionUrl?: string;
  metadata?: Record<string, any>;
}

export interface AlertDispatchResult {
  sent: boolean;
  destination: string;
  status: string;
}

export async function dispatchMerchantAlert(
  payload: MerchantAlertPayload
): Promise<AlertDispatchResult> {
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;

  const nowIso = new Date().toISOString();
  const formattedMessage = [
    `[ZATCA Alert: ${payload.alertType}]`,
    `Store: ${payload.merchantId}`,
    `Subject: ${payload.title}`,
    `Details: ${payload.message}`,
    payload.orderId ? `Order ID: ${payload.orderId}` : '',
    payload.actionUrl ? `Action Link: ${payload.actionUrl}` : '',
    `Timestamp: ${nowIso}`
  ].filter(Boolean).join('\n');

  // 1. Direct Telegram Bot Dispatch if configured
  if (telegramBotToken && telegramChatId) {
    try {
      const telegramEndpoint = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
      const res = await fetch(telegramEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegramChatId,
          text: formattedMessage,
          parse_mode: 'HTML'
        }),
        signal: AbortSignal.timeout(5000)
      });
      return {
        sent: res.ok,
        destination: 'telegram',
        status: res.ok ? 'delivered' : `http_${res.status}`
      };
    } catch (err: any) {
      return {
        sent: false,
        destination: 'telegram',
        status: `error: ${err.message || String(err)}`
      };
    }
  }

  // 2. Generic Outbound Webhook Dispatch (WhatsApp Gateway / Slack / Custom ERP)
  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'ZATCA-Salla-Alert-Dispatcher/1.0'
        },
        body: JSON.stringify({
          event: 'zatca.alert',
          alert: payload,
          text: formattedMessage,
          timestamp: nowIso
        }),
        signal: AbortSignal.timeout(5000)
      });
      return {
        sent: res.ok,
        destination: 'webhook',
        status: res.ok ? 'delivered' : `http_${res.status}`
      };
    } catch (err: any) {
      return {
        sent: false,
        destination: 'webhook',
        status: `error: ${err.message || String(err)}`
      };
    }
  }

  // If no external push endpoint is configured, log cleanly and return recorded status
  return {
    sent: false,
    destination: 'internal_log',
    status: 'unconfigured_destination'
  };
}
