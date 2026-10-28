import Link from "next/link";

const menus = [
  {
    num: "1",
    title: "企業・契約",
    desc: "取引先の宛名と、契約ごとの金額・回数を登録します",
    href: "/companies",
    ready: true,
  },
  {
    num: "2",
    title: "今月の請求",
    desc: "請求する内容を確認して確定し、請求書を作ります",
    href: "/billing",
    ready: false,
  },
  {
    num: "3",
    title: "支払い",
    desc: "受け取った請求書を登録して、総務に支払いを依頼します",
    href: "/payables",
    ready: false,
  },
  {
    num: "4",
    title: "売上・収支を見る",
    desc: "入金・未入金と、月ごとの収支を確かめます",
    href: "/summary",
    ready: false,
  },
];

export default function HomePage() {
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>セレッジ管理システム</h1>
          <p className="lead">やりたいことを選んでください</p>
        </div>
      </div>
      <div className="menu-grid">
        {menus.map((m) =>
          m.ready ? (
            <Link key={m.num} href={m.href} className="menu-card">
              <div className="num">{m.num}</div>
              <div className="title">{m.title}</div>
              <p className="desc">{m.desc}</p>
            </Link>
          ) : (
            <div key={m.num} className="menu-card is-soon" aria-disabled="true">
              <div className="num">
                {m.num} <span className="badge">準備中</span>
              </div>
              <div className="title">{m.title}</div>
              <p className="desc">{m.desc}</p>
            </div>
          ),
        )}
      </div>
    </main>
  );
}
