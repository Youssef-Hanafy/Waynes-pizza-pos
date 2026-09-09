import { cloneElement, isValidElement, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean;
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger";
};

const styles = {
  primary: "bg-wayne-red text-white hover:bg-wayne-red-dark",
  secondary: "border border-wayne-border bg-white text-wayne-ink hover:bg-wayne-cream",
  danger: "bg-red-700 text-white hover:bg-red-800"
};

export function Button({ asChild = false, children, className = "", variant = "primary", ...props }: ButtonProps) {
  const classes = `inline-flex min-h-11 items-center justify-center rounded-lg px-5 py-2.5 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant]} ${className}`;

  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<{ className?: string }>;
    return cloneElement(child, { className: `${classes} ${child.props.className ?? ""}` });
  }

  return <button className={classes} {...props}>{children}</button>;
}
