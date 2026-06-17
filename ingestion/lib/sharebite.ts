import {
  BraintreePurchaseResponseSchema,
  CancelOrderResponseSchema,
  CorporateAllowanceResponseSchema,
  GeocodeResponseSchema,
  ItemDetailResponseSchema,
  LoginStatusResponseSchema,
  MenuResponseSchema,
  OrderPricesResponseSchema,
  PreviousOrderItemsResponseSchema,
  SearchRestaurantResponseSchema,
  UserCreditCardsResponseSchema,
  UserGroupOrdersResponseSchema,
  ValidateDeliveryAddressResponseSchema,
  type AllowanceEntry,
  type GroupOrder,
  type ItemDetail,
  type MenuSection,
  type PreviousOrderItem,
  type SearchRestaurantResult,
  type UserCreditCard,
  type OrderPricesResponse,
} from './schemas.ts';

const ORIGIN = 'https://postman.sharebite.com';

// Pretend to be the browser we copied the cookie from. Sharebite hasn't been
// observed enforcing UA, but sending a normal Chrome UA is cheap insurance
// against future bot heuristics.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

export interface ClientOptions {
  sessionId?: string;
  csrfToken?: string;
  /**
   * IANA timezone sent to Sharebite to resolve menu windows, delivery cutoffs
   * and allowance day boundaries. Should match the user's Sharebite office.
   * Defaults to SHAREBITE_TIMEZONE, then the runtime's local timezone.
   */
  timezone?: string;
}

export interface GeocodedAddress {
  latitude: number;
  longitude: number;
  place_id: string;
  formatted_address: string;
  city: string;
  state: string;
  zip_code: string;
}

export interface OrderItemInput {
  id: number;
  quantity: number;
  // Flat array of selected option IDs from MenuChoice.Option[].id
  selections: number[];
  // Per-option quantity, in lockstep with `selections`
  selection_with_quantity: Array<{ option_id: number; option_quantity: number }>;
  instructions?: string;
}

export interface PriceQuoteInput {
  user_id: number;
  items: OrderItemInput[];
  restaurant_id: number;
  group_order_slug: string;
  future_order_date: string;
  delivery_address: string;
  lat: number;
  lng: number;
  zip_code: string;
  allowance: number;
}

export interface PlaceOrderInput {
  user_id: number;
  items: OrderItemInput[];
  restaurant_id: number;
  group_order_slug: string;
  future_order_date: string;
  allowance: number;
  selected_allowance_type: number;
  saved_payment_token: string;
  // User profile
  user_address: string;
  user_apt: string;
  user_address_crossstreets: string;
  user_place_id: string;
  user_phone: string;
  city: string;
  state: string;
  zip_code: string;
  lat: number;
  lon: number;
  assigned_floor: string;
  // From order_prices quote
  product_total: number;
  user_total: number; // out-of-pocket overage
  service_fee: number;
  administrative_fee: number;
}

export class SharebiteClient {
  private readonly sessionId: string;
  private readonly csrfToken: string | undefined;
  private readonly timezone: string;

