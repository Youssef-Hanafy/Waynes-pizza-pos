import type { InputHTMLAttributes } from "react";

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label: string };

export function Input({ className = "", id, label, ...props }: InputProps) {
  const inputId = id ?? props.name;
  return (
    <label className="grid gap-2 text-sm font-semibold" htmlFor={inputId}>
      {label}
      <input className={`min-h-11 rounded-lg border border-wayne-border bg-white px-3 py-2 font-normal shadow-inner ${className}`} id={inputId} {...props} />
    </label>
  );
}
