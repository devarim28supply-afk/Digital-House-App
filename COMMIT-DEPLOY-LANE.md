# Commit & Deploy Lane

The shared rule for `devarim28supply-afk/Digital-House-App` (Darkwood Node). Two people work in this repo, each with a coding agent:

- **Claude**, working for devarim28supply-afk (Kaalob)
- **Codex**, working for RiMyShrimp (Tyler)

Anyone can work on their own branch at any time. Only one at a time may hold the **Commit & Deploy Lane**: the right to change `main` and deploy it to production (darkwood-node.vercel.app).

The shared channel is the **Commit and Deploy Lane** issue: https://github.com/devarim28supply-afk/Digital-House-App/issues/1. Darkwood Node's Activity page shows the lane live: who holds it, what they are doing, and who is waiting.

## Lane status messages

Post these as comments on the lane issue, exactly starting with these words, so the Activity page can read them:

- **Waiting:** "Waiting for lane: [what you want to push]." You are in the queue.
- **Entering:** "Entering Commit & Deploy Lane. Pulling latest and preparing changes."
- **Holding:** "Lane held. Working on [brief description]. Do not push to main."
- **Releasing:** "Lane released. Deployment complete / changes pushed. Main is clear."
- **Urgent:** "Requesting lane release - urgent." The holder releases as soon as it is safe.

## Core rules

- Only one person may hold the lane at a time. It is held from the Entering message until the Releasing message.
- Read the lane issue before any push toward `main`. If the latest status is Entering or Holding from the other person, do not push to `main`: post a Waiting message and wait for their Release.
- When the lane is released, the first person still waiting goes next.
- Pull the latest `main` before committing anything you will push, and resolve conflicts first.
- Prefer a short-lived branch and a pull request merged while you hold the lane. A direct push to `main` is the fallback and still needs the lane.
- Release the lane as soon as your change is on `main` and deployed (or you decide not to deploy).

## Procedure

1. Read the lane issue. If someone holds it, post Waiting and wait.
2. Post Entering. The lane is yours from that moment.
3. Pull before committing:

   ```bash
   git checkout main
   git pull origin main
   ```

   Rebase your branch onto the updated `main` (`git rebase main`) and fix conflicts.
4. Commit (atomic, descriptive commits), open a pull request into `main`, and merge it while holding the lane.
5. Deploy and check it. Production deploys are made with the Vercel CLI from Kaalob's PC (`vercel deploy --prod`): the project is not connected to Git, so pushing alone does not deploy. If you cannot deploy, say so in your Release message, and Kaalob's Claude deploys it next.
6. Post Releasing. The next person waiting may enter.

## Safeguards

- If both of you need to change the same files, one finishes and releases before the other starts the pull-and-commit steps.
- Never force-push `main` and never use a merge strategy that drops the other person's changes.
- Database rules live in a different repo (`M2A-Access-Control/firestore.rules`) and are published separately by Kaalob.
- This private repo cannot use GitHub branch protection without GitHub Pro. The lane messages are what keep two pushes from colliding.
