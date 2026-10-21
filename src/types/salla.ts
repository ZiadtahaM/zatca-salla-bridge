import { z } from 'zod';

export const SallaItemAmountSchema = z.object({
  amount: z.number(),
  currency: z.string().default('SAR')
});

export const SallaOrderItemSchema = z.object({
  id: z.number().or(z.string()),
  name: z.string(),
  sku: z.string().optional().nullable(),
  quantity: z.number().int().positive(),
  price: SallaItemAmountSchema,
  total: SallaItemAmountSchema,
  tax: z
    .object({
      amount: SallaItemAmountSchema,
      percent: z.number().default(15)
    })
    .optional()
    .nullable()
});

export const SallaCustomerSchema = z.object({
  id: z.number().or(z.string()),
  first_name: z.string(),
  last_name: z.string().optional().nullable(),
  mobile: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  company_name: z.string().optional().nullable(),
  tax_number: z.string().optional().nullable()
});

export const SallaAddressSchema = z.object({
  country: z.string().default('SA'),
  city: z.string().default('Riyadh'),
  district: z.string().optional().nullable(),
  street: z.string().optional().nullable(),
  postal_code: z.string().optional().nullable(),
  building_number: z.string().optional().nullable()
});

export const SallaOrderDataSchema = z.object({
  id: z.number().or(z.string()),
  reference_id: z.number().or(z.string()).optional().nullable(),
  date: z.object({
    date: z.string(),
    timezone: z.string()
  }),
  status: z.object({
    id: z.number().or(z.string()),
    name: z.string(),
    slug: z.string()
  }),
  payment_method: z.string().default('credit_card'),
  currency: z.string().default('SAR'),
  amounts: z.object({
    sub_total: SallaItemAmountSchema,
    shipping_cost: SallaItemAmountSchema.optional().nullable(),
    cash_on_delivery: SallaItemAmountSchema.optional().nullable(),
    discounts: SallaItemAmountSchema.optional().nullable(),
    tax: z.object({
      amount: SallaItemAmountSchema,
      percent: z.number().default(15)
    }),
    total: SallaItemAmountSchema
  }),
  customer: SallaCustomerSchema,
  shipping: z
    .object({
      address: SallaAddressSchema.optional().nullable()
    })
    .optional()
    .nullable(),
  items: z.array(SallaOrderItemSchema),
  notes: z.string().optional().nullable()
});

export const SallaSubscriptionDataSchema = z.object({
  plan_name: z.string().optional().default('standard'),
  status: z.string().optional().default('active'),
  expires_at: z.string().optional().nullable()
}).passthrough();

export const SallaWebhookPayloadSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('order.created'),
    merchant: z.number().or(z.string()),
    created_at: z.string(),
    data: SallaOrderDataSchema
  }),
  z.object({
    event: z.literal('order.updated'),
    merchant: z.number().or(z.string()),
    created_at: z.string(),
    data: SallaOrderDataSchema
  }),
  z.object({
    event: z.literal('order.refunded'),
    merchant: z.number().or(z.string()),
    created_at: z.string(),
    data: SallaOrderDataSchema
  }),
  z.object({
    event: z.literal('order.cancelled'),
    merchant: z.number().or(z.string()),
    created_at: z.string(),
    data: SallaOrderDataSchema
  }),
  z.object({
    event: z.literal('app.subscription.started'),
    merchant: z.number().or(z.string()),
    created_at: z.string(),
    data: SallaSubscriptionDataSchema
  }),
  z.object({
    event: z.literal('app.subscription.renewed'),
    merchant: z.number().or(z.string()),
    created_at: z.string(),
    data: SallaSubscriptionDataSchema
  }),
  z.object({
    event: z.literal('app.subscription.expired'),
    merchant: z.number().or(z.string()),
    created_at: z.string(),
    data: SallaSubscriptionDataSchema
  }),
  z.object({
    event: z.literal('app.subscription.canceled'),
    merchant: z.number().or(z.string()),
    created_at: z.string(),
    data: SallaSubscriptionDataSchema
  }),
  z.object({
    event: z.literal('app.uninstalled'),
    merchant: z.number().or(z.string()),
    created_at: z.string(),
    data: SallaSubscriptionDataSchema
  })
]);

export type SallaWebhookPayload = z.infer<typeof SallaWebhookPayloadSchema>;
export type SallaOrderData = z.infer<typeof SallaOrderDataSchema>;
export type SallaOrderItem = z.infer<typeof SallaOrderItemSchema>;
