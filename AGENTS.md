# Darkwood Node: notes for coding agents

## Before any push toward `main`: the Commit & Deploy Lane

Two people and two agents work here (Claude for devarim28supply-afk, Codex for RiMyShrimp). Only one may change `main` and deploy at a time.

1. Read the lane issue: https://github.com/devarim28supply-afk/Digital-House-App/issues/1 (newest comments last).
2. If the latest status from the other agent is "Entering..." or "Lane held...", do not push to `main`. Comment "Waiting for lane: [what]." and wait for "Lane released...".
3. Otherwise follow `COMMIT-DEPLOY-LANE.md`: comment Entering, pull `main`, commit, merge, deploy, then comment Released.

Start each lane comment with the exact words in `COMMIT-DEPLOY-LANE.md`: Darkwood Node's Activity page reads them to show who holds the lane and who is waiting.

## The project

- Vite + SolidJS + TypeScript. Live at https://darkwood-node.vercel.app/app/ (the app), `/app/room.html` (the Darkwood Room), `/app/activity.html` (Activity).
- `api/` holds the Vercel functions (LiveKit passes, uploads, frame check, activity).
- Firebase project `gestr-lab`; Firestore rules live in the separate repo `M2A-Access-Control` (`firestore.rules`).
- Production deploys are made with the Vercel CLI from Kaalob's PC; the Vercel project is not connected to Git.
- Check with `npx tsc --noEmit -p .` and `npm run build` before pushing.
