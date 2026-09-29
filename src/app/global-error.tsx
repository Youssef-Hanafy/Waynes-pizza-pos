"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="p-8 font-sans">
        <h1>This page is temporarily unavailable.</h1>
        <button onClick={reset} type="button">Try again</button>
      </body>
    </html>
  );
}
