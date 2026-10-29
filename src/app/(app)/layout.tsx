import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { signOut } from "@/app/login/actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <Link href="/" className="app-title">
            セレッジ管理
          </Link>
          <nav className="app-nav" aria-label="メニュー">
            <Link href="/companies">企業・契約</Link>
            <Link href="/billing">今月の請求</Link>
          </nav>
          <div className="app-user">
            <span>
              {user.displayName ?? user.email}
              {user.role === "viewer" && <span className="badge" style={{ marginLeft: 6 }}>閲覧のみ</span>}
            </span>
            <form action={signOut}>
              <button type="submit" className="btn btn-quiet">
                ログアウト
              </button>
            </form>
          </div>
        </div>
      </header>
      {user.role === "pending" ? (
        <main className="page">
          <div className="card">
            <h1>承認待ちです</h1>
            <p className="lead">
              アカウントはできていますが、まだ管理者が使える範囲を決めていません。管理者に連絡してください。
            </p>
          </div>
        </main>
      ) : (
        children
      )}
    </>
  );
}
