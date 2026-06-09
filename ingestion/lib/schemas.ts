import { z } from 'zod';

// Narrow Sharebite response schemas. Validates only what we actually consume —
// extra fields are tolerated (`.passthrough()` semantics via `z.object` default in zod v3,
// but here we use zod v4 which is strict by default — so we explicitly mark unknowns).
//
// Sharebite has no public contract, so if any of these schemas fail to parse, we want a
// loud error rather than silently passing through a half-broken menu.

const looseObject = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).loose();

export const RestaurantSummarySchema = looseObject({
  id: z.number(),
  name: z.string(),
  cuisines: z.array(z.string()).optional().default([]),
});
export type RestaurantSummary = z.infer<typeof RestaurantSummarySchema>;

export const EmbeddedPlacedOrderSchema = looseObject({
  id: z.number(),
  order_no: z.string(),
  orderer_name: z.string().optional(),
  spent_on: z.string().optional(), // "MM/DD/YYYY HH:MM AM/PM"
  restaurant_name: z.string(),
  order_product_total: z.number(),
  order_total: z.number(),
  order_cc_total: z.number(), // user out-of-pocket overage
  is_order_cancelled: z.boolean(),
  enable_cancel_order: z.boolean(),
  order_cancellation_cutoff_time: z.string().nullable().optional(),
});
export type EmbeddedPlacedOrder = z.infer<typeof EmbeddedPlacedOrderSchema>;

export const GroupOrderSchema = looseObject({
  id: z.number(),
  slug: z.string(),
  name: z.string(),
  restaurants: z.array(RestaurantSummarySchema),
  restaurant_ids: z.array(z.number()),
  fulfilment_time: z.string(), // "YYYY-MM-DD HH:MM:SS"
  order_close_time: z.string(),
  timezone: z.string(),
  is_accepting: z.boolean().optional(),
  // Delivery address fields needed for order placement.
  corporate_address: z.string().optional(),
  cross_street: z.string().nullable().optional(),
  floor: z.string().nullable().optional(),
  // Orders already placed in this group order (any source — agent or UI).
  // Cancelled orders drop out of this array; surviving entries have
  // is_order_cancelled=false by observation.
  orders: z.array(EmbeddedPlacedOrderSchema).optional().default([]),
});
export type GroupOrder = z.infer<typeof GroupOrderSchema>;

export const UserGroupOrdersResponseSchema = looseObject({
  status: z.number(),
  data: z.array(GroupOrderSchema),
});

export const MenuItemSchema = looseObject({
  id: z.number(),
  title: z.string(),
  about: z.string().optional().default(''),
  price: z.number(),
  most_ordered: z.number().optional().default(0),
  dietary_tags: z.array(z.string()).optional().default([]),
  // True iff this item has MenuChoice modifiers. The MenuChoice list itself
  // lives in /restaurants/item_detail/{id}, not in this menu response.
  choice_exist: z.boolean().optional().default(false),
});
export type MenuItem = z.infer<typeof MenuItemSchema>;

export const MenuSectionSchema = looseObject({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable().optional(),
  Item: z.array(MenuItemSchema),
});
export type MenuSection = z.infer<typeof MenuSectionSchema>;

export const MenuResponseSchema = z.array(
  looseObject({
    restaurant_id: z.number(),
    MenuSection: z.array(MenuSectionSchema),
  }),
);

export const PreviousOrderItemSchema = looseObject({
  id: z.number(),
  item_name: z.string(),
  item_price: z.number(),
});
export type PreviousOrderItem = z.infer<typeof PreviousOrderItemSchema>;

export const PreviousOrderItemsResponseSchema = z.array(PreviousOrderItemSchema);

export const AllowanceTypeSchema = looseObject({
  id: z.number(),
  name: z.string(),
});
export type AllowanceType = z.infer<typeof AllowanceTypeSchema>;

export const AllowanceEntrySchema = looseObject({
  id: z.number(),
  name: z.string(),
  day: z.number(),
  allowance: z.number(),
  maximum_applicable_allowance: z.number().optional(),
  types: z.array(AllowanceTypeSchema).optional().default([]),
});
export type AllowanceEntry = z.infer<typeof AllowanceEntrySchema>;

export const CorporateAllowanceResponseSchema = looseObject({
  allowance: z.array(AllowanceEntrySchema),
});

