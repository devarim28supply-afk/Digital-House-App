export const PATRICK_GIF = `${import.meta.env.BASE_URL}decorations/patrick-star.gif`;
export const DECORATIONS = ["none", "patrick", "orbit", "neon"] as const;
export const NAMEPLATE_OPTIONS = [
  { id: "cat-beans", label: "Cat Beans" },
  { id: "cityscape", label: "Cityscape" },
  { id: "spring-paradise", label: "Spring Paradise" },
  { id: "koi-pond", label: "Koi Pond" },
  { id: "twilight", label: "Twilight" },
  { id: "cherry-blossoms", label: "Cherry Blossoms" },
  { id: "vengeance", label: "Vengeance" },
  { id: "angel", label: "Angel" },
] as const;
export type Nameplate = "none" | typeof NAMEPLATE_OPTIONS[number]["id"];
export const NAMEPLATES: readonly Nameplate[] = ["none", ...NAMEPLATE_OPTIONS.map(option => option.id)];
export function nameplateClass(value: Nameplate): string {
  return value === "none" ? "nameplate-none" : `nameplate-art nameplate-${value}`;
}
export const EFFECTS = ["none", "starlight", "neon"] as const;
export type Customization = {
  decoration: typeof DECORATIONS[number];
  nameplate: typeof NAMEPLATES[number];
  effect: typeof EFFECTS[number];
  bannerColor: string;
};
export const DEFAULT_CUSTOMIZATION: Customization = {
  decoration: "none", nameplate: "none", effect: "none", bannerColor: "#171717",
};
/** Only known catalog entries can become CSS class names or decoration URLs. */
export function customization(value?: Partial<Customization>): Customization {
  return {
    decoration: DECORATIONS.includes(value?.decoration as Customization["decoration"]) ? value!.decoration! : "none",
    nameplate: NAMEPLATES.includes(value?.nameplate as Customization["nameplate"]) ? value!.nameplate! : "none",
    effect: EFFECTS.includes(value?.effect as Customization["effect"]) ? value!.effect! : "none",
    bannerColor: /^#[\da-f]{6}$/i.test(value?.bannerColor ?? "") ? value!.bannerColor! : DEFAULT_CUSTOMIZATION.bannerColor,
  };
}
