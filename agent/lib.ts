/**
 * Factory for the Sharebite Butler agent. Exported so both the gRPC server
 * (agent/index.ts) and the recommend CLI (agent/cli.ts) can share one definition.
 */

import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { Observability } from '@mastra/observability';
import { OtelExporter } from '@mastra/otel-exporter';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { Store, type DayPlanRecord } from '../ingestion/lib/store.ts';
// Note: Sharebite is the source of truth for placed orders (queried via
// listPlacedOrdersFromSharebite). No local audit log is maintained.
import { SharebiteClient, type OrderItemInput } from '../ingestion/lib/sharebite.ts';

const MEMORY_DB_PATH = resolve(process.cwd(), '.cache', 'memory.db');

const PLACE_ORDER_CONFIRMATION_TOKEN = 'place order';

function maxOverageUsd(): number {
  const raw = process.env.MAX_OVERAGE_USD;
  if (!raw) return 5;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

function ensureCacheDir(path: string) {
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
}

function resolveOtlpTracesEndpoint(): string {
  const raw = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
  try {
    const url = new URL(raw);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/v1/traces';
    }
    return url.toString();
  } catch {
    return `${raw.replace(/\/+$/, '')}/v1/traces`;
  }
}

export const AGENT_INSTRUCTIONS = `
You are Sharebite Butler. The user gets a daily Sharebite lunch allowance and
two restaurant options each weekday. Your job is to pick ONE restaurant per
day and a combination of items from its menu that uses the allowance well,
and — when the user asks — actually place the order on their behalf.

## Tools

Recommendation (read-only):
  - \`get_menu_for_date(date)\` — returns the cached menu for that lunch date:
    the day's allowance, both restaurants with their menu items, and the
    user's previous orders at each restaurant. Each item has a
    \`choice_exist\` flag indicating whether it has modifiers.
  - \`list_available_menu_dates()\` — returns the list of dates whose menu
    data has been cached.
  - \`get_item_modifiers(date, restaurant_id, item_id)\` — fetches the
    MenuChoice/Option list for an item. Call this ONLY when you intend to
    add modifiers to an item you're ordering, or to check whether a
    \`choice_exist:true\` item has REQUIRED modifiers (min_choices > 0).

Ordering:
  - \`dry_run_order(date, restaurant_id, items)\` — calls Sharebite's price
    quote endpoint and returns the full breakdown (subtotal, tax,
    allowance, your out-of-pocket overage, card to be charged). Always call
    this BEFORE proposing an order to the user. It validates the items and
    surfaces the real numbers from Sharebite.
  - \`place_order(date, restaurant_id, items, confirmation)\` — actually
    submits the order to Sharebite. \`confirmation\` MUST equal the literal
    string "${PLACE_ORDER_CONFIRMATION_TOKEN}" or the tool refuses. Use
    only after the user has seen the dry_run breakdown and replied with
    that exact phrase.
  - \`list_placed_orders()\` — returns every currently-active order from
    Sharebite (source of truth — includes orders placed via the Sharebite
    UI, mobile app, or this agent). Sharebite removes cancelled orders
    from this list. Call this whenever the user asks "did I order
    anything?", "what's on the books?", or before cancel_order if they
    didn't pin down a specific date. There is NO way to know from the
    response who/what placed each order — Sharebite doesn't surface that.
  - \`cancel_order(date)\` — cancels a previously-placed order for a
    date. If the user asks to cancel without naming a date, FIRST call
    list_placed_orders to find the active order, then confirm the date
    with the user before calling this.

## Recommendation budget rules (ignore taxes and tips)

  1. HARD CAP: subtotal MUST be ≤ 130% of the allowance.
  2. Pick ONE of these two strategies for each day:
     (a) Single-dish lunch: one main (or main + real side) landing at
         70-100% of budget. Preferred when available.
     (b) Lunch + dinner: TWO meaningfully different dishes totaling
         70-130% of budget. State the dinner pick explicitly.
     Pick (b) whenever the menu lacks a single dish near full-budget price.
  3. NEVER include drinks. No soda, juice, lemonade, water, coffee, tea,
     sparkling water — none. The user keeps drinks at the office.
  4. No padding to reach the allowance.

Value heuristics:
  - Prefer expensive proteins at the same price (salmon > chicken > tofu).
  - Prefer interesting/unique items at similar prices.
  - Add a vegetable-forward side if the main lacks veg.
  - Past-ordered items are positive signal, but avoid the user's most
    recent visit's item — favor variety.

## Order placement flow (when user wants to order)

Step 1 — Build the cart. Pick items per the recommendation rules above.
For each item, decide modifiers:
  - If \`choice_exist:false\`, no modifiers needed.
  - If \`choice_exist:true\`, call \`get_item_modifiers\` to see the choices.
    - If \`min_choices:0\` on all MenuChoice groups, you can omit modifiers
      (the default item is fine) — pass an empty \`option_ids\` array.
    - If any group has \`min_choices > 0\`, you MUST pick that many
      options from that group. Choose sensibly (e.g. for required protein
      choice, pick chicken unless context suggests otherwise).

Step 2 — Always call \`dry_run_order\` first. The response includes the
real subtotal, tax, allowance, and \`you_pay\` (out-of-pocket overage).

Step 3 — Present the order summary to the user in plain prose. The
template MUST include these exact pieces verbatim somewhere in your
response:
  - Restaurant name
  - Each item with its modifier choices and price
  - Subtotal: $X.XX
  - Allowance: -$X.XX  (negative)
  - Tax: $X.XX (paid by employer / out of pocket — pull from the
    \`corporate_bears_taxes\` flag in dry_run output)
  - YOU PAY: $X.XX (to <card nickname>)
  - End with: 'Reply "${PLACE_ORDER_CONFIRMATION_TOKEN}" to confirm.'

Step 4 — Only call \`place_order\` after the user replies with the
literal phrase "${PLACE_ORDER_CONFIRMATION_TOKEN}". Anything else
(silence, "yes", "ok", a question, a modification request) means do NOT
place. If they say something else, treat it as a new turn.

## Overage cap

If \`dry_run_order\` returns a \`you_pay\` value greater than the
configured cap (default $5; check \`max_overage_usd\` in the dry-run
response), DO NOT propose placing the order via the tool. Tell the user
the overage exceeds the cap and suggest they either trim items or place
that order themselves in the Sharebite UI. The place_order tool will
also refuse if called above the cap.

## Cancellation

If the user asks to cancel a placed order, call \`cancel_order(date)\`
and report the result back. Sharebite has an order_cancellation_cutoff_time;
the API will reject too-late cancellations and the tool will surface that.

## Response style for recommendations (no order being placed)

Short, conversational prose — NO JSON, NO code blocks, NO markdown
headers. One sentence naming the restaurant and why, a simple bulleted
list of items with prices, one or two more sentences with reasoning.
Mention modifiers/protein choices in line with each item.

## Money formatting (IMPORTANT)

The chat UI renders Markdown and treats text between two unescaped \`$\`
characters as LaTeX math mode — collapsing all spaces and producing
unreadable output like "\$34.95,andyou'repaying\$4.95". To prevent this,
ALWAYS escape money dollar signs as \\$ in your responses.
  - WRONG: The order total is $34.95 and you pay $4.95.
  - RIGHT: The order total is \\$34.95 and you pay \\$4.95.
This applies everywhere prose mentions a price — bullets, sentences,
order summaries, confirmations, all of it.
`.trim();

