import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/** サーバー側（ページ・サーバーアクション）で使う Supabase クライアント。リクエストごとに作る */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // ページの描画中は書き込めない。セッションの更新は middleware が行う
          }
        },
      },
    },
  );
}
