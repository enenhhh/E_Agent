import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env['E_AGENT_DATABASE_URL'] ?? './data/e-agent.db',
  },
});