// ---------------------------------------------------------------------------
// Read-only menu tools (existing).
// ---------------------------------------------------------------------------

export const getMenuForDateTool = createTool({
  id: 'get_menu_for_date',
  description:
    "Returns the cached Sharebite menu plan for a given lunch date: the day's allowance, both restaurants with their menu sections and items (title, description, price, dietary tags, choice_exist), and the user's previous orders at each restaurant. Returns `{ found: false }` if no menu has been cached for that date.",
  inputSchema: z.object({
    date: z.string().describe('Lunch date in YYYY-MM-DD format'),
  }),
  execute: async (input) => {
    const store = new Store();
    try {
      const plan = await store.getDayPlan(input.date);
      if (!plan) return { found: false, date: input.date };
      return {
        found: true,
        date: plan.date,
        budget_usd: plan.budget,
        restaurants: plan.payload.restaurants.map((r) => ({
          id: r.id,
          name: r.name,
          rating: r.rating,
          cuisines: r.cuisines,
          menu: r.menu_sections.map((s) => ({
            section: s.name,
            items: s.items.map((i) => ({
              id: i.id,
              title: i.title,
              price: i.price,
              about: i.about,
              dietary_tags: i.dietary_tags,
              most_ordered: i.most_ordered,
              choice_exist: i.choice_exist,
            })),
          })),
          your_past_orders_here: r.previous_orders,
        })),
      };
    } finally {
      store.close();
    }
  },
});

