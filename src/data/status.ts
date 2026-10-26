export const AVAILABILITY_OPTIONS = [
  { id: "online", label: "Online", hint: "Available" },
  { id: "idle", label: "Idle", hint: "Away for a while" },
  { id: "dnd", label: "Do Not Disturb", hint: "Keep chat notifications quiet" },
  { id: "invisible", label: "Invisible", hint: "Appear offline to other members" },
] as const;
export type Availability = typeof AVAILABILITY_OPTIONS[number]["id"];
export function availabilityStatus(value: unknown): Availability {
  return AVAILABILITY_OPTIONS.some(option => option.id === value) ? value as Availability : "online";
}
export function availabilityLabel(value: unknown): string {
  return AVAILABILITY_OPTIONS.find(option => option.id === availabilityStatus(value))!.label;
}