export const SearchRestaurantResultSchema = looseObject({
  id: z.number(),
  rating: z.number().nullable().optional(),
  reviews_count: z.number().nullable().optional(),
  cuisines: z.string().optional(),
  street: z.string().optional(),
  estimated_delivery_time: z.string().optional(),
});
export type SearchRestaurantResult = z.infer<typeof SearchRestaurantResultSchema>;

export const SearchRestaurantResponseSchema = looseObject({
  results: z.array(SearchRestaurantResultSchema),
});

// --- Order placement ---------------------------------------------------------

export const MenuOptionSchema = looseObject({
  id: z.number(),
  name: z.string(),
  price: z.number(),
  description: z.string().nullable().optional(),
  included: z.boolean().optional().default(false),
  min_selection: z.number().optional().default(0),
  max_selection: z.number().optional().default(0),
});
export type MenuOption = z.infer<typeof MenuOptionSchema>;

export const MenuChoiceSchema = looseObject({
  id: z.number(),
  title: z.string(),
  choice_note: z.string().nullable().optional(),
  choices: z.number().optional(),
  min_choices: z.number().optional().default(0),
  max_choices: z.number().optional().default(0),
  Option: z.array(MenuOptionSchema),
});
export type MenuChoice = z.infer<typeof MenuChoiceSchema>;

export const ItemDetailResponseSchema = looseObject({
  id: z.number(),
  title: z.string(),
  price: z.number(),
  pre_selected_price: z.number().optional(),
  MenuChoice: z.array(MenuChoiceSchema).optional().default([]),
});
export type ItemDetail = z.infer<typeof ItemDetailResponseSchema>;

export const UserCreditCardSchema = looseObject({
  id: z.number(),
  credit_card_token: z.string(),
  nickname: z.string(),
  is_selected_card: z.boolean(),
  expiration_date: z.string().nullable().optional(),
});
export type UserCreditCard = z.infer<typeof UserCreditCardSchema>;

export const UserCreditCardsResponseSchema = looseObject({
  results: z.array(UserCreditCardSchema),
});

export const OrderPricesResponseSchema = looseObject({
  subtotal: z.number(),
  sales_tax: z.number(),
  corporate_bears_taxes: z.boolean(),
  delivery_fee: z.number(),
  estimated_delivery_time: z.string().optional(),
  grand_total: z.number(),
  grand_total_without_promo: z.number().optional(),
  credits_applied: z.number().optional().default(0),
  credits_available: z.number().optional().default(0),
  service_fee: z.number().optional().default(0),
  administrative_fee: z.number().optional().default(0),
  tip: z.number().optional().default(0),
});
export type OrderPricesResponse = z.infer<typeof OrderPricesResponseSchema>;

export const ValidateDeliveryAddressResponseSchema = looseObject({
  valid_delivery_address: z.array(z.number()),
});

export const PlacedOrderSchema = looseObject({
  id: z.number(),
  order_no: z.string(),
  restaurant_id: z.number(),
  restaurant_name: z.string(),
  product_total: z.number(),
  tax: z.number(),
  total: z.number(),
  transaction_id: z.string().nullable().optional(),
});
export type PlacedOrder = z.infer<typeof PlacedOrderSchema>;

export const BraintreePurchaseResponseSchema = looseObject({
  msg: z.string(),
  order: PlacedOrderSchema,
});

export const CancelOrderResponseSchema = looseObject({
  id: z.number(),
  order_no: z.string(),
});

// --- User profile ------------------------------------------------------------

export const LoginStatusResponseSchema = looseObject({
  user: looseObject({
    id: z.number(),
    preferred_phone_num: z.string().nullable().optional(),
  }),
});

export const AddressComponentSchema = looseObject({
  long_name: z.string(),
  short_name: z.string(),
  types: z.array(z.string()),
});
export type AddressComponent = z.infer<typeof AddressComponentSchema>;

export const GeocodeResultSchema = looseObject({
  place_id: z.string(),
  formatted_address: z.string().optional(),
  address_components: z.array(AddressComponentSchema),
  geometry: looseObject({
    location: looseObject({
      lat: z.number(),
      lng: z.number(),
    }),
  }),
});
export type GeocodeResult = z.infer<typeof GeocodeResultSchema>;

export const GeocodeResponseSchema = looseObject({
  data: looseObject({
    results: z.array(GeocodeResultSchema),
  }),
});