export const listAvailableMenuDatesTool = createTool({
  id: 'list_available_menu_dates',
  description:
    'Returns the list of dates (YYYY-MM-DD) for which a Sharebite menu has been cached and is available to recommend on. Sorted ascending. Use this when no specific date was given.',
  inputSchema: z.object({}),
  execute: async () => {
    const store = new Store();
    try {
      const plans = await store.listDayPlans();
      return { dates: plans.map((d) => d.date) };
    } finally {
      store.close();
    }
  },
});

export const getItemModifiersTool = createTool({
  id: 'get_item_modifiers',
  description:
    'Fetches the MenuChoice/Option list (modifiers) for a single menu item from Sharebite. Use only when constructing an order that needs modifiers, or to check whether a `choice_exist:true` item has REQUIRED modifiers (min_choices > 0). Returns groups of choices; each group has min_choices/max_choices and an Option list with id, name, and price delta.',
  inputSchema: z.object({
    date: z.string().describe('Lunch date in YYYY-MM-DD format (used to determine fulfilment_time)'),
    restaurant_id: z.number(),
    item_id: z.number(),
  }),
  execute: async (input) => {
    const store = new Store();
    try {
      const plan = await store.getDayPlan(input.date);
      if (!plan) return { found: false, error: `No menu cached for ${input.date}` };
      const client = new SharebiteClient();
      const detail = await client.getItemDetail(input.item_id, plan.payload.fulfilment_time);
      return {
        found: true,
        item: { id: detail.id, title: detail.title, price: detail.price },
        modifier_groups: detail.MenuChoice.map((mc) => ({
          id: mc.id,
          title: mc.title,
          choice_note: mc.choice_note ?? null,
          min_choices: mc.min_choices,
          max_choices: mc.max_choices,
          options: mc.Option.map((o) => ({
            id: o.id,
            name: o.name,
            price: o.price,
            included: o.included,
          })),
        })),
      };
    } finally {
      store.close();
    }
  },
});

// ---------------------------------------------------------------------------
// Ordering tools.
// ---------------------------------------------------------------------------

const orderItemSchema = z.object({
  id: z.number().describe('Menu item id'),
  quantity: z.number().int().positive().default(1),
  option_ids: z
    .array(z.number())
    .optional()
    .describe(
      'Optional list of MenuChoice.Option IDs to add as modifiers. Each option is added with quantity 1.',
    ),
  instructions: z.string().optional(),
});

function buildOrderItemInputs(
  items: Array<{
    id: number;
    quantity?: number;
    option_ids?: number[];
    instructions?: string;
  }>,
): OrderItemInput[] {
  return items.map((i) => {
    const optionIds = i.option_ids ?? [];
    return {
      id: i.id,
      quantity: i.quantity ?? 1,
      selections: optionIds,
      selection_with_quantity: optionIds.map((id) => ({
        option_id: id,
        option_quantity: 1,
      })),
      instructions: i.instructions ?? '',
    };
  });
}

function findRestaurantInPlan(plan: DayPlanRecord, restaurantId: number) {
  return plan.payload.restaurants.find((r) => r.id === restaurantId);
}

