/**
 * sharebite-butler - gRPC entry point.
 *
 * Builds the agent via the shared factory and serves it through the Astro
 * messaging adapter. For terminal recommendations, use `bun recommend`
 * (agent/cli.ts) instead — it reuses the same factory without standing up
 * the gRPC server.
 *
 * Environment variables (automatically injected by `ast project start`):
 *   ANTHROPIC_API_KEY - from `models.anthropic` in astropods.yml
 *   REDIS_HOST / REDIS_PORT - from `knowledge.cache` (redis)
 *   GRPC_SERVER_ADDR - from the Astro messaging service
 */

import { serve } from '@astropods/adapter-mastra';
import { createAgent, createMastra } from './lib.ts';

const agent = createAgent();

// Instantiate Mastra so it registers agents/observability plugins at startup.
createMastra(agent);

serve(agent);
