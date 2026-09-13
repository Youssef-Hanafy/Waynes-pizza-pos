import { cloneElement, isValidElement, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean;
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost" | "brand";
  size?: "sm" | "md" | "lg";
};

const styles = {
  /* Red is the press-me colour and is used for nothing else. */
  primary: "bg-wayne-red text-white shadow-sm hover:bg-wayne-red-dark",
  /* Green is the brand: sign in, back to the board, anything structural. */
  brand: "bg-wayne-green text-white shadow-sm hover:bg-wayne-green-dark",
  secondary: "border border-wayne-border bg-white text-wayne-ink shadow-sm hover:border-wayne-border-strong hover:bg-wayne-cream",
  danger: "bg-wayne-alert text-white shadow-sm hover:bg-wayne-red-dark",
  ghost: "text-wayne-ink hover:bg-wayne-cream-deep",
};

/* A cashier hits these with a thumb, so even the small one clears the 44px target. */
const sizes = {
  sm: "min-h-11 px-4 py-2 text-sm",
  md: "min-h-11 px-5 py-2.5 text-sm",
  lg: "min-h-14 px-7 py-3 text-base",
};

export function Button({ asChild = false, children, className = "", size = "md", variant = "primary", ...props }: ButtonProps) {
  const classes = `inline-flex items-center justify-center gap-2 rounded-xl font-bold tracking-tight transition
    active:translate-y-px disabled:pointer-events-none disabled:opacity-50
    ${sizes[size]} ${styles[variant]} ${className}`;

  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<{ className?: string }>;
    return cloneElement(child, { className: `${classes} ${child.props.className ?? ""}` });
  }

  return <button className={classes} {...props}>{children}</button>;
}
