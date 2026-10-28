import { layoutTheme, previewLayoutTheme, saveLayoutTheme, type LayoutTheme } from "../data/layoutTheme";
import { DeveloperBadge } from "./DeveloperBadge";
import { For, Show, createSignal, onCleanup } from "solid-js";
import { uploadPicture } from "../data/files";
import { Modal } from "./Modal";
import { faceStyle, faceText } from "./Shell";
import { displayName, saveCustomization, type Profile } from "../data/store";
import { customization, NAMEPLATE_OPTIONS, nameplateClass, PATRICK_GIF, type Customization } from "../data/customization";
import "./customize.css";
import "./customize-profile.css";
import "./nameplates.css";

type Category = "Avatar & Decoration" | "Nameplate" | "Banner" | "Profile Effect & Frame" | "Layout Themes";
const categories: Category[] = ["Avatar & Decoration", "Nameplate", "Banner", "Profile Effect & Frame", "Layout Themes"];

export function Customize(props: { uid: string; profile?: Profile; name: string; onClose: () => void }) {
  const initialLayout = layoutTheme();
  const [themeDraft, setThemeDraft] = createSignal<LayoutTheme>(initialLayout);
  let themeSaved = false;
  onCleanup(() => { if (!themeSaved) previewLayoutTheme(initialLayout); });
  const chooseTheme = (theme: LayoutTheme) => { setThemeDraft(theme); previewLayoutTheme(theme); };
  const [category, setCategory] = createSignal<Category>("Avatar & Decoration");
  const [draft, setDraft] = createSignal(customization(props.profile?.customization));
  const [photo, setPhoto] = createSignal(props.profile?.photo ?? "");
  const [banner, setBanner] = createSignal(props.profile?.banner ?? "");
  const [publicName, setPublicName] = createSignal(props.profile?.callName ?? props.name);
  const maxDisplayNameLength = 24;
  const [bannerFile, setBannerFile] = createSignal<File>();
  const [photoFile, setPhotoFile] = createSignal<File>();
  const [photoMenu, setPhotoMenu] = createSignal(false);
  let bannerPreviewUrl: string | undefined;
  let photoPreviewUrl: string | undefined;
  let bannerPicker: HTMLInputElement | undefined;
  let stillPicker: HTMLInputElement | undefined;
  let gifPicker: HTMLInputElement | undefined;
  const releaseBannerPreview = () => {
    if (bannerPreviewUrl) URL.revokeObjectURL(bannerPreviewUrl);
    bannerPreviewUrl = undefined;
  };
  const releasePhotoPreview = () => {
    if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
    photoPreviewUrl = undefined;
  };
  onCleanup(releaseBannerPreview);
  onCleanup(releasePhotoPreview);
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
  function clearPhoto() {
    releasePhotoPreview();
    setPhotoFile(undefined);
    setPhoto("");
    setPhotoMenu(false);
  }
  function choosePhoto(file: File | undefined, kind: "still" | "gif") {
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const gif = file.type === "image/gif" || (!file.type && ext === "gif");
    const still = (/^image\/(png|webp|jpeg)$/.test(file.type) || (!file.type && ["png", "jpg", "jpeg", "webp"].includes(ext))) && !gif;
    if ((kind === "gif" && !gif) || (kind === "still" && !still)) {
      setError(kind === "gif" ? "Choose a GIF." : "Choose a PNG, JPG, or WebP picture.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) { setError("A profile picture can be up to 10 MB."); return; }
    setError("");
    releasePhotoPreview();
    photoPreviewUrl = URL.createObjectURL(file);
    setPhotoFile(file);
    setPhoto(photoPreviewUrl);
    setPhotoMenu(false);
  }
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const initial = { customization: JSON.stringify(draft()), photo: photo(), banner: banner(), publicName: publicName() };
  const profileDirty = () => JSON.stringify(draft()) !== initial.customization || photo() !== initial.photo || banner() !== initial.banner || publicName().trim() !== initial.publicName || Boolean(bannerFile()) || Boolean(photoFile());
  const dirty = () => profileDirty() || themeDraft() !== initialLayout;
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

  const preview = (): Profile => ({ uid: props.uid, name: props.name, username: props.profile?.username ?? "", color: props.profile?.color ?? "#383838", ...props.profile, callName: publicName().trim() || props.profile?.username || props.name, photo: photo(), banner: banner(), customization: draft() });
  const patch = (value: Partial<Customization>) => setDraft(current => ({ ...current, ...value }));
  const choice = (label: string, selected: () => boolean, onClick: () => void, styleClass = "") => <button type="button" class={`cosmetic-choice ${styleClass}`} aria-pressed={selected()} onClick={onClick}><span>{label}</span><Show when={selected()}><b aria-hidden="true">✓</b></Show></button>;
  async function save() {
    setSaving(true); setError("");
    try {
      const selectedTheme = themeDraft();
      const selectedProfileDirty = profileDirty();
      const selectedFile = bannerFile();
      const selectedPhotoFile = photoFile();
      const selectedDraft = draft();
      const selectedPhoto = photo();
      const selectedBanner = banner();
      const selectedName = publicName().trim();
      const savedBanner = selectedFile ? await uploadPicture(selectedFile, { kind: "profile", name: "banner" }) : selectedBanner;
      const savedPhoto = selectedPhotoFile ? await uploadPicture(selectedPhotoFile, { kind: "profile", name: "photo" }) : selectedPhoto;
      const photoChanged = selectedPhoto !== (props.profile?.photo ?? "") || Boolean(selectedPhotoFile);
      if (selectedProfileDirty) await saveCustomization(props.uid, selectedDraft, photoChanged ? savedPhoto : undefined, selectedFile || savedBanner !== (props.profile?.banner ?? "") ? savedBanner : undefined, selectedName !== (props.profile?.callName ?? props.name) ? selectedName : undefined);
      saveLayoutTheme(selectedTheme);
      themeSaved = true;
      props.onClose();
    } catch { setError("Could not save your customization. Check your connection and try again."); }
    finally { setSaving(false); }
  }
  return <Modal title="Customize your profile" open class={warnUnsaved() ? "customize-unsaved-warning" : ""} onClose={requestClose}>
    <div class="customize-layout" onClick={() => setPhotoMenu(false)}>
      <aside class={`customize-preview profile-effect-${draft().effect}`} aria-label="Your profile preview">
        <div class="customize-banner" style={{ "background-color": draft().bannerColor, "background-image": banner() ? `url("${banner()}")` : "none" }}>
          <button class="customize-banner-edit" type="button" aria-label="Edit banner" title="Edit banner" onClick={() => setCategory("Banner")}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z" /></svg>
          </button>
        </div>
        <div class="customize-avatar-row">
          <button class="avatar big customize-avatar" type="button" style={faceStyle(preview())} aria-label="Change profile picture" aria-expanded={photoMenu()} title="Change profile picture" disabled={saving()} onClick={(e) => { e.stopPropagation(); setPhotoMenu((open) => !open); }}>
            {faceText(preview(), displayName(preview()))}<i class="dot" aria-hidden="true" />
          </button>
          <Show when={photoMenu()}>
            <div class="customize-photo-menu" role="menu" aria-label="Profile picture" onClick={(e) => e.stopPropagation()}>
              <button type="button" role="menuitem" disabled={saving()} onClick={() => { setPhotoMenu(false); stillPicker?.click(); }}>Still picture</button>
              <button type="button" role="menuitem" disabled={saving()} onClick={() => { setPhotoMenu(false); gifPicker?.click(); }}>GIF</button>
              <Show when={photo()}><button type="button" role="menuitem" disabled={saving()} onClick={clearPhoto}>Remove picture</button></Show>
            </div>
          </Show>
          <input ref={stillPicker} type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" hidden disabled={saving()} onChange={(e) => { choosePhoto(e.currentTarget.files?.[0], "still"); e.currentTarget.value = ""; }} />
          <input ref={gifPicker} type="file" accept="image/gif,.gif" hidden disabled={saving()} onChange={(e) => { choosePhoto(e.currentTarget.files?.[0], "gif"); e.currentTarget.value = ""; }} />
          <span class="customize-preview-label">PROFILE PREVIEW</span>
        </div>
        <div class="customize-profile-details">
          <div class="customize-preview-name">
            <div class="customize-display-name-row"><input class="customize-name-input" aria-label="Display name" title="Click to change your display name" type="text" value={publicName()} size={Math.max(1, publicName().length)} maxLength={maxDisplayNameLength} placeholder={props.name} disabled={saving()} onInput={e => setPublicName(e.currentTarget.value)} /><DeveloperBadge username={preview().username} /></div>
            <p class="customize-profile-username">@{preview().username || "member"}</p>
          </div>
          <Show when={category() === "Nameplate"}>
            <div class="customize-nameplate-demo"><span class="customize-section-label">MEMBER LIST PREVIEW</span><div class={`customize-nameplate-row ${nameplateClass(draft().nameplate)}`}><span class="avatar small" style={faceStyle(preview())}>{faceText(preview(), displayName(preview()))}</span><b>{displayName(preview())}<DeveloperBadge username={preview().username} /></b></div></div>
          </Show>
        </div>
        <div class="customize-preview-footer"><span class="customize-preview-indicator" classList={{ changed: dirty() }} />{dirty() ? "Preview · Unsaved changes" : "Your current profile"}</div>
      </aside>
      <nav class="customize-tabs" aria-label="Customization categories"><For each={categories}>{item => <button type="button" aria-pressed={category() === item} onClick={() => setCategory(item)}>{item}</button>}</For></nav>
      <div class="customize-options">
        <Show when={category() === "Avatar & Decoration"}><section><h3>Avatar &amp; Decoration</h3><p>Click your picture on the left. Choose a still photo or a GIF, then a frame around it.</p><div class="cosmetic-grid">
          <For each={["none", "patrick", "orbit", "neon"] as const}>{id => <button type="button" class="cosmetic-choice cosmetic-avatar-choice" aria-pressed={draft().decoration === id} onClick={() => patch({ decoration: id })}><span class="avatar big" style={faceStyle({ ...preview(), customization: { ...draft(), decoration: id } })}>{faceText(preview(), props.name)}</span><span>{id === "none" ? "No decoration" : id === "patrick" ? "Patrick · animated" : id === "orbit" ? "Silver orbit" : "Neon ring"}</span><Show when={draft().decoration === id}><b aria-hidden="true">✓</b></Show></button>}</For>
        </div><div class="patrick-asset"><img src={PATRICK_GIF} alt="Animated Patrick Star artwork" /><div><h4>Patrick Star GIF</h4><p>Use the animation as a decoration around your avatar.</p><div class="cosmetic-actions"><button class="btn" aria-pressed={draft().decoration === "patrick"} onClick={() => patch({ decoration: "patrick" })}>Use as decoration</button></div></div></div><div class="cosmetic-actions"><button class="btn" onClick={clearPhoto}>Remove avatar picture</button><button class="btn" onClick={clearBanner}>Remove banner image</button></div></section></Show>
        <Show when={category() === "Nameplate"}><section><h3>Nameplate</h3><p>Choose one of eight animated nameplates. Preview it on your name bar before saving.</p>
          <div class="nameplate-picker"><For each={NAMEPLATE_OPTIONS}>{option => <button type="button" class={`nameplate-option ${nameplateClass(option.id)}`} aria-pressed={draft().nameplate === option.id} disabled={saving()} onClick={() => patch({ nameplate: option.id })}><span class="nameplate-option-label">{option.label}</span><Show when={draft().nameplate === option.id}><span class="nameplate-option-check" aria-hidden="true">✓</span></Show></button>}</For></div>
          <button class="btn nameplate-clear" type="button" aria-pressed={draft().nameplate === "none"} disabled={saving()} onClick={() => patch({ nameplate: "none" })}>No nameplate</button>
        </section></Show>
        <Show when={category() === "Banner"}><section><h3>Banner</h3>
          <p>Add a photo or animated GIF, or use a solid color.</p>
          <input ref={bannerPicker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden disabled={saving()} onChange={e => { chooseBanner(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }} />
          <div class="cosmetic-actions"><button class="btn" type="button" disabled={saving()} onClick={() => bannerPicker?.click()}>{banner() ? "Change photo / GIF" : "Add photo / GIF"}</button><Show when={banner()}><button class="btn" type="button" disabled={saving()} onClick={clearBanner}>Remove image</button></Show></div>
          <p>{bannerFile() ? `${bannerFile()!.name} · ready to save` : "PNG, JPG, WebP or GIF · up to 10 MB. GIFs keep their animation."}</p>
          <label class="banner-color-input">Choose a color<input type="color" disabled={saving()} value={draft().bannerColor} onInput={e => { patch({ bannerColor: e.currentTarget.value }); clearBanner(); }} /></label>
          <p>Choosing a color switches your banner to a solid color. Your changes apply after saving.</p>
          <button class="btn" type="button" disabled={saving()} onClick={clearBanner}>Use color instead of image</button>
        </section></Show>
        <Show when={category() === "Layout Themes"}><section><h3>Layout Themes</h3><p>Choose how Digital House feels. Preview a theme now; save to keep it in this browser.</p>
          <div class="layout-theme-choices">
            <button class="layout-theme-choice" type="button" aria-pressed={themeDraft() === "smoky"} disabled={saving()} onClick={() => chooseTheme("smoky")}><span class="layout-theme-sample" aria-hidden="true"><i /><i /><i /></span><strong>Smoky Glass <Show when={themeDraft() === "smoky"}><span aria-hidden="true">✓</span></Show></strong><small>Medium-gray gradient, smoky glass panels and a calm, open feel.</small></button>
            <button class="layout-theme-choice" type="button" aria-pressed={themeDraft() === "classic"} disabled={saving()} onClick={() => chooseTheme("classic")}><span class="layout-theme-sample classic" aria-hidden="true"><i /><i /><i /></span><strong>Classic Dark <Show when={themeDraft() === "classic"}><span aria-hidden="true">✓</span></Show></strong><small>The original black-and-gray Digital House layout with green accents.</small></button>
          </div>
        </section></Show>
        <Show when={category() === "Profile Effect & Frame"}><section><h3>Profile Effect &amp; Frame</h3><p>Finishing touches for your full profile card.</p><div class="cosmetic-grid"><For each={["none", "starlight", "neon"] as const}>{id => choice(id === "none" ? "No effect" : id === "starlight" ? "Starlight" : "Neon frame", () => draft().effect === id, () => patch({ effect: id }), `profile-effect-${id}`)}</For></div></section></Show>
      </div>
    </div>
    <p role="alert" class="customize-error">{error()}</p><div class="customize-footer"><button class="btn" disabled={saving()} onClick={props.onClose}>Cancel</button><button class="btn primary" disabled={saving()} onClick={() => void save()}>{saving() ? "Saving…" : "Save customization"}</button></div>
  </Modal>;
}
