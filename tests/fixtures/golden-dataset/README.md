# Golden Dataset v1

This dataset is a fixed, synthetic regression baseline for the frozen
ValidationResult, Shot, Slot, RenderPlan, and ScheduleResult contracts.

It intentionally contains no production media, credentials, NAS paths, or
customer data. Validator cases use deterministic technical and artifact inputs;
Scheduler cases use complete synthetic accept Shots.

The automated test must preserve these results:

- one validator Accept result;
- one validator Review result;
- one validator Reject result;
- one Scheduler successful selection with the two expected Shot ids; and
- one Scheduler Fail Fast result for the first unsatisfied Slot.

Do not silently update an expected result. A legitimate policy or contract
change requires a new versioned dataset and an explicit approval.
