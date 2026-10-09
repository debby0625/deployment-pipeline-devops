## Summary
This change fixes the AI release-notes logic to use the previous production tag when generating notes.

## Changes
- Changed the AI input from the latest 20 commits to the commit range between the previous production tag and the current commit.
- Intended to improve accuracy of generated release notes for production releases.

## Risks
- If the previous production tag is calculated incorrectly, the generated notes may be incomplete or misleading.
- Edge cases around release branching or tag ordering may still produce incorrect notes.
- Incorrect commit-range selection may produce misleading release notes. If the AI job fails, production deployment is also blocked because the production job depends on ai-release-notes.

## Human review checklist
- Verify the tag-selection logic resolves the correct previous production tag in the expected release flow.
- Check a recent production release to confirm the generated notes match the actual changes since the prior production tag.
- Confirm this does not affect non-production or prerelease note generation unexpectedly.
- Ensure the AI output is reviewed before publishing or approving release communications.

## Human Review and Corrections
Source: AI-generated release notes from workflow run #7.
Review timing: Post-deployment review.
1. Corrected the description of the previous implementation. It collected the latest 20 commits without selecting a production tag. The revised wording accurately describes the change to a production-tag-based commit range.
2. Corrected the deployment-risk statement. The production job depends on ai-release-notes, so an AI job failure can block production deployment.
Evidence: Run #7 collected one commit, 21ba4be, after the previous production tag prod-v1.0.6.
The original AI output remains available in the run #7 ai-release-notes artifact for comparison.
