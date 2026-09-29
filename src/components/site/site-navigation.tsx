"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { SiteIcon } from "./site-icon";

export function SiteNavigation({ social }: { social?: ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  return (
    <>
      <nav className="desktop-nav" aria-label="Main navigation">
        {[
          { href: "/menu", label: "Menu" },
          { href: "/offers", label: "Offers" },
          { href: "/rewards", label: "My rewards" },
          { href: "/contact", label: "Visit us" },
        ].map((link) => (
          <Link
            key={link.href}
            href={link.href}
            aria-current={path === link.href ? "page" : undefined}
          >
            {link.label}
          </Link>
        ))}
      </nav>
      <Link href="/menu#cart" className="header-cart"><SiteIcon name="bag" size={19} /><span>Cart</span></Link>
      <Link className="order-button header-order" href="/menu">
        <SiteIcon name="bag" size={18} /> Order now{" "}
        <SiteIcon name="arrow" size={17} />
      </Link>
      <button
        className="mobile-nav-toggle"
        type="button"
        aria-expanded={open}
        aria-controls="mobile-navigation"
        aria-label={open ? "Close navigation" : "Open navigation"}
        onClick={() => setOpen(!open)}
      >
        <SiteIcon name={open ? "close" : "menu"} />
      </button>
      {open && (
        <nav
          id="mobile-navigation"
          className="mobile-navigation"
          aria-label="Mobile navigation"
        >
          {[
            { href: "/menu", label: "Menu" },
            { href: "/offers", label: "Offers" },
            { href: "/rewards", label: "My rewards" },
            { href: "/contact", label: "Hours & location" },
          ].map((link) => (
            <Link
              key={link.href}
              onClick={() => setOpen(false)}
              href={link.href}
            >
              {link.label}
              <SiteIcon name="arrow" />
            </Link>
          ))}
          {social}
        </nav>
      )}
    </>
  );
}
