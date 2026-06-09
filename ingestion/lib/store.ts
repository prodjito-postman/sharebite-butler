import { RedisClient } from 'bun';

const DAYPLAN_PREFIX = 'dayplan:';

export interface DayPlanRecord {
  date: string; // "YYYY-MM-DD"
  group_order_slug: string;
  group_order_name: string;
  budget: number;
  fetched_at: number; // unix ms
  payload: DayPlanPayload;
}

export interface RestaurantPayload {
  id: number;
  name: string;
  rating: number | null;
  cuisines: string[];
  menu_sections: Array<{
    name: string;
    description: string | null;
    items: Array<{
      id: number;
      title: string;
      about: string;
      price: number;
      dietary_tags: string[];
      most_ordered: boolean;
      // True iff this item has modifiers (MenuChoice). To get the actual
      // option list, call SharebiteClient.getItemDetail(item_id).
      choice_exist: boolean;
    }>;
  }>;
  previous_orders: Array<{ item_name: string; item_price: number }>;
}

// Profile fields needed to place an order. Captured during ingestion so the
// agent doesn't have to re-fetch on every order. The payment token is NOT
// stored here — it's fetched fresh at order time so it never goes stale.
export interface OrderProfile {
  user_id: number;
  user_phone: string;
  user_address: string;
  user_apt: string;
  user_address_crossstreets: string;
  user_place_id: string;
  city: string;
  state: string;
  zip_code: string;
  lat: number;
  lon: number;
  selected_allowance_type: number;
}

export interface DayPlanPayload {
  fulfilment_time: string;
  restaurants: RestaurantPayload[];
  // Optional for backwards compatibility with pre-order-placement records.
  // Newly-ingested records always populate this.
  order_profile?: OrderProfile;
}

let _client: RedisClient | null = null;

function resolveRedisUrl(): string {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  if (process.env.REDIS_HOST && process.env.REDIS_PORT) {
    return `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`;
  }
  // Local-dev default: the Astropods Redis container exposes 6379 to the host
  // while `ast project start` is running. If Astropods isn't up, this will
  // fail with ECONNREFUSED — that's the intended signal to start it.
  return 'redis://localhost:6379';
}

function getClient(): RedisClient {
  if (!_client) {
    _client = new RedisClient(resolveRedisUrl());
  }
  return _client;
}

export class Store {
  // Kept as a class for call-site compatibility. Holds no per-instance state;
  // the Redis client is a module-level singleton bound to REDIS_URL.

  close(): void {
    // No-op: the singleton lives for the process lifetime.
  }

  async upsertDayPlan(rec: DayPlanRecord): Promise<void> {
    await getClient().set(DAYPLAN_PREFIX + rec.date, JSON.stringify(rec));
  }

  async listDayPlans(): Promise<DayPlanRecord[]> {
    const keys = await getClient().keys(DAYPLAN_PREFIX + '*');
    if (keys.length === 0) return [];
    const values = await getClient().mget(...keys);
    const records: DayPlanRecord[] = [];
    for (const v of values) {
      if (v) records.push(JSON.parse(v));
    }
    records.sort((a, b) => a.date.localeCompare(b.date));
    return records;
  }

  async getDayPlan(date: string): Promise<DayPlanRecord | null> {
    const raw = await getClient().get(DAYPLAN_PREFIX + date);
    return raw ? JSON.parse(raw) : null;
  }
}
