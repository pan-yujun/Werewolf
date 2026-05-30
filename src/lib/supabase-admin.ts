import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const DEV_SKIP_AUTH = process.env.DEV_SKIP_AUTH === "true";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Create a chainable no-op proxy for dev mode
function createNoopProxy(): SupabaseClient<Database> {
  const chainable: Record<string, unknown> = {};

  // Create a proxy that returns itself for any property access (method chaining)
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === "auth") {
        return {
          getUser: () => Promise.resolve({ data: { user: null }, error: null }),
        };
      }
      if (prop === "from") {
        // Return a function that returns the chainable proxy
        return () => new Proxy(chainable, handler);
      }
      // For any other property (insert, select, eq, update, single, etc.), return a function that returns a promise or the proxy itself
      return (...args: unknown[]) => {
        // Terminal methods that should return a promise
        const terminalMethods = ["single", "maybeSingle"];
        if (terminalMethods.includes(prop as string)) {
          // Return a mock ID for insert operations
          return Promise.resolve({ data: { id: `dev-session-${Date.now()}` }, error: null });
        }
        // For non-terminal methods, return the proxy for further chaining
        return new Proxy(chainable, handler);
      };
    },
  };

  return new Proxy({} as SupabaseClient<Database>, handler);
}

// Admin client for server-side operations (bypasses RLS)
// Will throw at runtime if env vars are missing when actually used
function createAdminClient(): SupabaseClient<Database> {
  if (DEV_SKIP_AUTH) {
    return createNoopProxy();
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
