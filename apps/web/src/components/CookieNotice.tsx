import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "vttmaps.cookie_consent";
const COOKIE_KEY = "vttmaps_cookie_consent";

function setConsent(value: "granted" | "denied") {
  localStorage.setItem(STORAGE_KEY, value);
  document.cookie = `${COOKIE_KEY}=${value}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
}

export function CookieNotice() {
  const [consent, setState] = useState<string | null>(null);

  useEffect(() => {
    setState(localStorage.getItem(STORAGE_KEY));
  }, []);

  if (consent) return null;

  return (
    <aside className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-xl flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-lg sm:flex-row sm:items-center sm:justify-between">
      <div>
        <strong className="text-sm font-semibold">Cookie Notice</strong>
        <p className="mt-1 text-sm text-muted-foreground">
          We use essential cookies plus optional analytics cookies for map engagement metrics.
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setConsent("denied");
            setState("denied");
          }}
        >
          Essential Only
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setConsent("granted");
            setState("granted");
          }}
        >
          Accept Analytics
        </Button>
      </div>
    </aside>
  );
}
