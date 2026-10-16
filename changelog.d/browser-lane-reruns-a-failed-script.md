### Maintenance
- The parallel browser runner (`BROWSER_PARALLEL=1`) runs a failed script a second time. One that then
  passes is reported as flaky (marked `~` in the summary and listed under FLAKY, its first log kept)
  instead of failing the lane; one that fails twice still fails it.