function computeUserPaid(quote: {
  grand_total: number;
  credits_applied?: number;
}): number {
  // grand_total = customer-facing total (corp tax is excluded when
  // corporate_bears_taxes=true). Overage = grand_total - credits.
  // The braintree_purchase `total` field in the captured HAR equals
  // (grand_total - allowance) when no credits — Sharebite subtracts the
  // allowance server-side based on selected_allowance_type.
  // We mirror that: total sent to braintree_purchase = grand_total - allowance.
  // The credits subtraction is left to Sharebite.
  return quote.grand_total - (quote.credits_applied ?? 0);
}

export const dryRunOrderTool = createTool({
  id: 'dry_run_order',
  description:
    "Quotes an order via Sharebite's price endpoint without placing it. Returns the breakdown: subtotal, tax (and who pays), delivery fee, allowance, and the user's out-of-pocket total. Always call this BEFORE proposing an order to the user — it surfaces the real numbers from Sharebite and validates the items.",
  inputSchema: z.object({
    date: z.string().describe('Lunch date in YYYY-MM-DD format'),
    restaurant_id: z.number(),
    items: z.array(orderItemSchema).min(1),
  }),
  execute: async (input) => {
    const store = new Store();
    try {
      const plan = await store.getDayPlan(input.date);
      if (!plan) return { ok: false, error: `No menu cached for ${input.date}` };
      const restaurant = findRestaurantInPlan(plan, input.restaurant_id);
      if (!restaurant) {
        return {
          ok: false,
          error: `Restaurant ${input.restaurant_id} not in cached plan for ${input.date}`,
        };
      }
      const profile = plan.payload.order_profile;
      if (!profile) {
        return {
          ok: false,
          error: `Day plan for ${input.date} predates order-placement support. Re-ingest by running \`bun ingest\` to populate order_profile.`,
        };
      }

      const client = new SharebiteClient();
      const card = await client.getSelectedPaymentMethod();
      const orderItems = buildOrderItemInputs(input.items);

      const quote = await client.getOrderPrices({
        user_id: profile.user_id,
        items: orderItems,
        restaurant_id: input.restaurant_id,
        group_order_slug: plan.group_order_slug,
        future_order_date: plan.payload.fulfilment_time,
        delivery_address: profile.user_address,
        lat: profile.lat,
        lng: profile.lon,
        zip_code: profile.zip_code,
        allowance: plan.budget,
      });

      const userPaid = Math.max(0, computeUserPaid(quote) - plan.budget);
      const cap = maxOverageUsd();

      return {
        ok: true,
        date: input.date,
        restaurant: { id: restaurant.id, name: restaurant.name },
        items: input.items.map((i) => {
          const item = restaurant.menu_sections
            .flatMap((s) => s.items)
            .find((x) => x.id === i.id);
          return {
            id: i.id,
            title: item?.title ?? `(item ${i.id})`,
            quantity: i.quantity,
            base_price: item?.price ?? null,
            option_ids: i.option_ids ?? [],
            instructions: i.instructions ?? '',
          };
        }),
        breakdown: {
          subtotal: quote.subtotal,
          sales_tax: quote.sales_tax,
          corporate_bears_taxes: quote.corporate_bears_taxes,
          delivery_fee: quote.delivery_fee,
          service_fee: quote.service_fee,
          administrative_fee: quote.administrative_fee,
          grand_total: quote.grand_total,
          credits_applied: quote.credits_applied,
          allowance: plan.budget,
          you_pay: userPaid,
        },
        payment: { nickname: card.nickname, expiration_date: card.expiration_date },
        max_overage_usd: cap,
        would_exceed_overage_cap: userPaid > cap,
        estimated_delivery_time: quote.estimated_delivery_time ?? null,
      };
    } finally {
      store.close();
    }
  },
});

