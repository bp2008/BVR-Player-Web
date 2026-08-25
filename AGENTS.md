# Agent notes

## Documentation

**Keep `README.md` short.** It is the front page for people who just want to
play a `.bvr` file: what the app is, where to run it, requirements, controls,
and links onward. The average user does not care about implementation details or
design rationale, and those have a habit of creeping in.

Anything longer than a few lines of "how it works", "why it was built this way",
or in-depth behaviour of a feature belongs in [Development.md](Development.md),
not the README — including roadmap notes and the reasoning behind decisions that
were made and later changed. Format details go in
`BVR_File_Format_Spec.md`. When adding a feature, add its deep description to
`Development.md` and, at most, one table row or one sentence to `README.md`.
