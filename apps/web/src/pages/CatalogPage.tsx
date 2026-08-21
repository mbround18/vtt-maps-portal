import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import { mapsStore } from "../stores/mapsStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function CatalogPage() {
  const [q, setQ] = useState("");
  const [selectedTag, setSelectedTag] = useState<string>("all");
  const [state, setState] = useState(mapsStore.state$.value);

  useEffect(() => {
    mapsStore.load().catch(console.error);
    const sub = mapsStore.state$.subscribe(setState);
    return () => {
      sub.unsubscribe();
    };
  }, []);

  useEffect(() => {
    mapsStore.setQuery(q);
  }, [q]);

  const tags = useMemo(() => {
    const set = new Set<string>();
    state.maps.forEach((map) => (map.tags ?? []).forEach((tag) => set.add(tag)));
    return ["all", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [state.maps]);

  const maps = useMemo(() => {
    if (selectedTag === "all") return state.filtered;
    return state.filtered.filter((map) => (map.tags ?? []).some((tag) => tag === selectedTag));
  }, [selectedTag, state.filtered]);

  const onCardMove = (event: MouseEvent<HTMLElement>) => {
    const el = event.currentTarget;
    const rect = el.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    el.style.setProperty("--mx", `${x.toFixed(2)}%`);
    el.style.setProperty("--my", `${y.toFixed(2)}%`);
  };

  const onCardLeave = (event: MouseEvent<HTMLElement>) => {
    const el = event.currentTarget;
    el.style.removeProperty("--mx");
    el.style.removeProperty("--my");
  };

  return (
    <div className="flex flex-col gap-6">
      <Card className="border-border/60">
        <CardContent className="flex flex-col gap-4 px-6 pt-2 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium uppercase tracking-wide text-primary">Archive of Realms</p>
            <h2 className="text-2xl font-semibold tracking-tight">Find your next battleground</h2>
            <p className="max-w-2xl text-muted-foreground">
              Discover curated maps by environment, mood, and story potential. Explore first, then jump straight
              into detail without losing momentum.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Badge variant="secondary">{maps.length} shown</Badge>
            <Badge variant="outline">{state.total} total</Badge>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <Card className="h-fit border-border/60">
          <CardHeader>
            <CardTitle>Refine</CardTitle>
            <CardDescription>Filter by title, path, and tags.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 px-6">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="catalog-search">Search</Label>
              <Input
                id="catalog-search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search maps by name or path"
                aria-label="Search maps"
              />
            </div>
            <div className="flex flex-wrap gap-2" role="list">
              {tags.map((tag) => (
                <Button
                  key={tag}
                  size="sm"
                  variant={selectedTag === tag ? "default" : "outline"}
                  onClick={() => setSelectedTag(tag)}
                >
                  {tag === "all" ? "All" : tag}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          {state.loading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : null}

          {!state.loading && maps.length === 0 ? (
            <Card className="border-border/60">
              <CardContent className="px-6 py-8 text-center text-muted-foreground">
                No maps matched this search and tag combination.
              </CardContent>
            </Card>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {maps.map((map) => (
              <Card
                className={cn(
                  "group overflow-hidden border-border/60 py-0 transition-shadow hover:shadow-lg"
                )}
                key={map.id}
                onMouseMove={onCardMove}
                onMouseLeave={onCardLeave}
              >
                <div className="relative aspect-video overflow-hidden bg-muted">
                  {map.thumb_url ? (
                    <img
                      src={map.thumb_url}
                      alt={map.name}
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                  ) : (
                    <div className="h-full w-full" />
                  )}
                  <div className="absolute inset-0 flex items-center justify-center gap-2 bg-background/70 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
                    <Button asChild size="sm">
                      <Link to={`/maps/${encodeURIComponent(map.id)}`}>Explore Map</Link>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <Link to={`/maps/${encodeURIComponent(map.id)}?mode=preview`}>Preview</Link>
                    </Button>
                  </div>
                </div>
                <CardContent className="flex flex-col gap-2 px-4 pb-4">
                  <h3 className="font-heading text-base font-medium leading-snug">{map.name}</h3>
                  <p className="truncate text-sm text-muted-foreground">{map.path}</p>
                  {(map.tags ?? []).length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {(map.tags ?? []).slice(0, 4).map((tag) => (
                        <Badge variant="outline" key={`${map.id}-${tag}`}>
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between pt-1">
                    <span className="font-mono text-xs text-muted-foreground">{map.id.slice(0, 8)}</span>
                    <Button asChild size="sm" variant="ghost">
                      <Link to={`/maps/${encodeURIComponent(map.id)}`}>Open</Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {state.hasMore ? (
            <div className="flex justify-center pt-2">
              <Button onClick={() => mapsStore.loadMore().catch(console.error)} disabled={state.loadingMore}>
                {state.loadingMore ? "Loading more..." : "Load More Maps"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
