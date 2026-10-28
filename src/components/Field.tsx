type Props = {
  label: string;
  name: string;
  required?: boolean;
  hint?: React.ReactNode;
  error?: string;
  children: React.ReactNode;
  asGroup?: boolean; // ラジオボタンの組など、label で包めないもの
};

/** 入力欄1つぶん（見出し・説明・エラー） */
export function Field({ label, name, required, hint, error, children, asGroup }: Props) {
  return (
    <div className={`field${error ? " has-error" : ""}`}>
      {asGroup ? (
        <span className="label" id={`${name}-label`}>
          {label}
          {required && <span className="req">必須</span>}
        </span>
      ) : (
        <label htmlFor={name}>
          {label}
          {required && <span className="req">必須</span>}
        </label>
      )}
      {children}
      {hint && <div className="hint">{hint}</div>}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
