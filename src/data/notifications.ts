import { createSignal } from "solid-js";
type Receipt = {id:string;uid:string;type:string;at:number};
export const [feedbackReceipt, setFeedbackReceipt] = createSignal<Receipt>();

export type NotificationCategory = "mine" | "inbox" | "notifications";
type ReadTimes = Record<NotificationCategory, number>;
const [readState,setReadState] = createSignal<Record<string,ReadTimes>>({});
function readTimes(uid:string): ReadTimes {
  const cached=readState()[uid]; if(cached) return cached;
  try {const value=JSON.parse(localStorage.getItem(`dh_notification_tabs_${uid}`)||"{}");return {mine:Number(value.mine)||0,inbox:Number(value.inbox)||0,notifications:Number(value.notifications)||0};}
  catch {return {mine:0,inbox:0,notifications:0};}
}
export function unreadNotifications(uid:string,items: {id:string;at:number;target:"mine"|"inbox"}[],category?:NotificationCategory) {
  const times=readTimes(uid);
  return items.filter(item=>{const group:NotificationCategory=item.id.startsWith("sent-") ? "notifications" : item.target;return (!category || category === "notifications" || group === category) && item.at > times[group];}).length;
}
export function markNotificationsRead(uid:string,category:NotificationCategory) {
  const previous=readTimes(uid), now=Date.now();
  const next=category === "notifications" ? {mine:now,inbox:now,notifications:now} : {...previous,[category]:now};
  setReadState(all=>({...all,[uid]:next}));
  try {localStorage.setItem(`dh_notification_tabs_${uid}`,JSON.stringify(next));}catch {}
}
