import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    // Product DB (control plane + Better Auth). The compose stack creates it;
    // override for other environments.
    url: process.env.DATABASE_URL ?? "postgres://dev:dev@localhost:5432/product",
  },
  strict: true,
  verbose: true,
});
