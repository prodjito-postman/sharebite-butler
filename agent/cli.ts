/**
 * Recommend CLI: reads cached week from sqlite, asks the agent for one
 * recommendation per weekday, prints to stdout.
 *
 * Usage:
 *   bun recommend                # all cached days
 *   bun recommend 2026-05-22     # a single day
 */

import { z } from 'zod';
import { createAgent, localToday } from './lib.ts';
import { Store, type DayPlanRecord } from '../ingestion/lib/store.ts';

const recommendationSchema = z.object({
  restaurant_id: z.number(),
  restaurant_name: z.string(),
  items: z.array(
    z.object({
      title: z.string(),
      price: z.number(),
      notes: z.string().nullable(),
    }),
  ),
  subtotal: z.number(),
  budget: z.number(),
  vs_budget: z.enum(['under', 'at', 'over']),
  reasoning: z.string(),
});

type AgentRecommendation = z.infer<typeof recommendationSchema>;

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function buildUserMessage(date: string, priorPicks: string[]): string {
  const lines = [
    `Plan lunch for ${formatDate(date)} (${date}).`,
    `Call \`get_menu_for_date("${date}")\` to fetch the menu and allowance, then recommend.`,
  ];
  if (priorPicks.length > 0) {
    lines.push(
      `Earlier this week you've already recommended: ${priorPicks.join(', ')}. Avoid repeating the same restaurant back-to-back.`,
    );
  }
  return lines.join('\n');
}

function validateRecommendation(rec: AgentRecommendation, day: DayPlanRecord): string | null {
  const itemsSum = rec.items.reduce((s, i) => s + i.price, 0);
  if (Math.abs(itemsSum - rec.subtotal) > 0.01) {
    return `Item prices sum to $${itemsSum.toFixed(2)} but \`subtotal\` is $${rec.subtotal.toFixed(2)}. These must match exactly.`;
  }
  const cap = day.budget * 1.30;
  if (rec.subtotal > cap + 0.01) {
    return `Subtotal $${rec.subtotal.toFixed(2)} exceeds 130% of the $${day.budget.toFixed(2)} budget (cap is $${cap.toFixed(2)}). Drop or swap items until the order fits under the cap.`;
  }
  return null;
}

const RULE = '─'.repeat(60);

function printRecommendation(day: DayPlanRecord, rec: AgentRecommendation | null, rawText: string) {
  console.log();
  console.log(RULE);
  console.log(` ${formatDate(day.date)}  ·  ${day.date}  ·  budget $${day.budget.toFixed(2)}`);
  console.log(RULE);

  if (!rec) {
    console.log('  (could not parse agent output — raw response below)');
    console.log();
    console.log(rawText);
    return;
  }

  const alt = day.payload.restaurants.find((r) => r.id !== rec.restaurant_id);
  const altLabel = alt ? ` (vs ${alt.name})` : '';
  console.log(`  Pick: ${rec.restaurant_name}${altLabel}`);
  for (const item of rec.items) {
    const notes = item.notes ? `  — ${item.notes}` : '';
    console.log(`    • ${item.title.padEnd(34)} $${item.price.toFixed(2)}${notes}`);
  }
  const tag =
    rec.vs_budget === 'over'
      ? `over by $${(rec.subtotal - rec.budget).toFixed(2)}`
      : rec.vs_budget === 'under'
        ? `under by $${(rec.budget - rec.subtotal).toFixed(2)}`
        : 'at budget';
  console.log(`    Total: $${rec.subtotal.toFixed(2)}  (${tag})`);
  console.log();
  console.log(`  Why: ${rec.reasoning}`);
}

async function main() {
  const filterDate = process.argv[2];

  const store = new Store();
  let days = await store.listDayPlans();
  store.close();

  if (filterDate) {
    days = days.filter((d) => d.date === filterDate);
  } else {
    // Hide already-past days (Sharebite's API can return them briefly).
    const today = localToday();
    days = days.filter((d) => d.date >= today);
  }

  if (days.length === 0) {
    console.error('No cached days to recommend. Run `bun ingest` first.');
    process.exit(1);
  }

  const agent = createAgent();
  const priorPicks: string[] = [];

  const MAX_RETRIES = 2;
  const runId = Date.now();

  for (const day of days) {
    const memoryOpts = {
      memory: { thread: `recommend-${day.date}-${runId}`, resource: 'patrick' },
    };
    let msg = buildUserMessage(day.date, priorPicks);
    let rec: AgentRecommendation | null = null;
    let text = '';

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const result = await agent.generate(msg, {
        ...memoryOpts,
        structuredOutput: { schema: recommendationSchema },
      });
      text = (result as { text?: string }).text ?? '';
      rec = ((result as { object?: AgentRecommendation }).object) ?? null;
      if (!rec) break;

      const err = validateRecommendation(rec, day);
      if (!err) break;

      if (attempt === MAX_RETRIES) {
        console.error(`[recommend] ${day.date}: still invalid after ${MAX_RETRIES} retries — ${err}`);
        break;
      }
      console.error(`[recommend] ${day.date}: retry ${attempt + 1} — ${err}`);
      msg = `Your previous recommendation was invalid: ${err}\n\nRevise it using the same menu data from the get_menu_for_date tool call earlier in this conversation. Drop or swap items so the order fits under the cap.`;
    }

    printRecommendation(day, rec, text);
    if (rec) priorPicks.push(rec.restaurant_name);
  }

  console.log();
}

main().catch((err) => {
  console.error('[recommend] fatal:', err);
  process.exit(1);
});
