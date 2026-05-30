import { supabase } from "@/lib/supabase";
import { readGuestIdFromStorage, getGuestId } from "@/lib/demo-mode";
import { fetchDemoModeConfigClient } from "@/lib/demo-config";

const DEV_SKIP_AUTH = process.env.NEXT_PUBLIC_DEV_SKIP_AUTH === "true";

export async function getAuthHeaders(): Promise<Record<string, string>> {
  // Dev skip auth mode: use a fixed dev user ID
  if (DEV_SKIP_AUTH) {
    return { "X-Guest-Id": "dev-user-local" };
  }

  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (token) return { Authorization: `Bearer ${token}` };
  } catch {}

  const existingGuestId = readGuestIdFromStorage();
  if (existingGuestId) {
    return { "X-Guest-Id": existingGuestId };
  }

  const demoConfig = await fetchDemoModeConfigClient();
  if (demoConfig.active) {
    const guestId = getGuestId();
    if (guestId) return { "X-Guest-Id": guestId };
  }
  return {};
}
