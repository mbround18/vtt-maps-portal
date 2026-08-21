import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { authStore } from "@/stores/authStore";
import { mapsStore } from "@/stores/mapsStore";

export function HomePage() {
  const [auth, setAuth] = useState(authStore.state$.value);
  const [maps, setMaps] = useState(mapsStore.state$.value);

  useEffect(() => {
    const sub = authStore.state$.subscribe(setAuth);
    return () => sub.unsubscribe();
  }, []);

  useEffect(() => {
    mapsStore.load().catch(() => undefined);
    const sub = mapsStore.state$.subscribe(setMaps);
    return () => sub.unsubscribe();
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <Card className="border-border/60">
        <CardContent className="flex flex-col gap-6 px-6 pt-2 pb-6">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium uppercase tracking-wide text-primary">Featured Expedition</p>
              {!maps.loading ? <Badge variant="outline">{maps.total} maps and counting</Badge> : null}
            </div>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Step into cinematic worlds built for tabletop stories
            </h2>
            <p className="max-w-2xl text-muted-foreground">
              Explore handcrafted maps with high-resolution previews, tile streaming, and rich metadata.
              Start in the catalog and stay in flow with related-map exploration.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link to="/catalog">Explore Catalog</Link>
            </Button>
            {!auth.authenticated ? (
              <Button asChild variant="outline">
                <Link to="/login">Sign In with Discord</Link>
              </Button>
            ) : null}
            <Button asChild variant="outline">
              <a href="https://ko-fi.com/mbround18" target="_blank" rel="noreferrer noopener">
                Support the Project
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="border-border/60">
          <CardHeader>
            <CardTitle>Explore Depth</CardTitle>
          </CardHeader>
          <CardContent className="px-6 text-sm text-muted-foreground">
            Zoomable map stage, map lore, tags, and related worlds designed to keep exploration momentum high.
          </CardContent>
        </Card>
        <Card className="border-border/60">
          <CardHeader>
            <CardTitle>Creator Friendly</CardTitle>
          </CardHeader>
          <CardContent className="px-6 text-sm text-muted-foreground">
            Asset sync, postprocessing, and metadata controls keep map operations fast and consistent.
          </CardContent>
        </Card>
        <Card className="border-border/60">
          <CardHeader>
            <CardTitle>Privacy &amp; Security</CardTitle>
          </CardHeader>
          <CardContent className="px-6 text-sm text-muted-foreground">
            Account exports, deletion controls, role-based access, and audited admin workflows are built in.
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
