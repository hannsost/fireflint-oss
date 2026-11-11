import { useState } from "react";
import { UiIcon } from "./Brand";

/** Small clipboard button with a brief "copied" confirmation. */
export function CopyButton({ text, label = "Kopieren" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable — ignore */
        }
      }}
    >
      {copied ? <><UiIcon name="check" size={16} />Kopiert</> : label}
    </button>
  );
}
