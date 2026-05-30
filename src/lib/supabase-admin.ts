import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const DEV_SKIP_AUTH = process.env.DEV_SKIP_AUTH === "true";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Admin client for server-side operations (bypasses RLS)
// Will throw at runtime if env vars are missing when actually used
function createAdminClient(): SupabaseClient<Database> {
  if (DEV_SKIP_AUTH) {
    // Return a proxy that silently no-ops on any call
    return new Proxy({} as SupabaseClient<Database>, {
      get(_target, prop) {
        if (prop === "auth") {
          return {
            getUser: () => Promise.resolve({ data: { user: null }, error: null }),
          };
        }
        // For any other property (like .from()), return a chainable no-op
        return () => new Proxy({}, {
          get: (_t: unknown, p: string) => {
            if (p === "select" || p === "eq" || p === "gte" || p === "order" || p === "limit" || p === "maybeSingle" || p === "single") {
              return () => Promise.resolve({ data: null, error: null });
            }
            return () => Promise.resolve({ data: null, error: null });
          },
        });
      },
    });
  }
  return createClient<Database>(supabaseUrl, serviceRoleKey);
}

export const supabaseAdmin = createAdminClient();

export function ensureAdminClient() {
  if (DEV_SKIP_AUTH) return;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY. Get it from Supabase Dashboard > Settings > API > service_role key"
    );
  }
}
