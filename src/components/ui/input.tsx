import type { InputHTMLAttributes } from "react";

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  /** Shown under the field in quiet type — units, formats, why you are asking. */
  hint?: string;
  /** Shown instead of the hint, and marks the field for assistive tech. */
  error?: string;
  /** Targets the field itself; `className` lands on the wrapper so grid spans work. */
  inputClassName?: string;
};

export function Input({ className = "", error, hint, id, inputClassName = "", label, ...props }: InputProps) {
  const inputId = id ?? props.name;
  const noteId = error || hint ? `${inputId}-note` : undefined;
  return (
    <div className={`grid content-start gap-1.5 ${className}`}>
      <label className="text-sm font-bold tracking-tight" htmlFor={inputId}>
        {label}
        {props.required ? <span aria-hidden className="ml-1 text-wayne-red">*</span> : null}
      </label>
      <input
        aria-describedby={noteId}
        aria-invalid={error ? true : undefined}
        className={`min-h-11 rounded-xl border bg-white px-3.5 py-2 font-normal transition placeholder:text-wayne-muted/60
          ${error ? "border-wayne-alert" : "border-wayne-border hover:border-wayne-border-strong"} ${inputClassName}`}
        id={inputId}
        {...props}
      />
      {error || hint ? (
        <p className={`text-xs ${error ? "font-semibold text-wayne-alert" : "text-wayne-muted"}`} id={noteId}>
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}
