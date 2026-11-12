import { defineConfig } from "@neon/config/v1";

// Postgres is included in every Neon project; there is no top-level postgres
// toggle. DATABASE_URL (pooled) and DATABASE_URL_UNPOOLED are pulled by deploy.
// The app retains its existing server-side admin authentication; it does not
// need Neon Auth, a public Data API, Functions, or an extra storage service.
export default defineConfig({
  auth: false,
  branch: (branch) => {
    // Never assign an expiry to production, even on first-time setup.
    if (branch.name === "production" || branch.isDefault) return {};
    if (!branch.exists) return { ttl: "7d" };
    return {};
  },
});
