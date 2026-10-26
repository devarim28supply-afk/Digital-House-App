import { createSignal } from "solid-js";
type Receipt = {id:string;uid:string;type:string;at:number};
export const [feedbackReceipt, setFeedbackReceipt] = createSignal<Receipt>();
