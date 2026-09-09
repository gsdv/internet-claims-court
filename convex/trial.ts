import { v } from "convex/values";
import { WorkflowManager, vWorkflowId, vResultValidator } from "@convex-dev/workflow";
import { components, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

export const trialWorkflow = new WorkflowManager(components.workflow, {
  workpoolOptions: {
    maxParallelism: 10,
    retryActionsByDefault: true,
    defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 1000, base: 2 },
  },
});

// The durable trial: decompose -> research each subclaim in parallel ->
// rule on each subclaim -> synthesize the case verdict. Each step is recorded,
// so a crash or redeploy resumes from the last incomplete step.
export const trial = trialWorkflow.define({
  args: { caseId: v.id("cases") },
  handler: async (step, { caseId }): Promise<void> => {
    const subclaimIds = await step.runAction(
      internal.research.decompose,
      { caseId },
      { name: "clerk.decompose" },
    );

    await Promise.all(
      subclaimIds.map((subclaimId, i) =>
        step
          .runAction(
            internal.research.research,
            { caseId, subclaimId },
            { name: `researcher.subclaim${i + 1}` },
          )
          .then(() =>
            step.runAction(
              internal.research.judgeSubclaim,
              { caseId, subclaimId },
              { name: `judge.subclaim${i + 1}` },
            ),
          ),
      ),
    );

    await step.runAction(internal.research.synthesize, { caseId }, { name: "judge.synthesize" });
  },
});

export const onTrialComplete = internalMutation({
  args: {
    workflowId: vWorkflowId,
    result: vResultValidator,
    context: v.object({ caseId: v.id("cases") }),
  },
  handler: async (ctx, { result, context }) => {
    if (result.kind === "success") return;
    await ctx.runMutation(internal.cases.setStatus, {
      caseId: context.caseId,
      status: "failed",
      error: result.kind === "failed" ? result.error : "Trial was canceled",
    });
  },
});
