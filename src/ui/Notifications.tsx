import { Portal } from "solid-js/web";
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { watchAllFeedback, watchMyFeedback, type Feedback } from "../data/feedback";
import { feedbackReceipt, unreadNotifications } from "../data/notifications";
import "./notifications.css";

export type Notice = { id: string; title: string; detail: string; at: number; target: "mine" | "inbox" };
export function Notifications(props: { uid: string; staff?: boolean; unreadInbox: number; latestInboxAt?: number; onOpen: () => void; onItems: (items: Notice[]) => void; onError: (error: string) => void }) {
  const unreadCount = () => props.unreadInbox + unreadNotifications(props.uid,items());
  const [items, setItems] = createSignal<Notice[]>([]);
  const [error, setError] = createSignal("");
  const [toast, setToast] = createSignal<Notice>();
  const [leaving, setLeaving] = createSignal(false);
  createEffect(() => props.onItems(items()));
  createEffect(() => props.onError(error()));
  let feedbackButton: HTMLButtonElement | undefined;
  const [anchor, setAnchor] = createSignal({left:12,top:80,width:96,height:40});
  let timer: number | undefined, exit: number | undefined;
  function positionToast() {
    const box = feedbackButton?.getBoundingClientRect();
    if (!box) return;
    const fitsLeft = box.left - 10 - box.width - 24 >= 12;
    setAnchor({left:fitsLeft ? box.left - box.width - 10 : Math.max(12,Math.min(box.left,window.innerWidth-box.width-36)),top:fitsLeft ? box.top+box.height/2 : box.bottom+10+box.height/2,width:box.width,height:box.height});
  }
  createEffect(() => {
    if (!toast()) return;
    queueMicrotask(positionToast);
    window.addEventListener("resize",positionToast);
    window.addEventListener("scroll",positionToast,true);
    onCleanup(() => {window.removeEventListener("resize",positionToast);window.removeEventListener("scroll",positionToast,true);});
  });
  function announce(notice: Notice) {
    positionToast();
    clearTimeout(timer); clearTimeout(exit);
    setLeaving(false); setToast(notice);
    timer = window.setTimeout(() => {
      setLeaving(true);
      exit = window.setTimeout(() => setToast(undefined), 240);
    }, 5000);
  }
  function merge(next: Notice[]) {
    setItems(previous => [...next, ...previous.filter(old => !next.some(item => item.id === old.id))].sort((a,b) => b.at-a.at).slice(0,50));
  }
  createEffect(() => {
    const uid = props.uid;
    setItems([]); setError("");
    let first = true;
    let previous = new Map<string,string>();
    const stop = watchMyFeedback(uid, list => {
      const next: Notice[] = [];
      for (const f of list) {
        const signature = `${f.status}:${f.reply ?? ""}:${f.repliedAt?.getTime() ?? 0}`;
        if (f.reply || f.status !== "new") {
          const notice: Notice = { id: `update-${f.id}`, title: f.reply ? "Feedback reply received" : f.status === "done" ? "Feedback resolved" : "Feedback in progress", detail: f.reply || f.text, at: f.repliedAt?.getTime() ?? f.createdAt?.getTime() ?? Date.now(), target: "mine" };
          if (!first && previous.get(f.id) !== signature) { notice.at = Date.now(); announce(notice); }
          next.push(notice);
        }
      }
      previous = new Map(list.map(f => [f.id, `${f.status}:${f.reply ?? ""}:${f.repliedAt?.getTime() ?? 0}`]));
      first = false; merge(next);
    }, () => setError("Feedback updates are unavailable. Try opening Feedback."));
    onCleanup(stop);
  });
  createEffect(() => {
    if (!props.staff) return;
    const uid = props.uid;
    let first = true;
    let known = new Set<string>();
    const stop = watchAllFeedback(list => {
      const next = list.filter(f => f.uid !== uid).map((f: Feedback): Notice => ({id:`inbox-${f.id}`,title:f.type === "bug" ? "New bug report" : "New feedback received",detail:`${f.name || f.username}: ${f.text}`,at:f.createdAt?.getTime() ?? Date.now(),target:"inbox"}));
      if (!first) { const fresh = next.find(item => !known.has(item.id)); if (fresh) announce(fresh); }
      known = new Set(next.map(item => item.id)); first = false; merge(next);
    }, () => setError("The feedback inbox is unavailable."));
    onCleanup(stop);
  });
  createEffect(() => {
    const receipt = feedbackReceipt();
    if (!receipt || receipt.uid !== props.uid) return;
    const notice: Notice = {id:`sent-${receipt.id}`,title:receipt.type === "bug" ? "Bug report sent" : "Feedback sent",detail:"Successfully delivered to the developers.",at:receipt.at,target:"mine"};
    merge([notice]); announce(notice);
  });
  let lastInboxAt = Date.now();
  createEffect(() => {
    const at = props.latestInboxAt ?? 0;
    if (at > lastInboxAt) { lastInboxAt = at; announce({id:`dm-${at}`,title:"New inbox message",detail:"You received a direct message.",at,target:"mine"}); }
  });
  onCleanup(() => { clearTimeout(timer); clearTimeout(exit); });
  return <div class="notifications">
    <button ref={feedbackButton} class="btn feedback-btn" type="button" title="Feedback and notifications" aria-label={`Feedback${unreadCount() ? `, ${unreadCount()} unread notifications` : ""}`} onClick={props.onOpen}>Feedback<Show when={unreadCount() > 0}><span class="feedback-unread" aria-hidden="true"><i />{unreadCount() > 99 ? "99+" : unreadCount()}</span></Show></button>
    <Portal><Show when={toast()}>{item => <div style={{position:"fixed",left:`${anchor().left}px`,top:`${anchor().top}px`,right:"auto",width:`${anchor().width}px`,height:`${anchor().height}px`}} title={`${item().title}: ${item().detail}`} aria-label={`${item().title}: ${item().detail}`} class="notification-toast" classList={{"is-leaving":leaving()}} role="status" aria-live="polite"><span class="notification-success" aria-hidden="true">{item().title === "New inbox message" ? "✉" : "✓"}</span><div><strong>{item().title === "New inbox message" ? "New inbox" : item().title === "Bug report sent" ? "Bug sent" : item().title === "Feedback sent" ? "Sent" : item().title.includes("reply") ? "New reply" : "Updated"}</strong></div></div>}</Show></Portal>
  </div>;
}

export function NotificationList(props: {items: Notice[]; error: string; unreadInbox: number; onInbox: () => void; onFeedback: (tab: "mine" | "inbox") => void}) {
  return <section class="feedback-notifications" aria-label="Notifications">
    <button class="notification-inbox" type="button" onClick={props.onInbox}>Inbox <span>{props.unreadInbox ? `${props.unreadInbox} unread` : "Open messages"} →</span></button>
    <Show when={props.error}><p class="notification-empty" role="status">{props.error}</p></Show>
    <div class="notification-list"><For each={props.items} fallback={<p class="notification-empty">You're all caught up. Feedback replies and sent confirmations appear here.</p>}>{item => <button type="button" class="notification-item" onClick={() => props.onFeedback(item.target)}><strong>{item.title}</strong><span>{item.detail}</span><time>{new Date(item.at).toLocaleString([], {dateStyle:"short",timeStyle:"short"})}</time></button>}</For></div>
  </section>;
}
