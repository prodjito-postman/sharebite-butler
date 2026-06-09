/**
 * Ingestion entry: pull this week's Sharebite menu data and persist to Redis.
 *
 * Prereqs:
 *   1. Sign into postman.sharebite.com in any Chrome window.
 *   2. DevTools → Application → Cookies → copy the `sessionid` value.
 *   3. Set SHAREBITE_SESSION_COOKIE in .env (or export it), then: bun ingest
 */

import { SharebiteClient } from '../lib/sharebite.ts';
import {
  Store,
  type DayPlanPayload,
  type OrderProfile,
  type RestaurantPayload,
} from '../lib/store.ts';
import type { GroupOrder } from '../lib/schemas.ts';

const log = (msg: string, extra?: Record<string, unknown>) => {
  const suffix = extra ? ' ' + JSON.stringify(extra) : '';
  console.log(`[ingest] ${msg}${suffix}`);
};

function dateKey(fulfilmentTime: string): string {
  return fulfilmentTime.split(' ')[0]!;
}

function dayOfWeek(fulfilmentTime: string): number {
  // Sharebite's corporate_allowance.day appears to use Mon=0..Sun=6
  // (day:4 in the captured HAR = Friday 2026-05-22).
  // Map JS dow (Sun=0..Sat=6) into that.
  const d = new Date(fulfilmentTime.replace(' ', 'T'));
  const js = d.getDay();
  return (js + 6) % 7;
}

async function ingestDay(
  client: SharebiteClient,
  store: Store,
  go: GroupOrder,
  userProfile: { id: number; preferred_phone_num: string },
): Promise<void> {
  const date = dateKey(go.fulfilment_time);
  log(`day=${date} group=${go.name} restaurants=${go.restaurant_ids.length}`);

  const addr = go.corporate_address;
  if (!addr) throw new Error(`Group order ${go.id} missing corporate_address`);
  const geo = await client.getGeocodedAddress(addr);

  const search = await client.searchRestaurants({
    groupOrderSlug: go.slug,
    restaurantIds: go.restaurant_ids,
    latitude: geo.latitude,
    longitude: geo.longitude,
  });
  const ratingById = new Map(search.map((r) => [r.id, r.rating ?? null]));

  const restaurants: RestaurantPayload[] = [];
  for (const r of go.restaurants) {
    log(`  fetching menu for ${r.name} (id=${r.id})`);
    const [sections, history] = await Promise.all([
      client.getMenu(r.id, go.fulfilment_time),
      client.getUserPreviousOrderItems(r.id, go.fulfilment_time).catch((err) => {
        log(`  previous orders failed for ${r.name}, continuing without`, { err: String(err) });
        return [];
      }),
    ]);

    restaurants.push({
      id: r.id,
      name: r.name,
      rating: ratingById.get(r.id) ?? null,
      cuisines: r.cuisines ?? [],
      menu_sections: sections.map((s) => ({
        name: s.name,
        description: s.description ?? null,
        items: s.Item.map((i) => ({
          id: i.id,
          title: i.title,
          about: i.about ?? '',
          price: i.price,
          dietary_tags: i.dietary_tags ?? [],
          most_ordered: (i.most_ordered ?? 0) > 0,
          choice_exist: i.choice_exist ?? false,
        })),
      })),
      previous_orders: history.map((h) => ({
        item_name: h.item_name,
        item_price: h.item_price,
      })),
    });
  }

  const allowances = await client.getCorporateAllowance({
    userId: userProfile.id,
    groupOrderSlug: go.slug,
    futureOrderDate: go.fulfilment_time,
  });
  const dow = dayOfWeek(go.fulfilment_time);
  const matched = allowances.find((a) => a.day === dow) ?? allowances[0];
  const budget = matched?.maximum_applicable_allowance ?? matched?.allowance;
  if (typeof budget !== 'number') {
    throw new Error(
      `No allowance returned for ${date} (${go.slug}); refusing to guess. ` +
        `Raw allowances=${JSON.stringify(allowances).slice(0, 300)}`,
    );
  }
  const allowanceType = matched?.types?.[0]?.id;
  if (typeof allowanceType !== 'number') {
    throw new Error(
      `No allowance type id (types[0].id) for ${date}. Order placement requires ` +
        `selected_allowance_type. Raw matched allowance entry: ${JSON.stringify(matched).slice(0, 300)}`,
    );
  }

  const orderProfile: OrderProfile = {
    user_id: userProfile.id,
    user_phone: userProfile.preferred_phone_num,
    user_address: addr,
    user_apt: go.floor ?? '',
    user_address_crossstreets: go.cross_street ?? '',
    user_place_id: geo.place_id,
    city: geo.city,
    state: geo.state,
    zip_code: geo.zip_code,
    lat: geo.latitude,
    lon: geo.longitude,
    selected_allowance_type: allowanceType,
  };

  const payload: DayPlanPayload = {
    fulfilment_time: go.fulfilment_time,
    restaurants,
    order_profile: orderProfile,
  };

  await store.upsertDayPlan({
    date,
    group_order_slug: go.slug,
    group_order_name: go.name,
    budget,
    fetched_at: Date.now(),
    payload,
  });

  log(`  stored day=${date} budget=$${budget.toFixed(2)} allowance_type=${allowanceType}`);
}

async function main() {
  log('starting');
  const client = new SharebiteClient();
  const store = new Store();
  try {
    await client.connect();
    log('session valid');

    const userProfile = await client.getUserProfile();
    log(`user_id=${userProfile.id} phone=${userProfile.preferred_phone_num}`);

    const groupOrders = await client.getUserGroupOrders();
    log(`found ${groupOrders.length} upcoming group order(s)`);

    if (groupOrders.length === 0) {
      log('nothing to ingest — Sharebite returned no upcoming group orders');
      return;
    }

    for (const go of groupOrders) {
      try {
        await ingestDay(client, store, go, userProfile);
      } catch (err) {
        log(`day failed: ${go.name} (${dateKey(go.fulfilment_time)})`, { err: String(err) });
      }
    }

    log('done');
  } finally {
    await client.disconnect();
    store.close();
  }
}

main().catch((err) => {
  console.error('[ingest] fatal:', err);
  process.exit(1);
});
