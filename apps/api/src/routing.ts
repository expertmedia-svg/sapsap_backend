import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Coordinates } from "../../../packages/shared/src";
export interface RouteResult {
  meters: number;
  seconds: number;
  geometry: unknown;
}
export interface Router {
  route(
    a: Coordinates,
    b: Coordinates,
    options?: { allowZero?: boolean },
  ): Promise<RouteResult>;
}
export class OsrmRouter implements Router {
  private cache = new Map<string, { until: number; route: RouteResult }>();
  async route(
    a: Coordinates,
    b: Coordinates,
    options?: { allowZero?: boolean },
  ) {
    const base = process.env.ROUTING_URL;
    if (!base)
      throw new ServiceUnavailableException(
        "Service de calcul d’itinéraire non configuré",
      );
    const bases = [base, process.env.ROUTING_FALLBACK_URL].filter(
      (value): value is string => !!value,
    );
    if (
      process.env.NODE_ENV === "production" &&
      bases.some((value) =>
        ["router.project-osrm.org", "routing.openstreetmap.de"].includes(
          new URL(value).hostname,
        ),
      )
    )
      throw new ServiceUnavailableException(
        "Fournisseur de routage de production requis",
      );
    const key = `${base}|${!!options?.allowZero}|${a.longitude},${a.latitude};${b.longitude},${b.latitude}`;
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) return cached.route;
    let routeMissing = false;
    for (const provider of bases) {
      try {
        const url = new URL(
          `route/v1/driving/${a.longitude},${a.latitude};${b.longitude},${b.latitude}`,
          provider.endsWith("/") ? provider : provider + "/",
        );
        url.search = "overview=full&geometries=geojson";
        const res = await fetch(url, { signal: AbortSignal.timeout(6500) });
        if (!res.ok) throw Error();
        const data = (await res.json()) as any;
        if (data.code === "NoRoute") {
          routeMissing = true;
          continue;
        }
        const r = data.routes?.[0];
        if (
          !r ||
          !Number.isFinite(r.distance) ||
          r.distance < 0 ||
          !Number.isFinite(r.duration) ||
          r.duration < 0 ||
          r.geometry?.type !== "LineString"
        )
          throw Error();
        if (r.distance < 1 && !options?.allowZero)
          throw new BadRequestException(
            "Choisissez deux points distincts sur le réseau routier",
          );
        const route = {
          meters: Math.ceil(r.distance),
          seconds: Math.ceil(r.duration),
          geometry: r.geometry,
        };
        if (this.cache.size >= 100)
          this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { route, until: Date.now() + 30000 });
        return route;
      } catch (e) {
        if (e instanceof BadRequestException) throw e;
      }
    }
    if (routeMissing)
      throw new BadRequestException("Aucun itinéraire routier trouvé");
    throw new ServiceUnavailableException(
      "Calcul routier indisponible. Réessayez.",
    );
  }
}
export const geo = (p: Coordinates) => ({
  type: "Point",
  coordinates: [p.longitude, p.latitude],
});
export const coords = (p: any): Coordinates => ({
  longitude: p.coordinates[0],
  latitude: p.coordinates[1],
});
export function distance(a: Coordinates, b: Coordinates) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const x =
    Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(rad(a.latitude)) *
      Math.cos(rad(b.latitude)) *
      Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