  constructor(opts: ClientOptions = {}) {
    const sessionId = opts.sessionId ?? process.env.SHAREBITE_SESSION_COOKIE;
    if (!sessionId) {
      throw new Error(
        'SHAREBITE_SESSION_COOKIE is not set. Open https://postman.sharebite.com ' +
          'in Chrome, sign in, then DevTools → Application → Cookies → copy the ' +
          '`sessionid` value into SHAREBITE_SESSION_COOKIE.',
      );
    }
    this.sessionId = sessionId;
    // Optional. Required only for endpoints Sharebite protects with Django CSRF
    // middleware (e.g. cancel_group_order_order). When set, the token is sent
    // BOTH in the `Cookie` header (as `csrftoken=...`) and the `X-CSRFToken`
    // request header — Django's double-submit cookie check requires both.
    this.csrfToken = opts.csrfToken ?? process.env.SHAREBITE_CSRF_TOKEN;
    this.timezone =
      opts.timezone ??
      process.env.SHAREBITE_TIMEZONE ??
      Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  async connect(): Promise<void> {
    await this.assertAuthed();
  }

  async disconnect(): Promise<void> {}

  // --- Read endpoints --------------------------------------------------------

  async getUserGroupOrders(): Promise<GroupOrder[]> {
    const raw = await this.fetchJson(`/api/v1/grouporder/user_grouporders/`);
    const parsed = UserGroupOrdersResponseSchema.parse(raw);
    return parsed.data;
  }

  // Returns all currently-placed orders across upcoming group orders. Source
  // of truth, regardless of who placed (agent, Sharebite UI, etc.). Cancelled
  // orders are excluded by Sharebite — they drop out of the list entirely
  // once cancelled (verified 2026-06-08 HAR).
  async listPlacedOrdersFromSharebite(): Promise<
    Array<{
      fulfilment_date: string; // "YYYY-MM-DD"
      group_order_name: string;
      group_order_slug: string;
      order_id: number;
      order_no: string;
      restaurant_name: string;
      product_total: number;
      user_paid: number;
      is_cancelled: boolean;
      enable_cancel: boolean;
      cancellation_cutoff_time: string | null;
      placed_on: string | null;
    }>
  > {
    const groups = await this.getUserGroupOrders();
    const out = [] as Awaited<ReturnType<SharebiteClient['listPlacedOrdersFromSharebite']>>;
    for (const g of groups) {
      const date = g.fulfilment_time.split(' ')[0]!;
      for (const o of g.orders ?? []) {
        out.push({
          fulfilment_date: date,
          group_order_name: g.name,
          group_order_slug: g.slug,
          order_id: o.id,
          order_no: o.order_no,
          restaurant_name: o.restaurant_name,
          product_total: o.order_product_total,
          user_paid: o.order_cc_total,
          is_cancelled: o.is_order_cancelled,
          enable_cancel: o.enable_cancel_order,
          cancellation_cutoff_time: o.order_cancellation_cutoff_time ?? null,
          placed_on: o.spent_on ?? null,
        });
      }
    }
    out.sort((a, b) => a.fulfilment_date.localeCompare(b.fulfilment_date));
    return out;
  }

  async searchRestaurants(args: {
    groupOrderSlug: string;
    restaurantIds: number[];
    latitude: number;
    longitude: number;
  }): Promise<SearchRestaurantResult[]> {
    const body = {
      sortby: 'best_match',
      sort_order: 'asc',
      page_num: 1,
      page_size: 20,
      delivery_status: 1,
      latitude: args.latitude,
      longitude: args.longitude,
      restaurant_ids: args.restaurantIds.join(','),
      timezone: this.timezone,
      restaurant_type: 'GROUP_ORDER',
      group_order_slug: args.groupOrderSlug,
    };
    const raw = await this.fetchJson(`/api/v1/restaurants/search_restaurant/`, {
      method: 'POST',
      body,
    });
    const parsed = SearchRestaurantResponseSchema.parse(raw);
    return parsed.results;
  }

  async getMenu(restaurantId: number, futureOrderDate: string): Promise<MenuSection[]> {
    const qs = new URLSearchParams({
      restaurant_id: String(restaurantId),
      delivery_status: '1',
      future_order_date: futureOrderDate,
      timezone: this.timezone,
    });
    const raw = await this.fetchJson(`/api/v1/restaurants/menu/?${qs}`);
    const parsed = MenuResponseSchema.parse(raw);
    return parsed[0]?.MenuSection ?? [];
  }

  async getItemDetail(itemId: number, futureOrderDate: string): Promise<ItemDetail> {
    const qs = new URLSearchParams({
      timezone: this.timezone,
      future_order_time: futureOrderDate,
    });
    const raw = await this.fetchJson(`/api/v1/restaurants/item_detail/${itemId}?${qs}`);
    return ItemDetailResponseSchema.parse(raw);
  }

  async getUserPreviousOrderItems(
    restaurantId: number,
    futureOrderDate: string,
  ): Promise<PreviousOrderItem[]> {
    const qs = new URLSearchParams({
      delivery_status: '1',
      future_order_date: futureOrderDate,
    });
    const raw = await this.fetchJson(
      `/api/v1/users/user_previous_order_items/${restaurantId}/?${qs}`,
    );
    return PreviousOrderItemsResponseSchema.parse(raw);
  }

  async getCorporateAllowance(args: {
    userId: number;
    groupOrderSlug: string;
    futureOrderDate: string;
  }): Promise<AllowanceEntry[]> {
    const qs = new URLSearchParams({
      user_id: String(args.userId),
      timezone: this.timezone,
      future_order_date: args.futureOrderDate,
      group_order: args.groupOrderSlug,
    });
    const raw = await this.fetchJson(`/api/v1/users/corporate_allowance?${qs}`);
    return CorporateAllowanceResponseSchema.parse(raw).allowance;
  }

  async getUserProfile(): Promise<{ id: number; preferred_phone_num: string }> {
    const raw = await this.fetchJson(
      `/api/v1/users/login_status?timezone=${encodeURIComponent(this.timezone)}`,
    );
    const parsed = LoginStatusResponseSchema.parse(raw);
    const phone = parsed.user.preferred_phone_num;
    if (!phone) {
      throw new Error(
        'No preferred_phone_num on login_status response. Set a delivery phone ' +
          'in the Sharebite UI before placing orders.',
      );
    }
    return { id: parsed.user.id, preferred_phone_num: phone };
  }

  async getUserId(): Promise<number> {
    return (await this.getUserProfile()).id;
  }

  async getSavedPaymentMethods(): Promise<UserCreditCard[]> {
    const raw = await this.fetchJson(`/api/v1/users/usercreditcards/`);
    return UserCreditCardsResponseSchema.parse(raw).results;
  }

  async getSelectedPaymentMethod(): Promise<UserCreditCard> {
    const cards = await this.getSavedPaymentMethods();
    const selected = cards.find((c) => c.is_selected_card);
    if (!selected) {
      throw new Error(
        `No selected payment method on file. Found ${cards.length} card(s) but ` +
          `none with is_selected_card=true. Visit Sharebite → Account → ` +
          `Payment Methods and mark one as default.`,
      );
    }
    return selected;
  }

  async getGeocodedAddress(address: string): Promise<GeocodedAddress> {
    const qs = new URLSearchParams({ address });
    const raw = await this.fetchJson(`/api/v1/restaurants/get_latlng_from_address/?${qs}`);
    const parsed = GeocodeResponseSchema.parse(raw);
    const r = parsed.data.results[0];
    if (!r) {
      throw new Error(`No geocode result for "${address}"`);
    }
    const findShort = (type: string) =>
      r.address_components.find((c) => c.types.includes(type))?.short_name ?? '';
    const findLong = (type: string) =>
      r.address_components.find((c) => c.types.includes(type))?.long_name ?? '';
    return {
      latitude: r.geometry.location.lat,
      longitude: r.geometry.location.lng,
      place_id: r.place_id,
      formatted_address: r.formatted_address ?? address,
      city: findLong('locality'),
      state: findShort('administrative_area_level_1'),
      zip_code: findLong('postal_code'),
    };
  }

  // Back-compat wrapper. Prefer getGeocodedAddress for new code.
  async getLatLngFromAddress(address: string): Promise<{ latitude: number; longitude: number }> {
    const geo = await this.getGeocodedAddress(address);
    return { latitude: geo.latitude, longitude: geo.longitude };
  }

  // --- Order endpoints -------------------------------------------------------

  async validateDeliveryAddress(args: {
    address: string;
    restaurantId: number;
  }): Promise<boolean> {
    const raw = await this.fetchJson(`/api/v1/orders/validate_delivery_address/`, {
      method: 'POST',
      body: { address: args.address, restaurant: args.restaurantId },
    });
    const parsed = ValidateDeliveryAddressResponseSchema.parse(raw);
    return parsed.valid_delivery_address.includes(args.restaurantId);
  }

  async getOrderPrices(args: PriceQuoteInput): Promise<OrderPricesResponse> {
    const body = {
      user: args.user_id,
      items: args.items.map((i) => ({
        id: i.id,
        selections: i.selections,
        selection_with_quantity: i.selection_with_quantity,
        quantity: i.quantity,
        instructions: i.instructions ?? '',
      })),
      is_delivery: true,
      restaurant_id: String(args.restaurant_id),
      lat: args.lat,
      lng: args.lng,
      delivery_address: args.delivery_address,
      future_order_date: args.future_order_date,
      use_credit: false,
      tip_percentage: '0.0000',
      tip: '0.0000',
      is_group_order: true,
      group_order_slug: args.group_order_slug,
      zip_code: args.zip_code,
      credits_used: 0,
      allowance: args.allowance,
    };
    const raw = await this.fetchJson(`/api/v1/orders/order_prices/`, {
      method: 'POST',
      body,
    });
    return OrderPricesResponseSchema.parse(raw);
  }

  async placeOrder(args: PlaceOrderInput): Promise<{ id: number; order_no: string }> {
    const body = {
      item_list: args.items.map((i) => ({
        id: i.id,
        selections: i.selections,
        selection_with_quantity: i.selection_with_quantity,
        quantity: i.quantity,
        instructions: i.instructions ?? '',
      })),
      restaurant_id: args.restaurant_id,
      tip: '0.00',
      user_place_id: args.user_place_id,
      user_address: args.user_address,
      user_apt: args.user_apt,
      user_address_crossstreets: args.user_address_crossstreets,
      city: args.city,
      zip_code: args.zip_code,
      lat: args.lat,
      lon: args.lon,
      state: args.state,
      pickup_location: '',
      is_cafeteria_delivery: false,
      user_phone: args.user_phone,
      instructions: '',
      saved_payment_token: args.saved_payment_token,
      total: args.user_total,
      order_type: 1,
      meal_sharers: [args.user_id],
      meal_allowances: [args.allowance],
      expense_code: [''],
      meal_billables: '',
      is_future_order: true,
      future_order_date: args.future_order_date,
      order_note: '',
      is_firm_order: true,
      totalPages: 1,
      floor: '',
      headcount: 0,
      total_budget: '0.00',
      secondary_contacts: [],
      selected_allowance_type: args.selected_allowance_type,
      product_total: args.product_total,
      is_group_order: true,
      group_order_slug: args.group_order_slug,
      catering_host_details: {},
      credits: 0,
      timezone: this.timezone,
      service_fee: args.service_fee,
      administrative_fee: args.administrative_fee,
      skip_utensils: true,
      override_department: {},
      override_legal_entity: {},
      allowance: args.allowance,
      assigned_floor: args.assigned_floor,
      should_override_preferred_phone: true,
    };
    const raw = await this.fetchJson(`/api/v1/orders/braintree_purchase`, {
      method: 'POST',
      body,
    });
    const parsed = BraintreePurchaseResponseSchema.parse(raw);
    if (!parsed.msg.toLowerCase().includes('success')) {
      throw new Error(`braintree_purchase non-success: ${parsed.msg}`);
    }
    return { id: parsed.order.id, order_no: parsed.order.order_no };
  }

  async cancelOrder(orderId: number): Promise<{ order_no: string }> {
    const raw = await this.fetchJson(
      `/api/v1/users/cancel_group_order_order/${orderId}`,
      { method: 'POST', body: {} },
    );
    const parsed = CancelOrderResponseSchema.parse(raw);
    return { order_no: parsed.order_no };
  }

  // --- Transport -------------------------------------------------------------

  private async fetchJson(
    path: string,
    opts: { method?: 'GET' | 'POST'; body?: unknown } = {},
  ): Promise<unknown> {
    const method = opts.method ?? 'GET';
    const url = `${ORIGIN}${path}`;

    const cookieParts = [`sessionid=${this.sessionId}`];
    if (this.csrfToken) cookieParts.push(`csrftoken=${this.csrfToken}`);
    const headers: Record<string, string> = {
      cookie: cookieParts.join('; '),
      accept: 'application/json, text/plain, */*',
      origin: ORIGIN,
      referer: `${ORIGIN}/`,
      'user-agent': USER_AGENT,
    };
    if (this.csrfToken && method === 'POST') {
      headers['x-csrftoken'] = this.csrfToken;
    }
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    const res = await fetch(url, init);
    const text = await res.text();
    const contentType = res.headers.get('content-type') ?? '';
    const looksHtml = text.trimStart().startsWith('<') || contentType.includes('text/html');

    if (res.status === 401) {
      throw new Error(
        `Sharebite ${method} ${path} returned 401. Your sessionid cookie has ` +
          `expired — refresh SHAREBITE_SESSION_COOKIE from Chrome.`,
      );
    }
    if (res.status === 403) {
      // Two failure modes return 403:
      //   1. sessionid expired → Sharebite returns JSON {"detail":"..."}
      //   2. CSRF middleware rejects the request → Sharebite serves the SPA
      //      HTML on 403. This is the signal that we need a CSRF token.
      if (looksHtml) {
        const hint = this.csrfToken
          ? `Your SHAREBITE_CSRF_TOKEN may be stale — refresh it from Chrome DevTools → Application → Cookies → csrftoken.`
          : `This endpoint requires CSRF protection. Set SHAREBITE_CSRF_TOKEN from your Chrome cookies (DevTools → Application → Cookies → csrftoken).`;
        throw new Error(
          `Sharebite ${method} ${path} returned 403 with HTML body — CSRF check failed. ${hint}`,
        );
      }
      throw new Error(
        `Sharebite ${method} ${path} returned 403: ${text.slice(0, 300)}`,
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `Sharebite ${method} ${path} failed: HTTP ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Sharebite ${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }

  private async assertAuthed(): Promise<void> {
    const raw = (await this.fetchJson(`/api/v1/users/is_session_valid`)) as {
      is_session_valid?: boolean;
    };
    if (!raw?.is_session_valid) {
      throw new Error(
        'Sharebite session is not authenticated. The cookie has likely expired — ' +
          'copy a fresh `sessionid` from Chrome DevTools → Application → Cookies and ' +
          'update SHAREBITE_SESSION_COOKIE.',
      );
    }
  }
}
