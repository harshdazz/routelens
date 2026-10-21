import { z } from "zod";

export const UpdateUser = z.object({
  name: z.string().min(2).optional(),
  email: z.string().email(),
});

export const Order = z.object({
  items: z
    .array(
      z.object({
        sku: z.string().length(8),
        qty: z.number().int().positive(),
      }),
    )
    .nonempty(),
  coupon: z.string().optional(),
  note: z.string().nullish(),
});
