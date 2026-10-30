import Link from "next/link";

const menus = [
  {
    num: "1",
    title: "請求の入力",
    desc: "請求の内容を入れます。1回の入力が1枚の請求書になります",
    href: "/bills",
    ready: true,
  },
  {
    num: "2",
    title: "Excelに書き込む",
    desc: "入力した請求を、社内申込書・売上表・収支一覧に書き込みます",
    href: "/excel",
    ready: false,
  },
  {
    num: "3",
    title: "企業・契約",
    desc: "取引先の宛名と、契約ごとの金額・回数を登録します",
    href: "/companies",
    ready: true,
  },
  {
    num: "4",
    title: "請求状況（お試し版）",
    desc: "契約ごとに、どの月まで請求したかを確かめます",
    href: "/billing",
    ready: true,
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
