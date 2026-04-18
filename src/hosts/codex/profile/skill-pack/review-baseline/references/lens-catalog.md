# Built-in Lens Catalog

These lens definitions are part of the skill, not part of the baseline document.

Use them as the starting catalog when configuring a project baseline.

## Built-in lenses

- `authority`
  - Check which layer owns truth and whether any other layer behaves authoritatively.

- `lifecycle`
  - Check whether states and transitions form one coherent model across side paths.

- `recovery`
  - Check interruption, replay, fallback, and durability behavior.

- `soc`
  - Check separation of concerns and boundary hygiene.

- `contract`
  - Check whether types, APIs, specs, and invariants model the real behavior.

- `operator-truth`
  - Check whether user-facing review surfaces reflect reconciled truth instead of raw internals.

- `defect-family`
  - Check whether a finding is one manifestation of a broader root cause.

- `duplication`
  - Check for duplicate logic, split-brain paths, and drift between nearby implementations.

- `intent-drift`
  - Check whether a module or subsystem has mutated beyond its intended role.

- `docs-tests`
  - Check whether docs and tests reinforce or miss the actual contract.

## Configuration guidance

- Configure built-in lenses per surface.
- Use a small prioritized set per surface.
- Add custom lenses only when built-ins cannot capture the project-specific concern cleanly.
