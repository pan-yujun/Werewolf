import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const DEV_SKIP_AUTH = process.env.NEXT_PUBLIC_DEV_SKIP_AUTH === "true";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
// Support both standard anon key and publishable key naming
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

if (!DEV_SKIP_AUTH && (!supabaseUrl || !supabaseAnonKey)) {
  throw new Error(
    "Missing Supabase env vars: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY)"
  );
}

// In dev skip auth mode, create a mock client that won't make real requests
function createSupabaseClient(): SupabaseClient<Database> {
  if (DEV_SKIP_AUTH) {
    // Return a proxy that silently no-ops on any call
    return new Proxy({} as SupabaseClient<Database>, {
      get(_target, prop) {
        if (prop === "auth") {
          return {
            getSession: () => Promise.resolve({ data: { session: null }, error: null }),
            getUser: () => Promise.resolve({ data: { user: null }, error: null }),
            signOut: () => Promise.resolve({ error: null }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
          };
        }
        // For any other property (like .from()), return a chainable no-op
        return () => new Proxy({}, {
          get: () => () => Promise.resolve({ data: null, error: null }),
        });
      },
    });
  }
  return createClient<Database>(supabaseUrl!, supabaseAnonKey!);
}

export const supabase = createSupabaseClient();
