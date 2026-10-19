import { GoogleMyBusinessEntry } from './schemas/client-onboarding.schema';

export type PlaceTarget = {
  placeId: string;
  gmbId: string;
  businessId?: string;
  locationName?: string;
};

export function resolvePlaceTargets(
  entries: GoogleMyBusinessEntry[],
  preferredPlaceId?: string,
): PlaceTarget[] {
  const withPlace = entries.filter((e) => e.placeId?.trim());
  const toTarget = (e: GoogleMyBusinessEntry): PlaceTarget => ({
    placeId: e.placeId as string,
    businessId: e.businessId?.trim(),
    gmbId: (e.businessId?.trim() || e.placeId) as string,
    locationName: e.locationName,
  });

  if (preferredPlaceId?.trim()) {
    const match = withPlace.find((e) => e.placeId === preferredPlaceId.trim());
    if (!match?.placeId) return [];
    return [toTarget(match)];
  }
  const active = withPlace.filter((e) => e.isActive !== false);
  const list = active.length ? active : withPlace;
  return list.map(toTarget);
}
