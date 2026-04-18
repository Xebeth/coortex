# Closure Gate Contract

Use this contract when a defect family needs an explicit acceptance gate for a
downstream fix workflow.

The closure gate is a per-family acceptance artifact. It exists to reduce
review/fix cycles by making the required root-cause closure conditions explicit
before a patch is considered done.

## Shape

```yaml
closure_gate:
  remediation_item: restore one authoritative structured-output boundary
  closure_checklist:
    - launch and resume converge on the same authoritative parsing contract
    - no adapter-side salvage path remains authoritative beside the main boundary
    - operator-facing truth reflects post-repair state
  required_sibling_tests:
    - malformed launch output cannot become a successful result through salvage
    - malformed resume output cannot become a successful result through salvage
  doc_closure:
    - docs describing the output contract are updated in the same patch
  reviewer_stop_conditions:
    - reject if the direct parse bug is fixed but sibling salvage paths remain
    - reject if tests or docs still encode the broader salvage contract
```

## Required fields

- `remediation_item`
- `closure_checklist`
- `required_sibling_tests`
- `doc_closure`
- `reviewer_stop_conditions`

## Rules

- `remediation_item` should describe the family-level remediation goal in one sentence.
- `closure_checklist` should describe the root-cause closure conditions for that family.
- `required_sibling_tests` should name the minimum tests needed to prove the family is closed rather than locally patched.
- `doc_closure` should name the documentation obligations when the fix changes a contract, invariant, recovery rule, or operator-visible truth.
- `reviewer_stop_conditions` should name the conditions under which a patch must still be rejected even if the directly reported manifestation appears fixed.
- Keep the gate generic enough to survive minor file motion. Use file paths or line numbers only as evidence in the review itself, not as the primary gate.
- The gate should reject local seam patching when the family actually requires convergence on an owning seam or shared lifecycle model.
- A lone bug can still have a closure gate if the family does not expand beyond one manifestation.
