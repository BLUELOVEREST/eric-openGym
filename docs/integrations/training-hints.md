# Native Training Hints

SparkyFitness owns dated weekly training intent. openGym owns independent actual
workouts, exercises, sets and loads. A hint is not a routine assignment, private
day note, excuse, completion target or workout association.

The original native `week` routine-ID model, Coach, watch and freestyle paths stay
unchanged. Multiple independent workouts can be recorded on a day without any
predefined routine. No native occurrence model or parallel weekly schedule is used.

## Storage and Delivery

SQLite schema 11 moves the incoming source head from `body_sources` into
`incoming_sources`, retaining its value. There is one coordinating SF identity per
owner and one cursor across every incoming SF resource. `training_hints` stores
typed source payloads separately from `body_entities` and editable profiles.
Generic incoming snapshots share membership and cursor checks across both domains.
Projection changes and inbox receipts commit atomically, followed by native SSE.

Schema 12 retains the sole source head by `(owner_id, source_id)` and makes its
connection reference nullable. Purge deletes projections and detaches that binding,
not the head. A partial unique index permits only one connected SF identity per
owner; another identity after explicit purge receives an independent head. Re-pair
to a prior identity resumes its retained cursor, including after restart. Actual
account deletion cascades these heads. Schema 10 and 11 heads migrate intact.

Schedule-only scope does not claim body ownership. Revocation retains read-only
hints; explicit purge removes the detached source projection. Replacement keeps the
source head and pending delivery protections, with existing history approval gates.
SF includes current hint metadata in initial snapshots even without history consent.
openGym never exports a `schedule_summary`.

## Read API and Offline UI

Owner-authenticated `GET /api/training-hints` returns
`{revision,date:null,hints:[{entity_id,...payload}]}`. Supplying a real calendar
`date` filters by inclusive effective range. The payload retains source name,
timezone, week start, effective range and unique weekday/time buckets, with exactly
one main on a nonempty day. Empty slots and absent weekdays mean rest within the
effective range. Missing metadata is not a rest hint. No clock time is invented.

The app caches the unfiltered response per authenticated owner and server, outside
the profile mirror and body cache. Calendar resolution is local, so Sunday reads
include next week's metadata offline without seven requests. SSE, focus and
reconnect coalesce refreshes; there is no business polling. A hint error cannot
change body ownership. Date-filtered responses cannot replace the full cache.

Home and date sheets present read-only, note-style guidance. Training without a
routine offers freestyle, not a forced routine chooser or a rest-day claim. Rest
guidance never disables independent training. Actual notes and reminders remain
native and independent.
