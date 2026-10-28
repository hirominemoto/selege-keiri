import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type Role = "admin" | "viewer" | "pending";

export type CurrentUser = {
  id: string;
  email: string | null;
  displayName: string | null;
  role: Role;
};

/** ログイン中の利用者と役割。未ログインならログイン画面へ */
export async function requireUser(): Promise<CurrentUser> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("email, display_name, role")
    .eq("id", user.id)
    .maybeSingle();

  return {
    id: user.id,
    email: profile?.email ?? user.email ?? null,
    displayName: profile?.display_name ?? null,
    role: (profile?.role as Role) ?? "pending",
  };
}

/** 入力・変更ができる人か確かめる（サーバーアクション用） */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== "admin") {
    throw new Error("この操作は管理者だけができます");
  }
  return user;
}
