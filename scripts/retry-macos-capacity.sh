#!/usr/bin/env bash
# Re-runs the failed jobs of a workflow run while its macOS builds were cancelled for lack of a runner. GitHub's macOS
# runners are often short of capacity, and cancels a job when none picks it up. Any other failure is left alone, and so
# is the run of a pull request that has a newer run.
#
#   GH_REPO=owner/repo scripts/retry-macos-capacity.sh <run id> [retries]     (default: 3 retries)
#
# DRY_RUN=1 only reports what it would do.
set -euo pipefail

run="$1"
retries="${2:-3}"

current_attempt() { gh api "repos/$GH_REPO/actions/runs/$run" --jq .run_attempt; }

# A pull request's run is superseded once a newer push has started another one. It is not retried: the runs of a pull
# request share a concurrency group (tauri.yml), so its new attempt would cancel the newer run.
superseded() {
  local event branch workflow newest
  IFS=$'\t' read -r event branch workflow < <(gh api "repos/$GH_REPO/actions/runs/$run" \
    --jq '[.event, .head_branch, .workflow_id] | @tsv')
  [ "$event" = pull_request ] || return 1
  newest="$(gh api -X GET "repos/$GH_REPO/actions/workflows/$workflow/runs" -f event=pull_request -f branch="$branch" \
    -f per_page=1 --jq '.workflow_runs[0].id')"
  [ "$newest" != "$run" ]
}

lacked_a_runner() {
  local job messages
  for job in $(gh api --paginate "repos/$GH_REPO/actions/runs/$run/attempts/$1/jobs" \
    --jq '.jobs[] | select(.conclusion == "cancelled" and (.name | startswith("build (macos"))) | .id'); do
    # Not piped into grep: grep -q stops reading, which fails the pipeline under pipefail.
    messages="$(gh api "repos/$GH_REPO/check-runs/$job/annotations" --jq '.[].message')"
    if grep -q 'not acquired by Runner' <<<"$messages"; then
      return 0
    fi
  done
  return 1
}

for ((try = 1; try <= retries; try++)); do
  if superseded; then
    echo "Run $run was superseded by a newer push to its pull request: nothing to retry."
    exit 0
  fi
  attempt="$(current_attempt)"
  if ! lacked_a_runner "$attempt"; then
    echo "Attempt $attempt of run $run did not lack a macOS runner: nothing to retry."
    exit 0
  fi
  echo "Attempt $attempt of run $run lacked a macOS runner: retry $try of $retries."
  if [ -n "${DRY_RUN:-}" ]; then exit 0; fi
  gh run rerun "$run" --repo "$GH_REPO" --failed
  until [ "$(current_attempt)" != "$attempt" ] && [ "$(gh api "repos/$GH_REPO/actions/runs/$run" --jq .status)" = completed ]; do
    sleep 60
  done
done

attempt="$(current_attempt)"
if lacked_a_runner "$attempt"; then
  echo "Attempt $attempt of run $run still lacked a macOS runner after $retries retries." >&2
  exit 1
fi
echo "Attempt $attempt of run $run got its macOS runners."
