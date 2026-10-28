"use client";

import { useActionState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { signIn } from "./actions";

export default function LoginPage() {
  const [state, action, pending] = useActionState(signIn, {});
  return (
    <main className="login">
      <div className="card">
        <h1>セレッジ管理システム</h1>
        <p className="lead" style={{ marginBottom: 20 }}>
          請求・支払・収支の管理
        </p>
        <ActionForm action={action} className="form">
          <div className="field">
            <label htmlFor="email">メールアドレス</label>
            <input id="email" name="email" type="email" autoComplete="username" required />
          </div>
          <div className="field">
            <label htmlFor="password">パスワード</label>
            <input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          {state.message && <p className="notice notice-error">{state.message}</p>}
          <button className="btn" type="submit" disabled={pending}>
            {pending ? "確認しています…" : "ログイン"}
          </button>
        </ActionForm>
        <p className="small muted" style={{ marginTop: 16, marginBottom: 0 }}>
          アカウントは管理者が発行します。パスワードを忘れたときは管理者に連絡してください。
        </p>
      </div>
    </main>
  );
}
