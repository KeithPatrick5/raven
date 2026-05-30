"use client";

import { useMemo, useState } from "react";

type RunResultClientProps = {
  rawJson: string;
};

export default function RunResultClient({ rawJson }: RunResultClientProps) {
  const [copied, setCopied] = useState(false);
  const prettyJson = useMemo(() => rawJson, [rawJson]);

  async function copyRawJson() {
    try {
      await navigator.clipboard.writeText(prettyJson);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="panel readable-panel raw-json-panel">
      <div className="panel-header">
        <div>
          <div className="panel-title">Raw JSON</div>
          <div className="panel-meta">For ChatGPT/debugging. The readable summary above is the operator version.</div>
        </div>
        <button className="badge blue button-reset" type="button" onClick={copyRawJson}>{copied ? "Copied" : "Copy JSON"}</button>
      </div>
      <details>
        <summary>Show raw run data</summary>
        <pre className="readable-copy-block raw-json-copy">{prettyJson}</pre>
      </details>
    </section>
  );
}
