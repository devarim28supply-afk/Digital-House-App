import { DeveloperBadge } from "./DeveloperBadge";
import { For, Show, createSignal, onCleanup } from "solid-js";
import { uploadPicture } from "../data/files";
import { Modal } from "./Modal";
import { faceStyle, faceText } from "./Shell";
import { displayName, saveCustomization, type Profile } from "../data/store";
import { customization, PATRICK_GIF, type Customization } from "../data/customization";
import "./customize.css";

type Category = "Avatar & Decoration" | "Nameplate" | "Banner" | "Profile Effect & Frame";
const categories: Category[] = ["Avatar & Decoration", "Nameplate", "Banner", "Profile Effect & Frame"];

export function Customize(props: { uid: string; profile?: Profile; name: string; onClose: () => void }) {
  const [category, setCategory] = createSignal<Category>("Avatar & Decoration");
  const [draft, setDraft] = createSignal(customization(props.profile?.customization));
  const [photo, setPhoto] = createSignal(props.profile?.photo ?? "");
  const [banner, setBanner] = createSignal(props.profile?.banner ?? "");
  const [bannerFile, setBannerFile] = createSignal<File>();
  let bannerPreviewUrl: string | undefined;
  let bannerPicker: HTMLInputElement | undefined;
  const releaseBannerPreview = () => {
    if (bannerPreviewUrl) URL.revokeObjectURL(bannerPreviewUrl);
    bannerPreviewUrl = undefined;
  };
  onCleanup(releaseBannerPreview);
  function clearBanner() {
    releaseBannerPreview(); setBannerFile(undefined); setBanner("");
  }
  function chooseBanner(file?: File) {
    if (!file) return;
    if (!/^image\/(png|gif|webp|jpeg)$/.test(file.type)) { setError("Choose a PNG, JPG, WebP photo or animated GIF."); return; }
    if (file.size > 10 * 1024 * 1024) { setError("A banner can be up to 10 MB."); return; }
    setError(""); releaseBannerPreview();
    bannerPreviewUrl = URL.createObjectURL(file);
    setBannerFile(file); setBanner(bannerPreviewUrl);
  }
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const initial = { customization: JSON.stringify(draft()), photo: photo(), banner: banner() };
  const dirty = () => JSON.stringify(draft()) !== initial.customization || photo() !== initial.photo || banner() !== initial.banner || Boolean(bannerFile());
  const [warnUnsaved, setWarnUnsaved] = createSignal(false);
  let warningTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(warningTimer));
  function requestClose() {
    if (saving()) return;
    if (!dirty()) { props.onClose(); return; }
    clearTimeout(warningTimer);
    setWarnUnsaved(true);
    setError("You have unsaved changes. Save customization, or choose Cancel to discard them.");
    warningTimer = setTimeout(() => setWarnUnsaved(false), 950);
  }

  const preview = (): Profile => ({ uid: props.uid, name: props.name, username: props.profile?.username ?? "", color: props.profile?.color ?? "#383838", ...props.profile, photo: photo(), banner: banner(), customization: draft() });
  const patch = (value: Partial<Customization>) => setDraft(current => ({ ...current, ...value }));
  const choice = (label: string, selected: () => boolean, onClick: () => void, styleClass = "") => <button type="button" class={`cosmetic-choice ${styleClass}`} aria-pressed={selected()} onClick={onClick}><span>{label}</span><Show when={selected()}><b aria-hidden="true">✓</b></Show></button>;
  async function save() {
    setSaving(true); setError("");
    try {
      const selectedFile = bannerFile();
      const selectedDraft = draft();
      const selectedPhoto = photo();
      const selectedBanner = banner();
      const savedBanner = selectedFile ? await uploadPicture(selectedFile, { kind: "profile", name: "banner" }) : selectedBanner;
      await saveCustomization(props.uid, selectedDraft, selectedPhoto !== (props.profile?.photo ?? "") ? selectedPhoto : undefined, selectedFile || savedBanner !== (props.profile?.banner ?? "") ? savedBanner : undefined);
      props.onClose();
    } catch { setError("Could not save your customization. Check your connection and try again."); }
    finally { setSaving(false); }
  }
  return <Modal title="Customize your profile" open class={warnUnsaved() ? "customize-unsaved-warning" : ""} onClose={requestClose}>
    <div class="customize-layout">
      <div class={`customize-preview profile-effect-${draft().effect}`}>
        <div class="customize-banner" style={{ "background-color": draft().bannerColor, "background-image": banner() ? `url("${banner()}")` : "none" }} />
        <span class="avatar big customize-avatar" style={faceStyle(preview())}>{faceText(preview(), props.name)}</span>
        <div class={`customize-preview-name nameplate-${draft().nameplate}`}><b>{displayName(preview())}<DeveloperBadge username={preview().username} /></b><small>@{preview().username || "member"}</small></div>
        <p>Live preview · visible to other members</p>
      </div>
      <nav class="customize-tabs" aria-label="Customization categories"><For each={categories}>{item => <button type="button" aria-pressed={category() === item} onClick={() => setCategory(item)}>{item}</button>}</For></nav>
      <div class="customize-options">
        <Show when={category() === "Avatar & Decoration"}><section><h3>Avatar &amp; Decoration</h3><p>Choose a frame around your current picture.</p><div class="cosmetic-grid">
          <For each={["none", "patrick", "orbit", "neon"] as const}>{id => <button type="button" class="cosmetic-choice cosmetic-avatar-choice" aria-pressed={draft().decoration === id} onClick={() => patch({ decoration: id })}><span class="avatar big" style={faceStyle({ ...preview(), customization: { ...draft(), decoration: id } })}>{faceText(preview(), props.name)}</span><span>{id === "none" ? "No decoration" : id === "patrick" ? "Patrick · animated" : id === "orbit" ? "Silver orbit" : "Neon ring"}</span><Show when={draft().decoration === id}><b aria-hidden="true">✓</b></Show></button>}</For>
        </div><div class="patrick-asset"><img src={PATRICK_GIF} alt="Animated Patrick Star artwork" /><div><h4>Patrick Star GIF</h4><p>Use the animation as a decoration around your avatar.</p><div class="cosmetic-actions"><button class="btn" aria-pressed={draft().decoration === "patrick"} onClick={() => patch({ decoration: "patrick" })}>Use as decoration</button></div></div></div><div class="cosmetic-actions"><button class="btn" onClick={() => setPhoto("")}>Remove avatar picture</button><button class="btn" onClick={clearBanner}>Remove banner image</button></div></section></Show>
        <Show when={category() === "Nameplate"}><section><h3>Nameplate</h3><p>A background behind your name in the status list and your card.</p><div class="cosmetic-grid"><For each={["none", "aurora", "ember"] as const}>{id => choice(id === "none" ? "No nameplate" : id === "aurora" ? "Aurora" : "Ember", () => draft().nameplate === id, () => patch({ nameplate: id }), `nameplate-${id}`)}</For></div></section></Show>
        <Show when={category() === "Banner"}><section><h3>Banner</h3>
          <p>Add a photo or animated GIF, or use a solid color.</p>
          <input ref={bannerPicker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden disabled={saving()} onChange={e => { chooseBanner(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }} />
          <div class="cosmetic-actions"><button class="btn" type="button" disabled={saving()} onClick={() => bannerPicker?.click()}>{banner() ? "Change photo / GIF" : "Add photo / GIF"}</button><Show when={banner()}><button class="btn" type="button" disabled={saving()} onClick={clearBanner}>Remove image</button></Show></div>
          <p>{bannerFile() ? `${bannerFile()!.name} · ready to save` : "PNG, JPG, WebP or GIF · up to 10 MB. GIFs keep their animation."}</p>
          <label class="banner-color-input">Choose a color<input type="color" disabled={saving()} value={draft().bannerColor} onInput={e => { patch({ bannerColor: e.currentTarget.value }); clearBanner(); }} /></label>
          <p>Choosing a color switches your banner to a solid color. Your changes apply after saving.</p>
          <button class="btn" type="button" disabled={saving()} onClick={clearBanner}>Use color instead of image</button>
        </section></Show>
        <Show when={category() === "Profile Effect & Frame"}><section><h3>Profile Effect &amp; Frame</h3><p>Finishing touches for your full profile card.</p><div class="cosmetic-grid"><For each={["none", "starlight", "neon"] as const}>{id => choice(id === "none" ? "No effect" : id === "starlight" ? "Starlight" : "Neon frame", () => draft().effect === id, () => patch({ effect: id }), `profile-effect-${id}`)}</For></div></section></Show>
      </div>
    </div>
    <p role="alert" class="customize-error">{error()}</p><div class="customize-footer"><button class="btn" disabled={saving()} onClick={props.onClose}>Cancel</button><button class="btn primary" disabled={saving()} onClick={() => void save()}>{saving() ? "Saving…" : "Save customization"}</button></div>
  </Modal>;
}
