"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function UnlockPage() {
  const [accessKey, setAccessKey] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const router = useRouter();

  function getNextPath() {
    if (typeof window === "undefined") return "/";
    return new URLSearchParams(window.location.search).get("next") || "/";
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    const response = await fetch("/api/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey })
    });

    if (!response.ok) {
      setError("Wrong Raven passcode.");
      setIsSubmitting(false);
      return;
    }

    router.replace(getNextPath());
  }

  return (
    <main className="unlock-page">
      <section className="unlock-card">
        <div className="mark">R</div>
        <h1>Unlock Raven</h1>
        <p className="signal-copy">Private scanner dashboard. Enter the passcode set in Vercel.</p>
        <form className="unlock-form" onSubmit={submit}>
          <input
            className="unlock-input"
            type="password"
            autoFocus
            placeholder="Raven passcode"
            value={accessKey}
            onChange={(event) => setAccessKey(event.target.value)}
          />
          <button className="button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Checking..." : "Enter Raven"}
          </button>
          <div className="error">{error}</div>
        </form>
      </section>
    </main>
  );
}