export const placeOrderTool = createTool({
  id: 'place_order',
  description: `Places a real Sharebite order. CHARGES THE USER'S SAVED CARD for any overage. Requires \`confirmation\` to equal the literal string "${PLACE_ORDER_CONFIRMATION_TOKEN}" — anything else will be rejected. Refuses if you_pay exceeds MAX_OVERAGE_USD (default $5). Always call \`dry_run_order\` first and surface the breakdown to the user before calling this.`,
  inputSchema: z.object({
    date: z.string(),
    restaurant_id: z.number(),
    items: z.array(orderItemSchema).min(1),
    confirmation: z
      .string()
      .describe(`Must equal the literal string "${PLACE_ORDER_CONFIRMATION_TOKEN}"`),
  }),
  execute: async (input) => {
    if (input.confirmation !== PLACE_ORDER_CONFIRMATION_TOKEN) {
      return {
        ok: false,
        error: `confirmation token mismatch. Must equal "${PLACE_ORDER_CONFIRMATION_TOKEN}" exactly.`,
      };
    }

    const store = new Store();
    try {
      const plan = await store.getDayPlan(input.date);
      if (!plan) return { ok: false, error: `No menu cached for ${input.date}` };
      const restaurant = findRestaurantInPlan(plan, input.restaurant_id);
      if (!restaurant) {
        return {
          ok: false,
          error: `Restaurant ${input.restaurant_id} not in cached plan for ${input.date}`,
        };
      }
      const profile = plan.payload.order_profile;
      if (!profile) {
        return {
          ok: false,
          error: `Day plan for ${input.date} predates order-placement support. Re-ingest with \`bun ingest\`.`,
        };
      }
      const client = new SharebiteClient();
      const existingOrders = await client.listPlacedOrdersFromSharebite();
      const sameDay = existingOrders.find(
        (o) => o.fulfilment_date === input.date && !o.is_cancelled,
      );
      if (sameDay) {
        return {
          ok: false,
          error: `Sharebite already has an active order for ${input.date} (order_no=${sameDay.order_no} at ${sameDay.restaurant_name}, placed ${sameDay.placed_on ?? '?'}). Cancel it before placing another.`,
        };
      }
      const card = await client.getSelectedPaymentMethod();
      const orderItems = buildOrderItemInputs(input.items);

      const quote = await client.getOrderPrices({
        user_id: profile.user_id,
        items: orderItems,
        restaurant_id: input.restaurant_id,
        group_order_slug: plan.group_order_slug,
        future_order_date: plan.payload.fulfilment_time,
        delivery_address: profile.user_address,
        lat: profile.lat,
        lng: profile.lon,
        zip_code: profile.zip_code,
        allowance: plan.budget,
      });

      const userPaid = Math.max(0, computeUserPaid(quote) - plan.budget);
      const cap = maxOverageUsd();
      if (userPaid > cap) {
        return {
          ok: false,
          error: `you_pay $${userPaid.toFixed(2)} exceeds MAX_OVERAGE_USD cap of $${cap.toFixed(2)}. Place this order in the Sharebite UI yourself, or trim items.`,
        };
      }

      const result = await client.placeOrder({
        user_id: profile.user_id,
        items: orderItems,
        restaurant_id: input.restaurant_id,
        group_order_slug: plan.group_order_slug,
        future_order_date: plan.payload.fulfilment_time,
        allowance: plan.budget,
        selected_allowance_type: profile.selected_allowance_type,
        saved_payment_token: card.credit_card_token,
        user_address: profile.user_address,
        user_apt: profile.user_apt,
        user_address_crossstreets: profile.user_address_crossstreets,
        user_place_id: profile.user_place_id,
        user_phone: profile.user_phone,
        city: profile.city,
        state: profile.state,
        zip_code: profile.zip_code,
        lat: profile.lat,
        lon: profile.lon,
        assigned_floor: profile.user_apt,
        product_total: quote.subtotal,
        user_total: userPaid,
        service_fee: quote.service_fee,
        administrative_fee: quote.administrative_fee,
      });

      return {
        ok: true,
        order_no: result.order_no,
        order_id: result.id,
        you_paid: userPaid,
        restaurant_name: restaurant.name,
      };
    } finally {
      store.close();
    }
  },
});

