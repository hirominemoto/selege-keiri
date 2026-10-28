"use client";

import { startTransition } from "react";

/**
 * サーバーアクションを送るフォーム。
 * React 19 の <form action> は送信後に入力欄を空に戻すため、入力ミスで保存できなかったときに
 * 打った内容が消えてしまう。ここでは送信を自分で行い、入力内容を残す。
 */
export function ActionForm({
  action,
  className,
  children,
}: {
  action: (fd: FormData) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <form
      className={className}
      onSubmit={(ev) => {
        ev.preventDefault();
        const fd = new FormData(ev.currentTarget);
        startTransition(() => action(fd));
      }}
      noValidate
    >
      {children}
    </form>
  );
}
