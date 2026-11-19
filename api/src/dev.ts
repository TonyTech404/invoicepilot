// Local development server: the same Hono app on Node, on port 7071 like Functions.
import { serve } from '@hono/node-server';
import { app } from './app.js';

serve({ fetch: app.fetch, port: 7071 }, (info) => console.log(`API on http://localhost:${info.port}/api`));