export const listPlacedOrdersTool = createTool({
  id: 'list_placed_orders',
  description:
    "Returns all currently-active orders across upcoming group orders, queried live from Sharebite (source of truth — includes orders placed via the Sharebite UI, not just by this agent). Each record has the lunch date, order_no, restaurant_name, product_total, user_paid (overage), and enable_cancel/cancellation_cutoff_time. Cancelled orders drop out of this list. Use this whenever the user asks 'did I order anything?', 'what's on the books?', or before calling cancel_order without a specific date.",
  inputSchema: z.object({}),
  execute: async () => {
    const client = new SharebiteClient();
    const orders = await client.listPlacedOrdersFromSharebite();
    return {
      orders: orders.map((o) => ({
        date: o.fulfilment_date,
        order_no: o.order_no,
        restaurant_name: o.restaurant_name,
        product_total: o.product_total,
        user_paid: o.user_paid,
        enable_cancel: o.enable_cancel,
        cancellation_cutoff_time: o.cancellation_cutoff_time,
        placed_on: o.placed_on,
        group_order_name: o.group_order_name,
      })),
    };
  },
});

export const cancelOrderTool = createTool({
  id: 'cancel_order',
  description:
    "Cancels a Sharebite order by lunch date. Queries Sharebite live to find the active order for that date, then calls the cancellation endpoint — works regardless of whether the order was placed by this agent or via the Sharebite UI. Sharebite enforces an order_cancellation_cutoff_time and will reject too-late cancellations; the error will be surfaced.",
  inputSchema: z.object({
    date: z.string().describe('Lunch date in YYYY-MM-DD format'),
  }),
  execute: async (input) => {
    const client = new SharebiteClient();
    const orders = await client.listPlacedOrdersFromSharebite();
    const matches = orders.filter((o) => o.fulfilment_date === input.date && !o.is_cancelled);
    if (matches.length === 0) {
      return {
        ok: false,
        error: `No active order found at Sharebite for ${input.date}. Either no order was placed, or it's already been cancelled.`,
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        error: `Multiple active orders for ${input.date} (${matches.map((m) => m.order_no).join(', ')}). Sharebite normally allows only one per group order — refusing to guess which to cancel. Cancel via the UI instead.`,
      };
    }
    const target = matches[0]!;
    if (!target.enable_cancel) {
      return {
        ok: false,
        error: `Sharebite reports order ${target.order_no} for ${input.date} can no longer be cancelled (past cutoff ${target.cancellation_cutoff_time ?? 'unknown'}).`,
      };
    }
    const result = await client.cancelOrder(target.order_id);
    return { ok: true, order_no: result.order_no, date: input.date };
  },
});

export function createAgent() {
  ensureCacheDir(MEMORY_DB_PATH);

  const memory = new Memory({
    storage: new LibSQLStore({
      id: 'memory',
      url: `file:${MEMORY_DB_PATH}`,
    }),
  });

  return new Agent({
    id: 'sharebite-butler',
    name: 'Sharebite Butler',
    instructions: () => {
      const now = new Date();
      const iso = now.toISOString().slice(0, 10);
      const weekday = now.toLocaleDateString('en-US', {
        weekday: 'long',
        timeZone: 'America/Los_Angeles',
      });
      return `Today is ${weekday}, ${iso}. Use this to resolve relative dates like "today", "tomorrow", "next Wednesday" before calling tools.\n\n${AGENT_INSTRUCTIONS}`;
    },
    model: 'anthropic/claude-sonnet-4-5',
    tools: {
      get_menu_for_date: getMenuForDateTool,
      list_available_menu_dates: listAvailableMenuDatesTool,
      get_item_modifiers: getItemModifiersTool,
      dry_run_order: dryRunOrderTool,
      place_order: placeOrderTool,
      list_placed_orders: listPlacedOrdersTool,
      cancel_order: cancelOrderTool,
    },
    memory,
    defaultOptions: {
      tracingOptions: {
        tags: ['astro', 'agent:sharebite-butler'],
        metadata: { agent_id: 'sharebite-butler' },
      },
    },
  });
}

export function createMastra(agent: ReturnType<typeof createAgent>) {
  const observability = new Observability({
    configs: {
      otel: {
        serviceName: 'sharebite-butler',
        exporters: [
          new OtelExporter({
            provider: {
              custom: {
                endpoint: resolveOtlpTracesEndpoint(),
                protocol: 'http/protobuf',
              },
            },
          }),
        ],
      },
    },
  });

  return new Mastra({
    agents: { 'sharebite-butler': agent },
    observability,
  });
}
