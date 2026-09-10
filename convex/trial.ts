import { v } from "convex/values";
import { WorkflowManager, vWorkflowId, vResultValidator } from "@convex-dev/workflow";
import { components, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

export const trialWorkflow = new WorkflowManager(components.workflow, {
  workpoolOptions: {
    maxParallelism: 10,
    retryActionsByDefault: true,
    defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 1000, base: 2 },
  },
});

// The durable trial: decompose -> for each subclaim in parallel (gather pages,
// Prosecution and Defense file in parallel, Auditor scores, Cross-Examiner
// objects, Judge rules) -> synthesize the case verdict. Every step is recorded,
// so a crash or redeploy resumes from the last incomplete step.
export const trial = trialWorkflow.define({
  args: { caseId: v.id("cases") },
  handler: async (step, { caseId }): Promise<void> => {
    const subclaimIds: Id<"subclaims">[] = await step.runAction(
      internal.research.decompose,
      { caseId },
      { name: "clerk.decompose" },
    );

    await Promise.all(
      subclaimIds.map(async (subclaimId, i) => {
        const n = i + 1;
        const sourceIds: Id<"sources">[] = await step.runAction(
          internal.research.gather,
          { caseId, subclaimId },
          { name: `clerk.gather.${n}` },
        );
        await Promise.all([
          step.runAction(
            internal.research.argue,
            { caseId, subclaimId, sourceIds, side: "for" },
            { name: `prosecution.${n}` },
          ),
          step.runAction(
            internal.research.argue,
            { caseId, subclaimId, sourceIds, side: "against" },
            { name: `defense.${n}` },
          ),
        ]);
        await step.runAction(internal.research.audit, { caseId, subclaimId }, { name: `auditor.${n}` });
        await step.runAction(
          internal.research.crossExamine,
          { caseId, subclaimId },
          { name: `crossExaminer.${n}` },
        );
        await step.runAction(
          internal.research.judgeSubclaim,
          { caseId, subclaimId },
          { name: `judge.${n}` },
        );
      }),
    );

    await step.runAction(internal.research.synthesize, { caseId }, { name: "judge.synthesize" });
    await step.runAction(internal.mail.draftSubpoenas, { caseId }, { name: "clerk.subpoenas" });
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

// Partial retrial: only the appealed subclaim is re-argued, re-audited,
// re-examined and re-ruled; then the case verdict is re-synthesized.
export const appeal = trialWorkflow.define({
  args: { caseId: v.id("cases"), subclaimId: v.id("subclaims"), appealId: v.id("appeals") },
  handler: async (step, { caseId, subclaimId, appealId }): Promise<void> => {
    const a: Doc<"appeals"> | null = await step.runQuery(internal.cases.getAppeal, { appealId });
    const url = a?.url ?? null;
    let sourceIds: Id<"sources">[] = a?.sourceId ? [a.sourceId] : [];
    if (url && sourceIds.length === 0) {
      const sourceId: Id<"sources"> | null = await step.runAction(
        internal.research.scrapeUrl,
        { caseId, subclaimId, url },
        { name: "clerk.scrapeAppeal" },
      );
      if (sourceId) sourceIds = [sourceId];
    }
    if (sourceIds.length > 0) {
      await Promise.all([
        step.runAction(
          internal.research.argue,
          { caseId, subclaimId, sourceIds, side: "for", appealId },
          { name: "prosecution.appeal" },
        ),
        step.runAction(
          internal.research.argue,
          { caseId, subclaimId, sourceIds, side: "against", appealId },
          { name: "defense.appeal" },
        ),
      ]);
      await step.runAction(internal.research.audit, { caseId, subclaimId }, { name: "auditor.appeal" });
    }
    await step.runAction(
      internal.research.crossExamine,
      { caseId, subclaimId },
      { name: "crossExaminer.appeal" },
    );
    await step.runAction(
      internal.research.judgeSubclaim,
      { caseId, subclaimId, appealId },
      { name: "judge.appeal" },
    );
    await step.runAction(internal.research.synthesize, { caseId }, { name: "judge.resynthesize" });
    await step.runMutation(internal.cases.setAppealStatus, { appealId, status: "heard" });
  },
});

export const onAppealComplete = internalMutation({
  args: {
    workflowId: vWorkflowId,
    result: vResultValidator,
    context: v.object({ caseId: v.id("cases"), appealId: v.id("appeals") }),
  },
  handler: async (ctx, { result, context }) => {
    if (result.kind === "success") return;
    await ctx.runMutation(internal.cases.setAppealStatus, {
      appealId: context.appealId,
      status: "failed",
      error: result.kind === "failed" ? result.error : "Appeal was canceled",
    });
    // Put the case back into a decided state so the docket is not stuck.
    await ctx.runMutation(internal.cases.setStatus, { caseId: context.caseId, status: "decided" });
  },
});
