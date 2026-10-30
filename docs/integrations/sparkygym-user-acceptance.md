# SparkyGym Setup And Acceptance

SparkyFitness owns body measurements, target weight, weekly training intent and
meals. openGym owns actual exercises, workouts and personal training media. This
integration never matches a completed workout to a planned session.

## Pair The Accounts

1. Sign in to the intended account in each service. The servers must be able to
   reach each other's configured origins. Use an origin such as
   `https://gym.example.test`, without an `/api` suffix or a path prefix.
2. In SparkyFitness Settings, open Developer/Integrations and the openGym section.
   Enter the openGym origin, choose resource scopes and decide whether to include
   existing history. For a trusted LAN fixture only, explicitly allow both private
   networks and unencrypted HTTP if applicable.
3. Create and copy the invitation. It expires after ten minutes and contains a
   secret: do not put it in logs, screenshots or source control.
4. In openGym Settings / Account, open SparkyFitness / Import invitation, paste
   the invitation JSON and explicitly confirm the required LAN/HTTP permissions.
5. Return to SparkyFitness and approve the displayed peer account. Check the peer
   origin, scopes and affected record counts before approval. Both ends should
   then show an active connection. No manually configured API key is needed.

Installing an updated image does not pair accounts automatically. Pairing and
history consent are separate from ordinary login and from food providers.

## Check The Data Flow

- Add or correct a body measurement in SparkyFitness. Its read-only copy should
  appear in openGym. Changing one metric must not clear the day's other metrics.
- Save an active, dated weekly training-focus plan in SparkyFitness. Open the
  corresponding date in openGym, including a future date. The hint should show
  the source time buckets, activity and main marker without requiring a routine.
  An applicable day without training shows rest; a date outside the plan's range
  does not invent a rest instruction.
- At the gym, independently record exercises and sets in openGym, with or without
  a template. Multiple workouts on the same day remain separate records in
  SparkyFitness. Editing/deleting a result in openGym updates its source-owned copy.
- Hints must not edit private day notes, native routine assignments, reminders,
  actual results or saved food quantities. A hint is not a completed-workout link.
- Only owner-uploaded personal photos/videos are transferred. Licensed catalogue
  exercise animations are not copied into SparkyFitness.

## Pause, Recover And Remove

Pause retains local authoritative writes in the durable delivery queue. Resume
retries eligible pending deliveries. Server restart/reconnect recovers persisted
work; ordinary business data are not polled. A suspended phone is not promised
continuous background execution: reconnect/focus refreshes its read model.

Revocation stops access but retains imported copies. Purge is a separate,
confirmed operation available after revocation and removes only imported source
copies, not the peer's original measurements or workouts. Re-pairing/rotation
requires both-owner approval again. Back up each application's persistent data
and encryption/authentication material together before a deployment or restore.

## Release Boundaries

This development round does not deploy production. Gitea builds service images;
GitHub APK publishing and physical-phone offline/reconnect acceptance are deferred
until connectivity and signing/distribution setup are ready. E-class combined
statistics, including watch-recorded football/running, are a separate follow-up.
